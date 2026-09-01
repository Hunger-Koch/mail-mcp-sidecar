# mail-mcp-sidecar

HTTP sidecar for the Hunger & Koch mail agent **Der Koch**.

The container uses [`tecnologicachile/mail-mcp`](https://github.com/tecnologicachile/mail-mcp) for IMAP access and adds a small MCP proxy in front of it. The proxy keeps short-lived mailbox snapshots in RAM so an LLM does not need to retain IMAP cursor state or a complete batch in conversation context.

There is **no PostgreSQL, Redis, database, Supergateway, or additional Docker service**. Snapshot state exists only in memory inside the existing `mail-mcp-sidecar` container and expires automatically.

## Architecture

```text
Der Koch / Hermes
       |
       | MCP / HTTP :8000
       v
H&K snapshot proxy (Node.js)
       |
       | MCP / stdio
       v
mail-mcp 0.4.9 child process
       |
       v
IMAP / STRATO
```

Only the Node proxy listens on a TCP port. `mail-mcp` is spawned directly as a local stdio child process and has no HTTP listener of its own.

## Batch snapshot flow

The caller decides how many messages belong to a batch. The sidecar only enforces its API bounds; it does not define the operational batch size.

1. `imap_create_snapshot` captures the requested newest messages and handles pagination/deduplication internally.
2. `imap_get_snapshot_chunk` returns one bounded chunk at a time.
3. The model classifies from sender, subject and snippet.
4. Only when those fields are insufficient, `imap_get_snapshot_message` returns a bounded text body for one message in the current chunk.
5. `imap_apply_snapshot_actions` validates one classification per message and performs the allowed mutations.
6. `imap_release_snapshot` frees the snapshot early; otherwise the TTL removes it automatically.

## Snapshot tools

### `imap_create_snapshot`

Example input:

```json
{
  "account_id": "hallo",
  "mailbox": "INBOX",
  "limit": 80,
  "chunk_size": 20,
  "include_snippet": true,
  "snippet_max_chars": 300
}
```

`limit` is supplied by the caller/job. The proxy calls upstream `imap_search_messages` itself using pages of up to 50 messages, reuses the opaque cursor and deduplicates by stable `message_id`.

The response contains only snapshot metadata such as `snapshot_id`, `message_count` and `chunk_count`.

### `imap_get_snapshot_chunk`

```json
{
  "snapshot_id": "...",
  "chunk": 1
}
```

Returns only the messages for that chunk with bounded fields:

- `message_id`
- `mailbox`
- `uidvalidity`
- `uid`
- `date`
- `from`
- `subject`
- `flags`
- `snippet`

### `imap_get_snapshot_message`

Use only when the summary fields are not sufficient to classify one message.

```json
{
  "snapshot_id": "...",
  "chunk": 1,
  "message_id": "imap:hallo:INBOX:...",
  "body_max_chars": 3000
}
```

Guardrails:

- the message must belong to the specified snapshot chunk
- the chunk must still be unprocessed
- text body only; no HTML or attachment extraction
- curated headers only
- default body limit: 3,000 characters
- hard body limit: 5,000 characters

This keeps body loading selective instead of putting every message body into the LLM context.

### `imap_apply_snapshot_actions`

The model sends exactly one category for every message in the chunk:

```json
{
  "snapshot_id": "...",
  "chunk": 1,
  "actions": [
    {
      "message_id": "imap:hallo:INBOX:...",
      "category": "rechnungen"
    }
  ]
}
```

Allowed categories:

- `phishing`
- `systemmails`
- `rechnungen`
- `bestellungen`
- `flyeralarm`
- `newsletter`
- `bewerbung`
- `untouched`

The proxy enforces the inbox-sorter mutation rules itself:

| Category | Action |
| --- | --- |
| `phishing` | Keep in INBOX, preserve read state, add `$ct_user_0001_21` if missing |
| `systemmails` | Add `\\Seen` if needed, move to `Systemmails` |
| `newsletter` | Add `\\Seen` if needed, move to `Newsletter &- Werbung` |
| `rechnungen` | Move to `Rechnungen`, preserve read state |
| `bestellungen` | Move to `Bestellungen`, preserve read state |
| `flyeralarm` | Move to `FLYERALARM`, preserve read state |
| `bewerbung` | Derive year from message date and move only to exact `Bewerbungen.Bewerbungen YYYY`; if missing, leave unchanged |
| `untouched` | No mutation |

A chunk can only be applied once. Actions must cover exactly the messages in that snapshot chunk and may not reference arbitrary mail IDs.

### `imap_release_snapshot`

Deletes a snapshot from RAM immediately. The default automatic TTL is 30 minutes.

```text
SNAPSHOT_TTL_SECONDS=1800
```

## Pass-through tools

For other mail workflows the proxy currently exposes a small set of upstream tools:

- `list_all_accounts`
- `imap_list_accounts`
- `imap_list_mailboxes`
- `imap_mailbox_status`
- `imap_search_messages`
- `imap_get_message`
- `imap_bulk_move`
- `imap_bulk_update_flags`

For batch sorting, prefer the snapshot tools so snapshot scope and mutation invariants cannot be bypassed accidentally.

SMTP, delete operations, mailbox creation/deletion/rename, and raw-message tools are not exposed by the proxy.

## Security

### No SMTP

SMTP writes are disabled independently of external configuration:

```text
MAIL_SMTP_WRITE_ENABLED=false
```

Do not configure SMTP credentials.

### IMAP secrets

Passwords should be mounted as files:

```text
MAIL_IMAP_HALLO_PASS_FILE=/run/secrets/strato_hallo
```

The entrypoint loads the secret into the sidecar environment. During startup the Node proxy immediately spawns the native `mail-mcp` stdio child with those credentials, then removes `MAIL_IMAP_*_PASS` variables from its own long-lived process environment. Hermes never receives the password.

## Docker / Coolify

No second service is required. Continue deploying this repository as the existing `mail-mcp` service.

Only expose port 8000 inside the Docker network:

```yaml
expose:
  - '8000'
```

Hermes continues to use:

```text
http://mail-mcp:8000/mcp
```

Health endpoint:

```text
http://mail-mcp:8000/healthz
```

## Generic sorter flow

```text
imap_create_snapshot(limit=<job batch size>, chunk_size<=20)

for chunk 1..chunk_count:
    imap_get_snapshot_chunk(snapshot_id, chunk)
    classify from summary fields
    for genuinely ambiguous messages only:
        imap_get_snapshot_message(snapshot_id, chunk, message_id)
    imap_apply_snapshot_actions(snapshot_id, chunk, actions)

imap_release_snapshot(snapshot_id)
```

No cursor handling, snapshot merging, Python parsing, file cache reads, or mailbox read-back verification is required in the agent.