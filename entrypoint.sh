#!/bin/sh
set -eu

# Supports variables such as:
# MAIL_IMAP_OFFICE_PASS_FILE=/run/secrets/strato_office
# and exposes the file contents to the upstream mail-mcp process only.

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

# SMTP remains disabled regardless of external configuration.
export MAIL_SMTP_WRITE_ENABLED=false

# mail-mcp remains the IMAP implementation, but it is now only exposed on
# localhost inside this container. Hermes talks exclusively to the proxy on 8000.
supergateway \
    --stdio "/usr/local/bin/mail-mcp" \
    --outputTransport streamableHttp \
    --stateful \
    --sessionTimeout 300000 \
    --port 8001 \
    --streamableHttpPath /mcp &

upstream_pid=$!

cleanup() {
    kill "$upstream_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# The upstream child has already inherited the IMAP credentials. Remove password
# values from the proxy process environment before starting Node.
for var_name in $(env | cut -d= -f1 | grep '^MAIL_IMAP_.*_PASS$' || true); do
    unset "$var_name"
done

# Wait until the local HTTP listener is reachable. Any HTTP status is sufficient;
# the MCP endpoint itself requires a protocol request/session.
attempt=0
until curl -sS -o /dev/null http://127.0.0.1:8001/mcp; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 50 ]; then
        echo "mail-mcp upstream did not become reachable." >&2
        exit 1
    fi
    sleep 0.1
done

node /app/src/server.js &
proxy_pid=$!

trap 'kill "$proxy_pid" "$upstream_pid" 2>/dev/null || true' EXIT INT TERM
wait "$proxy_pid"
