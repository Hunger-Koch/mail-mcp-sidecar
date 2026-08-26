#!/bin/sh
set -eu

# Unterstützt z. B.:
#
# MAIL_IMAP_OFFICE_PASS_FILE=/run/secrets/strato_office
#
# und erzeugt daraus intern:
#
# MAIL_IMAP_OFFICE_PASS=<Inhalt der Datei>
#
# Das Secret wird nur im mail-mcp Sidecar verfügbar gemacht.

for var_name in $(env | cut -d= -f1 | grep '^MAIL_IMAP_.*_PASS_FILE$' || true); do
    file_path="$(printenv "$var_name")"

    if [ ! -f "$file_path" ]; then
        echo "Secret file for $var_name not found." >&2
        exit 1
    fi

    target_var="${var_name%_FILE}"
    secret_value="$(cat "$file_path")"

    export "$target_var=$secret_value"

    unset "$var_name"
done

# SMTP bleibt unabhängig von der übrigen Konfiguration deaktiviert.
export MAIL_SMTP_WRITE_ENABLED=false

exec supergateway \
    --stdio "/usr/local/bin/mail-mcp" \
    --outputTransport streamableHttp \
    --stateful \
    --sessionTimeout 300000 \
    --port 8000 \
    --streamableHttpPath /mcp
