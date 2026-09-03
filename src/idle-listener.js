import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ImapFlow } from 'imapflow';
import { createSnapshot, releaseSnapshot, snapshotSummary } from './snapshots.js';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null) return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function accountPrefix(accountId) {
  const normalized = accountId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `MAIL_IMAP_${normalized}_`;
}

async function readSecret({ envName, fileEnvName }) {
  const filePath = process.env[fileEnvName];
  if (filePath) return (await readFile(filePath, 'utf8')).trim();
  const value = process.env[envName];
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMessage(message) {
  return {
    message_id: message.message_id,
    mailbox: message.mailbox,
    uidvalidity: message.uidvalidity,
    uid: message.uid,
    date: message.date,
    from: message.from,
    subject: message.subject,
    flags: Array.isArray(message.flags) ? message.flags : [],
    snippet: message.snippet,
  };
}

function uidKey(uidValidity, uid) {
  return `${uidValidity}:${uid}`;
}

async function collectSummaries(callMailTool, config, targets) {
  const wanted = new Set(targets.map(({ uidValidity, uid }) => uidKey(uidValidity, uid)));
  const found = new Map();
  let cursor;

  for (let pageCount = 0; pageCount < config.maxSearchPages && found.size < wanted.size; pageCount += 1) {
    const page = await callMailTool('imap_search_messages', {
      account_id: config.accountId,
      mailbox: config.mailbox,
      limit: 50,
      include_snippet: true,
      snippet_max_chars: config.snippetMaxChars,
      ...(cursor ? { cursor } : {}),
    });

    const messages = Array.isArray(page?.messages) ? page.messages : [];
    for (const rawMessage of messages) {
      const key = uidKey(Number(rawMessage?.uidvalidity), Number(rawMessage?.uid));
      if (wanted.has(key) && !found.has(key)) found.set(key, normalizeMessage(rawMessage));
    }

    if (found.size === wanted.size || page?.has_more === false || !page?.next_cursor) break;
    cursor = page.next_cursor;
  }

  return targets
    .map(({ uidValidity, uid }) => found.get(uidKey(uidValidity, uid)))
    .filter(Boolean);
}

async function postWebhook(config, payload) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', config.webhookSecret).update(body).digest('hex')}`;
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'mail_batch',
          'x-github-delivery': payload.event_id,
          'x-hub-signature-256': signature,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Hermes webhook returned HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 2_000);
    }
  }

  throw lastError ?? new Error('Hermes webhook delivery failed');
}

async function loadConfig() {
  if (!envBool('MAIL_IDLE_ENABLED', false)) return null;

  const accountId = process.env.MAIL_IDLE_ACCOUNT_ID?.trim() || 'hallo';
  const mailbox = process.env.MAIL_IDLE_MAILBOX?.trim() || 'INBOX';
  const prefix = accountPrefix(accountId);
  const host = process.env[`${prefix}HOST`]?.trim();
  const user = process.env[`${prefix}USER`]?.trim();
  const password = await readSecret({
    envName: `${prefix}PASS`,
    fileEnvName: `${prefix}PASS_FILE`,
  });
  const webhookUrl = process.env.MAIL_IDLE_HERMES_WEBHOOK_URL?.trim();
  const webhookSecret = await readSecret({
    envName: 'MAIL_IDLE_HERMES_WEBHOOK_SECRET',
    fileEnvName: 'MAIL_IDLE_HERMES_WEBHOOK_SECRET_FILE',
  });

  if (!host || !user || !password) {
    throw new Error(`IMAP IDLE is enabled but ${prefix}{HOST,USER,PASS/PASS_FILE} is incomplete`);
  }
  if (!webhookUrl || !webhookSecret) {
    throw new Error('IMAP IDLE is enabled but Hermes webhook URL/secret is missing');
  }

  return {
    accountId,
    mailbox,
    host,
    user,
    password,
    port: envInt(`${prefix}PORT`, 993, 1, 65535),
    secure: envBool(`${prefix}SECURE`, true),
    debounceMs: envInt('MAIL_IDLE_DEBOUNCE_SECONDS', 120, 30, 900) * 1000,
    heartbeatMs: envInt('MAIL_IDLE_HEARTBEAT_SECONDS', 30, 10, 120) * 1000,
    reconnectMaxMs: envInt('MAIL_IDLE_RECONNECT_MAX_SECONDS', 60, 5, 600) * 1000,
    chunkSize: envInt('MAIL_IDLE_CHUNK_SIZE', 20, 1, 50),
    snippetMaxChars: envInt('MAIL_IDLE_SNIPPET_MAX_CHARS', 300, 50, 500),
    maxSearchPages: envInt('MAIL_IDLE_MAX_SEARCH_PAGES', 20, 1, 100),
    webhookUrl,
    webhookSecret,
  };
}

