# mail-mcp-sidecar

HTTP-Sidecar für den Mailzugriff des Hunger & Koch Agenten **„Der Koch“**.

Der Sidecar stellt [`mail-mcp`](https://github.com/tecnologicachile/mail-mcp) über [Supergateway](https://github.com/supercorp-ai/supergateway) als Streamable-HTTP-MCP zur Verfügung.

Ziel ist ein strikt eingeschränkter IMAP-Zugriff zur Organisation von Postfächern:

* E-Mails lesen
* E-Mails suchen
* Ordner auflisten
* E-Mails verschieben
* Flags wie gelesen/ungelesen ändern
* mehrere Mail-Accounts verwalten

Der Versand von E-Mails ist ausdrücklich nicht vorgesehen.

## Architektur

```text
Der Koch / Hermes
       │
       │ MCP / HTTP
       ▼
mail-mcp-sidecar
       │
       ├─ Supergateway
       │      │
       │      │ stdio
       │      ▼
       │   mail-mcp
       │
       ▼
      IMAP
       │
       ▼
Mailserver / STRATO
```

Der Hermes-Agent besitzt keine Mail-Passwörter.

Die IMAP-Zugangsdaten werden ausschließlich in den `mail-mcp-sidecar` eingebunden.

## Sicherheit

Der Sidecar ist bewusst für reine Postfachorganisation ausgelegt.

### Kein SMTP

SMTP-Schreibzugriffe werden im Container unabhängig von der externen Konfiguration deaktiviert:

```text
MAIL_SMTP_WRITE_ENABLED=false
```

Es sollten außerdem keinerlei SMTP-Zugangsdaten konfiguriert werden.

### Secrets

Passwörter sollten nicht direkt als Environment-Variablen übergeben werden.

Stattdessen unterstützt der Wrapper:

```text
MAIL_IMAP_OFFICE_PASS_FILE=/run/secrets/strato_office
```

Der Inhalt dieser Datei wird beim Containerstart ausschließlich innerhalb des Sidecars als:

```text
MAIL_IMAP_OFFICE_PASS
```

für `mail-mcp` bereitgestellt.

Die Secret-Datei darf nicht Bestandteil dieses Repositories sein.

Beispiel:

```text
/etc/koch-secrets/strato_office
```

wird read-only nach:

```text
/run/secrets/strato_office
```

gemountet.

## STRATO-Konfiguration

Für STRATO wird IMAPS verwendet:

```text
Host: imap.strato.de
Port: 993
TLS: true
```

Beispielkonfiguration:

```yaml
environment:
  MAIL_IMAP_WRITE_ENABLED: 'true'

  MAIL_IMAP_OFFICE_HOST: 'imap.strato.de'
  MAIL_IMAP_OFFICE_PORT: '993'
  MAIL_IMAP_OFFICE_SECURE: 'true'
  MAIL_IMAP_OFFICE_USER: 'office@example.com'
  MAIL_IMAP_OFFICE_PASS_FILE: '/run/secrets/strato_office'
```

## Mehrere Accounts

Weitere Accounts können über eine zusätzliche Account-ID ergänzt werden.

Beispiel:

```yaml
environment:
  MAIL_IMAP_OFFICE_HOST: 'imap.strato.de'
  MAIL_IMAP_OFFICE_PORT: '993'
  MAIL_IMAP_OFFICE_SECURE: 'true'
  MAIL_IMAP_OFFICE_USER: 'office@example.com'
  MAIL_IMAP_OFFICE_PASS_FILE: '/run/secrets/strato_office'

  MAIL_IMAP_INFO_HOST: 'imap.strato.de'
  MAIL_IMAP_INFO_PORT: '993'
  MAIL_IMAP_INFO_SECURE: 'true'
  MAIL_IMAP_INFO_USER: 'info@example.com'
  MAIL_IMAP_INFO_PASS_FILE: '/run/secrets/strato_info'
```

Die Account-IDs wären in diesem Beispiel:

```text
OFFICE
INFO
```

## MCP Endpoint

Supergateway stellt den stdio-MCP intern als Streamable HTTP bereit:

```text
http://mail-mcp:8000/mcp
```

Der Container sollte nicht über einen öffentlichen Port oder eine öffentliche Domain erreichbar gemacht werden.

Im Docker-Compose genügt:

```yaml
expose:
  - '8000'
```

Es sollte kein `ports:` Mapping eingerichtet werden.

## Hermes

Hermes verbindet sich intern mit:

```text
http://mail-mcp:8000/mcp
```

Auf Agent-Ebene sollte zusätzlich eine Tool-Whitelist verwendet werden.

Empfohlene Tools:

```text
list_all_accounts
imap_list_accounts
imap_list_mailboxes
imap_mailbox_status
imap_search_messages
imap_get_message
imap_get_attachment
imap_update_message_flags
imap_move_message
imap_bulk_move
```

Nicht freigeben:

```text
smtp_*
imap_delete_message
imap_bulk_delete
imap_search_and_delete
imap_create_mailbox
imap_delete_mailbox
imap_rename_mailbox
```

Damit bestehen mehrere Sicherheitsebenen:

1. Hermes sieht nur explizit freigegebene Tools.
2. SMTP-Schreibzugriffe sind im Sidecar deaktiviert.
3. Es werden keine SMTP-Credentials hinterlegt.
4. IMAP-Passwörter befinden sich nicht im Hermes-Container.
5. Der MCP-Port wird ausschließlich im internen Docker-Netzwerk exponiert.

## Build

Das Image kann direkt aus diesem Repository gebaut werden:

```bash
docker build -t mail-mcp-sidecar .
```

Der Dockerfile installiert:

* `mail-mcp`
* Supergateway
* die lokale Secret-Wrapper-Logik aus `entrypoint.sh`

## Lokaler Test

Beispiel:

```bash
docker build -t mail-mcp-sidecar .

docker run --rm \
  -p 127.0.0.1:8000:8000 \
  -e MAIL_IMAP_WRITE_ENABLED=true \
  -e MAIL_IMAP_OFFICE_HOST=imap.strato.de \
  -e MAIL_IMAP_OFFICE_PORT=993 \
  -e MAIL_IMAP_OFFICE_SECURE=true \
  -e MAIL_IMAP_OFFICE_USER=office@example.com \
  -e MAIL_IMAP_OFFICE_PASS_FILE=/run/secrets/strato_office \
  -v /etc/koch-secrets/strato_office:/run/secrets/strato_office:ro \
  mail-mcp-sidecar
```

Das Port-Mapping auf `127.0.0.1` ist ausschließlich für lokale Tests gedacht.

Im Produktivbetrieb sollte der MCP nur innerhalb des Docker-Netzwerks erreichbar sein.

## Repository

```text
https://github.com/Hunger-Koch/mail-mcp-sidecar
```
