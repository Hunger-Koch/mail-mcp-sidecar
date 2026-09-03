# Optional IMAP IDLE event sorting

The existing MCP proxy and all existing tools continue to work unchanged. IMAP IDLE is an **opt-in additive listener** that runs inside the same `mail-mcp-sidecar` process and reuses the existing in-memory snapshot store.

When enabled, the listener:

1. opens a second read-only-style IMAP connection for the configured account/mailbox,
2. establishes the current UID/UIDVALIDITY as its startup baseline (existing mail is not emitted),
3. watches for new messages using IMAP IDLE,
4. collects new UIDs and applies a trailing debounce (120 seconds by default),
5. resolves only those UIDs to the existing bounded message summaries,
6. creates a normal RAM snapshot using the existing snapshot store,
7. POSTs the snapshot metadata to a Hermes webhook using HMAC-SHA256.

The webhook-triggered Hermes run can then process the supplied `snapshot_id` with the existing tools:

- `imap_get_snapshot_chunk`
- `imap_get_snapshot_message`
- `imap_apply_snapshot_actions`
- `imap_release_snapshot`

The normal `imap_create_snapshot` flow remains available for manual sorting and the daily recovery cron.

## Configuration

Nothing changes unless `MAIL_IDLE_ENABLED=true` is set.

Recommended Coolify/Docker environment for the existing `mail-mcp` service:

```yaml
environment:
  MAIL_IDLE_ENABLED: 'true'
  MAIL_IDLE_ACCOUNT_ID: hallo
  MAIL_IDLE_MAILBOX: INBOX
  MAIL_IDLE_DEBOUNCE_SECONDS: '120'
  MAIL_IDLE_HERMES_WEBHOOK_URL: 'http://hermes:8644/webhooks/mail-sorter'
  MAIL_IDLE_HERMES_WEBHOOK_SECRET_FILE: /run/secrets/hermes_mail_sorter_webhook
```

The account-specific IMAP settings are reused from the existing variables, for example:

```text
MAIL_IMAP_HALLO_HOST=imap.strato.de
MAIL_IMAP_HALLO_PORT=993
MAIL_IMAP_HALLO_SECURE=true
MAIL_IMAP_HALLO_USER=...
MAIL_IMAP_HALLO_PASS_FILE=/run/secrets/strato_hallo
```

The existing entrypoint still loads the password for the native `mail-mcp` child. It now also keeps the non-secret `*_PASS_FILE` path in the Node process environment so the IDLE connection can read the mounted secret directly after the plaintext `*_PASS` value has been scrubbed from `process.env`.

Optional tuning variables:

```text
MAIL_IDLE_DEBOUNCE_SECONDS=120       # 30..900
MAIL_IDLE_RECONNECT_MAX_SECONDS=60   # exponential reconnect ceiling
MAIL_IDLE_CHUNK_SIZE=20              # 1..50
MAIL_IDLE_SNIPPET_MAX_CHARS=300      # 50..500
MAIL_IDLE_MAX_SEARCH_PAGES=20        # 1..100, pages of 50
```

## Hermes webhook

Hermes' webhook adapter should expose a route named `mail-sorter`. The sidecar sends:

```json
{
  "event_type": "mail_batch",
  "event_id": "...",
  "account_id": "hallo",
  "mailbox": "INBOX",
  "snapshot_id": "...",
  "message_count": 4,
  "chunk_count": 1,
  "created_at": "..."
}
```

Headers include:

```text
X-GitHub-Event: mail_batch
X-GitHub-Delivery: <event_id>
X-Hub-Signature-256: sha256=<HMAC-SHA256>
```

Using a stable delivery ID lets Hermes deduplicate retries. The sidecar retries failed webhook POSTs three times with the same delivery ID.

## Failure / recovery behavior

- IMAP disconnects are retried with exponential backoff.
- During an in-process reconnect, the listener retains its last UID and catches up messages that arrived while disconnected, provided UIDVALIDITY did not change.
- On UIDVALIDITY change, the listener resets its baseline instead of guessing.
- If a batch cannot be resolved or delivered, its UIDs are returned to the RAM queue and retried after the debounce period.
- All listener state is RAM-only. A container restart intentionally loses the listener high-water mark; the existing daily snapshot cron remains the recovery path for messages that arrived during downtime/restarts.
- Existing MCP tools, direct mail workflows, and the daily snapshot cron are unaffected.