export async function startIdleListener({ callMailTool }) {
  const config = await loadConfig();
  if (!config) {
    console.log('[imap-idle] disabled');
    return;
  }

  let expectedUidValidity = null;
  let lastUid = null;
  let activeClient = null;
  let reconnectDelayMs = 1_000;
  const pending = new Map();
  let debounceTimer = null;
  let flushChain = Promise.resolve();
  let scanChain = Promise.resolve();

  function scheduleFlush() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      flushChain = flushChain.then(flushPending, flushPending);
    }, config.debounceMs);
  }

  async function flushPending() {
    if (pending.size === 0) return;

    const targets = [...pending.values()].sort((a, b) => a.uid - b.uid);
    for (const target of targets) pending.delete(uidKey(target.uidValidity, target.uid));

    let snapshot;
    try {
      const messages = await collectSummaries(callMailTool, config, targets);
      if (messages.length === 0) {
        console.warn(`[imap-idle] ${targets.length} detected message(s) no longer present in ${config.mailbox}; nothing to trigger`);
        return;
      }

      const missing = targets.length - messages.length;
      if (missing > 0) {
        console.warn(`[imap-idle] ${missing}/${targets.length} detected message(s) were not found in ${config.mailbox}`);
      }

      snapshot = createSnapshot({
        accountId: config.accountId,
        mailbox: config.mailbox,
        messages,
        chunkSize: config.chunkSize,
      });
      const summary = snapshotSummary(snapshot);
      const payload = {
        event_type: 'mail_batch',
        event_id: randomUUID(),
        account_id: config.accountId,
        mailbox: config.mailbox,
        snapshot_id: summary.snapshot_id,
        message_count: summary.message_count,
        chunk_count: summary.chunk_count,
        created_at: new Date().toISOString(),
      };

      await postWebhook(config, payload);
      console.log(`[imap-idle] triggered Hermes for snapshot ${summary.snapshot_id} (${summary.message_count} message(s))`);
    } catch (error) {
      if (snapshot) releaseSnapshot(snapshot.id);
      for (const target of targets) pending.set(uidKey(target.uidValidity, target.uid), target);
      console.error('[imap-idle] batch flush failed; retrying after debounce', error);
      scheduleFlush();
    }
  }

  async function scanForNewUids(client) {
    if (!Number.isInteger(lastUid) || !Number.isInteger(expectedUidValidity)) return;

    const startUid = lastUid + 1;
    const discovered = new Set();

    // UID SEARCH on some IMAP4rev2 servers can yield an empty parsed result even
    // when the UID exists. UID FETCH returns the authoritative UID directly and
    // does not mark the message as read. Filtering is required because an IMAP
    // range like "N:*" may include the current highest UID when N is above it.
    for await (const message of client.fetch(`${startUid}:*`, { uid: true }, { uid: true })) {
      const uid = Number(message?.uid);
      if (Number.isInteger(uid) && uid >= startUid) discovered.add(uid);
    }

    const fresh = [...discovered].sort((a, b) => a - b);
    if (fresh.length === 0) return;

    for (const uid of fresh) {
      pending.set(uidKey(expectedUidValidity, uid), { uidValidity: expectedUidValidity, uid });
      lastUid = Math.max(lastUid, uid);
    }

    console.log(`[imap-idle] detected ${fresh.length} new message(s); pending=${pending.size}`);
    scheduleFlush();
  }

  function queueScan(client) {
    scanChain = scanChain
      .then(() => scanForNewUids(client))
      .catch((error) => console.error('[imap-idle] UID scan failed', error));
    return scanChain;
  }

  async function connectOnce() {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      logger: false,
      disableAutoIdle: true,
      maxIdleTime: 4 * 60 * 1000,
    });
    activeClient = client;

    await client.connect();
    const opened = await client.mailboxOpen(config.mailbox, { readOnly: true });
    const uidValidity = Number(opened.uidValidity);
    const highestExistingUid = Math.max(0, Number(opened.uidNext ?? 1) - 1);

    if (!Number.isInteger(uidValidity)) throw new Error('Mailbox did not report a valid UIDVALIDITY');

    if (expectedUidValidity == null) {
      expectedUidValidity = uidValidity;
      lastUid = highestExistingUid;
      console.log(`[imap-idle] watching ${config.accountId}/${config.mailbox}; baseline UID=${lastUid}; debounce=${config.debounceMs / 1000}s; heartbeat=${config.heartbeatMs / 1000}s`);
    } else if (expectedUidValidity !== uidValidity) {
      console.warn(`[imap-idle] UIDVALIDITY changed ${expectedUidValidity} -> ${uidValidity}; resetting listener baseline`);
      expectedUidValidity = uidValidity;
      lastUid = highestExistingUid;
      pending.clear();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
    } else if (highestExistingUid > lastUid) {
      await queueScan(client);
    }

    client.on('exists', () => {
      void queueScan(client);
    });
    client.on('error', (error) => console.error('[imap-idle] connection error', error));

    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || !client.usable || !client.mailbox) return;
      heartbeatRunning = true;
      void queueScan(client).finally(() => {
        heartbeatRunning = false;
      });
    }, config.heartbeatMs);

    try {
      while (client.usable && client.mailbox) {
        await client.idle();
      }
    } finally {
      clearInterval(heartbeat);
      activeClient = null;
    }
  }

  while (true) {
    try {
      await connectOnce();
      reconnectDelayMs = 1_000;
    } catch (error) {
      console.error('[imap-idle] listener connection failed', error);
      try {
        await activeClient?.logout();
      } catch {
        // Best-effort cleanup only.
      }
      activeClient = null;
    }

    await sleep(reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, config.reconnectMaxMs);
  }
}
