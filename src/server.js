import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { callMailTool } from './upstream.js';
import {
  createSnapshot,
  getSnapshotChunk,
  isChunkProcessed,
  markChunkProcessed,
  releaseSnapshot,
  snapshotSummary,
} from './snapshots.js';

const PORT = Number.parseInt(process.env.PORT ?? '8000', 10);
const PHISHING_FLAG = '$ct_user_0001_21';

function toolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ status: 'failed', error: message }) }],
  };
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

function messageYear(message) {
  const date = new Date(message.date);
  const year = date.getUTCFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Cannot determine application year for ${message.message_id}`);
  }
  return year;
}

function hasFlag(message, flag) {
  return Array.isArray(message.flags) && message.flags.includes(flag);
}

function addMove(moves, destination, messageId) {
  if (!moves.has(destination)) moves.set(destination, []);
  moves.get(destination).push(messageId);
}

function registerTool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return toolResult(await handler(args));
    } catch (error) {
      console.error(`[${name}]`, error);
      return toolError(error);
    }
  });
}

function registerPassthroughTools(server) {
  registerTool(
    server,
    'imap_list_accounts',
    { description: 'List configured IMAP accounts.', inputSchema: {} },
    async () => callMailTool('imap_list_accounts', {}),
  );

  registerTool(
    server,
    'list_all_accounts',
    { description: 'List configured mail accounts.', inputSchema: {} },
    async () => callMailTool('list_all_accounts', {}),
  );

  registerTool(
    server,
    'imap_list_mailboxes',
    {
      description: 'List mailboxes for an IMAP account.',
      inputSchema: { account_id: z.string().optional() },
    },
    async (args) => callMailTool('imap_list_mailboxes', args),
  );

  registerTool(
    server,
    'imap_mailbox_status',
    {
      description: 'Read message counts for a mailbox.',
      inputSchema: {
        account_id: z.string().optional(),
        mailbox: z.string(),
      },
    },
    async (args) => callMailTool('imap_mailbox_status', args),
  );

  registerTool(
    server,
    'imap_search_messages',
    {
      description: 'Search messages directly. Prefer imap_create_snapshot for bulk inbox sorting.',
      inputSchema: {
        account_id: z.string().optional(),
        mailbox: z.string(),
        cursor: z.string().optional(),
        query: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        unread_only: z.boolean().optional(),
        last_days: z.number().int().min(1).max(365).optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        include_snippet: z.boolean().optional(),
        snippet_max_chars: z.number().int().min(50).max(500).optional(),
      },
    },
    async (args) => callMailTool('imap_search_messages', args),
  );

  registerTool(
    server,
    'imap_get_message',
    {
      description: 'Read one parsed message by stable message ID.',
      inputSchema: {
        account_id: z.string().optional(),
        message_id: z.string(),
        body_max_chars: z.number().int().min(100).max(20_000).optional(),
        include_headers: z.boolean().optional(),
        include_all_headers: z.boolean().optional(),
        include_html: z.boolean().optional(),
      },
    },
    async (args) => callMailTool('imap_get_message', args),
  );

  // Kept for non-sorter workflows. The sorter skill should use
  // imap_apply_snapshot_actions so category invariants are enforced here.
  registerTool(
    server,
    'imap_bulk_move',
    {
      description: 'Move multiple messages. For snapshot sorting use imap_apply_snapshot_actions instead.',
      inputSchema: {
        account_id: z.string().optional(),
        message_ids: z.array(z.string()).min(1).max(500),
        destination_mailbox: z.string(),
      },
    },
    async (args) => callMailTool('imap_bulk_move', args),
  );

  registerTool(
    server,
    'imap_bulk_update_flags',
    {
      description: 'Update flags on multiple messages. For snapshot sorting use imap_apply_snapshot_actions instead.',
      inputSchema: {
        account_id: z.string().optional(),
        message_ids: z.array(z.string()).min(1).max(500),
        add_flags: z.array(z.string()).min(1).max(20).optional(),
        remove_flags: z.array(z.string()).min(1).max(20).optional(),
      },
    },
    async (args) => callMailTool('imap_bulk_update_flags', args),
  );
}

function registerSnapshotTools(server) {
  registerTool(
    server,
    'imap_create_snapshot',
    {
      description: 'Create an immutable in-memory snapshot of the newest messages in a mailbox. Pagination and deduplication happen inside the sidecar, so the model does not need to retain cursor state.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        account_id: z.string().default('default'),
        mailbox: z.string().default('INBOX'),
        limit: z.number().int().min(1).max(500).default(100),
        chunk_size: z.number().int().min(1).max(50).default(20),
        include_snippet: z.boolean().default(true),
        snippet_max_chars: z.number().int().min(50).max(500).default(300),
      },
    },
    async ({ account_id, mailbox, limit, chunk_size, include_snippet, snippet_max_chars }) => {
      const messages = [];
      const seen = new Set();
      let cursor;
      let pageCount = 0;

      while (messages.length < limit) {
        pageCount += 1;
        if (pageCount > 20) throw new Error('Snapshot pagination exceeded 20 pages');

        const pageLimit = Math.min(50, limit - messages.length);
        const args = {
          account_id,
          mailbox,
          limit: pageLimit,
          include_snippet,
          ...(include_snippet ? { snippet_max_chars } : {}),
          ...(cursor ? { cursor } : {}),
        };

        const page = await callMailTool('imap_search_messages', args);
        const pageMessages = Array.isArray(page?.messages) ? page.messages : [];
        let added = 0;

        for (const rawMessage of pageMessages) {
          if (!rawMessage?.message_id || seen.has(rawMessage.message_id)) continue;
          seen.add(rawMessage.message_id);
          messages.push(normalizeMessage(rawMessage));
          added += 1;
          if (messages.length === limit) break;
        }

        if (messages.length >= limit || page?.has_more === false || !page?.next_cursor) break;
        if (added === 0) throw new Error('Snapshot pagination made no progress');

        // mail-mcp cursors are opaque and may keep the same string while
        // advancing server-side state. Always reuse the returned cursor.
        cursor = page.next_cursor;
      }

      const snapshot = createSnapshot({
        accountId: account_id,
        mailbox,
        messages,
        chunkSize: chunk_size,
      });

      return {
        status: 'ok',
        ...snapshotSummary(snapshot),
        upstream_pages: pageCount,
      };
    },
  );

  registerTool(
    server,
    'imap_get_snapshot_chunk',
    {
      description: 'Return one chunk from an existing immutable mail snapshot.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        snapshot_id: z.string().uuid(),
        chunk: z.number().int().min(1),
      },
    },
    async ({ snapshot_id, chunk }) => {
      const { snapshot, messages } = getSnapshotChunk(snapshot_id, chunk);
      return {
        status: 'ok',
        snapshot_id,
        chunk,
        chunk_count: snapshot.chunks.length,
        processed: snapshot.processedChunks.has(chunk),
        message_count: messages.length,
        messages,
      };
    },
  );

  registerTool(
    server,
    'imap_get_snapshot_message',
    {
      description: 'Read a bounded text body for one message that belongs to an unprocessed snapshot chunk. Use only when sender, subject, and snippet are insufficient for classification.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        snapshot_id: z.string().uuid(),
        chunk: z.number().int().min(1),
        message_id: z.string(),
        body_max_chars: z.number().int().min(100).max(5_000).default(3_000),
      },
    },
    async ({ snapshot_id, chunk, message_id, body_max_chars }) => {
      if (isChunkProcessed(snapshot_id, chunk)) {
        throw new Error(`Snapshot chunk ${chunk} has already been processed`);
      }

      const { snapshot, messages } = getSnapshotChunk(snapshot_id, chunk);
      const summary = messages.find((message) => message.message_id === message_id);
      if (!summary) {
        throw new Error(`Message ${message_id} is not part of snapshot chunk ${chunk}`);
      }

      const detail = await callMailTool('imap_get_message', {
        account_id: snapshot.accountId,
        message_id,
        body_max_chars,
        include_headers: true,
        include_all_headers: false,
        include_html: false,
        extract_attachment_text: false,
      });
      const message = detail?.message ?? detail;

      return {
        status: 'ok',
        snapshot_id,
        chunk,
        message: {
          message_id: summary.message_id,
          date: message?.date ?? summary.date,
          from: message?.from ?? summary.from,
          to: message?.to,
          cc: message?.cc,
          subject: message?.subject ?? summary.subject,
          flags: Array.isArray(message?.flags) ? message.flags : summary.flags,
          headers: message?.headers,
          body_text: message?.body_text,
        },
      };
    },
  );

  registerTool(
    server,
    'imap_apply_snapshot_actions',
    {
      description: 'Apply one classification per message in a snapshot chunk. The sidecar enforces destination and read-state invariants for the inbox sorter.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        snapshot_id: z.string().uuid(),
        chunk: z.number().int().min(1),
        actions: z.array(z.object({
          message_id: z.string(),
          category: z.enum([
            'phishing',
            'systemmails',
            'rechnungen',
            'bestellungen',
            'flyeralarm',
            'newsletter',
            'bewerbung',
            'untouched',
          ]),
        })).min(1).max(50),
      },
    },
    async ({ snapshot_id, chunk, actions }) => {
      if (isChunkProcessed(snapshot_id, chunk)) {
        throw new Error(`Snapshot chunk ${chunk} has already been processed`);
      }

      const { snapshot, messages } = getSnapshotChunk(snapshot_id, chunk);
      const messageById = new Map(messages.map((message) => [message.message_id, message]));
      const actionIds = new Set();

      if (actions.length !== messages.length) {
        throw new Error(`Expected exactly ${messages.length} actions for chunk ${chunk}, received ${actions.length}`);
      }

      for (const action of actions) {
        if (!messageById.has(action.message_id)) {
          throw new Error(`Message ${action.message_id} is not part of snapshot chunk ${chunk}`);
        }
        if (actionIds.has(action.message_id)) {
          throw new Error(`Duplicate action for ${action.message_id}`);
        }
        actionIds.add(action.message_id);
      }

      const needsMailboxList = actions.some((action) => action.category === 'bewerbung');
      let mailboxNames = null;
      if (needsMailboxList) {
        const mailboxData = await callMailTool('imap_list_mailboxes', { account_id: snapshot.accountId });
        mailboxNames = new Set((mailboxData?.mailboxes ?? []).map((mailbox) => mailbox.name));
      }

      const seenIds = [];
      const phishingFlagIds = [];
      const moves = new Map();
      const counts = {
        phishing: 0,
        systemmails: 0,
        rechnungen: 0,
        bestellungen: 0,
        flyeralarm: 0,
        newsletter: 0,
        bewerbung: 0,
        untouched: 0,
      };
      const unresolvedApplications = [];

      for (const action of actions) {
        const message = messageById.get(action.message_id);
        counts[action.category] += 1;

        switch (action.category) {
          case 'phishing':
            // Hard invariant: phishing remains in INBOX and keeps its read state.
            if (!hasFlag(message, PHISHING_FLAG)) phishingFlagIds.push(message.message_id);
            break;

          case 'systemmails':
            if (!hasFlag(message, '\\Seen')) seenIds.push(message.message_id);
            addMove(moves, 'Systemmails', message.message_id);
            break;

          case 'newsletter':
            if (!hasFlag(message, '\\Seen')) seenIds.push(message.message_id);
            addMove(moves, 'Newsletter &- Werbung', message.message_id);
            break;

          case 'rechnungen':
            // Preserve the existing read state.
            addMove(moves, 'Rechnungen', message.message_id);
            break;

          case 'bestellungen':
            // Preserve the existing read state.
            addMove(moves, 'Bestellungen', message.message_id);
            break;

          case 'flyeralarm':
            // Preserve the existing read state.
            addMove(moves, 'FLYERALARM', message.message_id);
            break;

          case 'bewerbung': {
            const year = messageYear(message);
            const destination = `Bewerbungen.Bewerbungen ${year}`;
            if (!mailboxNames?.has(destination)) {
              unresolvedApplications.push({ message_id: message.message_id, destination });
              break;
            }
            if (!hasFlag(message, '\\Seen')) seenIds.push(message.message_id);
            addMove(moves, destination, message.message_id);
            break;
          }

          case 'untouched':
            break;
        }
      }

      if (phishingFlagIds.length > 0) {
        await callMailTool('imap_bulk_update_flags', {
          account_id: snapshot.accountId,
          message_ids: phishingFlagIds,
          add_flags: [PHISHING_FLAG],
        });
      }

      if (seenIds.length > 0) {
        await callMailTool('imap_bulk_update_flags', {
          account_id: snapshot.accountId,
          message_ids: seenIds,
          add_flags: ['\\Seen'],
        });
      }

      const moved = {};
      for (const [destination, messageIds] of moves) {
        const moveResult = await callMailTool('imap_bulk_move', {
          account_id: snapshot.accountId,
          message_ids: messageIds,
          destination_mailbox: destination,
        });
        moved[destination] = moveResult?.moved_count ?? messageIds.length;
      }

      markChunkProcessed(snapshot_id, chunk);

      return {
        status: 'ok',
        snapshot_id,
        chunk,
        counts,
        moved,
        phishing_flagged: phishingFlagIds.length,
        seen_added: seenIds.length,
        unresolved_applications: unresolvedApplications,
      };
    },
  );

  registerTool(
    server,
    'imap_release_snapshot',
    {
      description: 'Release an in-memory snapshot before its TTL expires.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: { snapshot_id: z.string().uuid() },
    },
    async ({ snapshot_id }) => ({
      status: 'ok',
      snapshot_id,
      released: releaseSnapshot(snapshot_id),
    }),
  );
}

function createMcpServer() {
  const server = new McpServer({
    name: 'hunger-koch-mail-mcp-sidecar',
    version: '1.2.0',
  });

  registerSnapshotTools(server);
  registerPassthroughTools(server);
  return server;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const transports = new Map();

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (typeof sessionId === 'string' && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      });

      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({ error: 'Invalid or missing MCP session' });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[mcp-post]', error);
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
  }
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId !== 'string' || !transports.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing MCP session' });
    return;
  }
  await transports.get(sessionId).handleRequest(req, res);
}

app.get('/mcp', (req, res) => {
  handleSessionRequest(req, res).catch((error) => {
    console.error('[mcp-get]', error);
    if (!res.headersSent) res.status(500).end();
  });
});

app.delete('/mcp', (req, res) => {
  handleSessionRequest(req, res).catch((error) => {
    console.error('[mcp-delete]', error);
    if (!res.headersSent) res.status(500).end();
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hunger & Koch mail MCP proxy listening on :${PORT}/mcp`);
});