#!/bin/sh
set -eu

# Supports variables such as:
# MAIL_IMAP_OFFICE_PASS_FILE=/run/secrets/strato_office
# and exposes the file contents only inside this sidecar process tree.
# Keep the *_PASS_FILE path available to the long-lived Node process so the
# optional IMAP IDLE watcher can read the mounted secret without retaining the
# password itself in process.env after the upstream mail-mcp child starts.

for var_name in $(env | cut -d= -f1 | grep '^MAIL_IMAP_.*_PASS_FILE$' || true); do
    file_path="$(printenv "$var_name")"

    if [ ! -f "$file_path" ]; then
        echo "Secret file for $var_name not found." >&2
        exit 1
    fi

    target_var="${var_name%_FILE}"
    secret_value="$(cat "$file_path")"

    export "$target_var=$secret_value"
done

# SMTP remains disabled regardless of external configuration.
export MAIL_SMTP_WRITE_ENABLED=false

# The Node MCP proxy spawns /usr/local/bin/mail-mcp directly over stdio.
# No second HTTP listener, database, Redis instance, or additional service exists.
exec node /app/src/server.js
