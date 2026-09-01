FROM node:22-bookworm-slim

ARG MAIL_MCP_VERSION=0.4.9

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -LsSf \
    "https://github.com/tecnologicachile/mail-mcp/releases/download/v${MAIL_MCP_VERSION}/mail-mcp-installer.sh" \
    | sh \
    && cp /root/.cargo/bin/mail-mcp /usr/local/bin/mail-mcp \
    && chmod 0755 /usr/local/bin/mail-mcp

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev \
    && npm cache clean --force

COPY src ./src
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod 0755 /usr/local/bin/entrypoint.sh

ENV MAIL_IMAP_WRITE_ENABLED=true
ENV MAIL_SMTP_WRITE_ENABLED=false
ENV SNAPSHOT_TTL_SECONDS=1800
ENV PORT=8000

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
