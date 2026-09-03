import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let clientPromise;
let transport;

function childEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
  );
}

function parseToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent.data ?? result.structuredContent;
  }

  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (!text) return result;

  try {
    const parsed = JSON.parse(text);
    return parsed?.data ?? parsed;
  } catch {
    throw new Error(`Upstream tool returned non-JSON text: ${text.slice(0, 200)}`);
  }
}

function assertComplete(name, data) {
  if (!data || typeof data !== 'object') return;
  if (data.status !== 'failed' && data.status !== 'partial') return;

  const issueText = Array.isArray(data.issues)
    ? data.issues.map((issue) => issue?.message ?? issue?.detail ?? JSON.stringify(issue)).join('; ')
    : '';

  throw new Error(`${name} returned ${data.status}${issueText ? `: ${issueText}` : ''}`);
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)));
}

function htmlToText(html, maxChars) {
  if (typeof html !== 'string' || html.length === 0) return null;

  const text = decodeHtmlEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(?:p|div|section|article|header|footer|main|aside|h[1-6]|li|tr|table|blockquote)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) return null;
  return text.slice(0, maxChars);
}

async function invokeTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result?.isError) {
    const message = result?.content?.find?.((item) => item?.type === 'text')?.text ?? `${name} failed`;
    throw new Error(message);
  }

  const data = parseToolResult(result);
  assertComplete(name, data);
  return data;
}

function withHtmlBodyFallback(data, fallbackText) {
  if (!fallbackText) return data;

  if (data?.message && typeof data.message === 'object') {
    const { body_html: _bodyHtml, ...message } = data.message;
    return {
      ...data,
      message: {
        ...message,
        body_text: fallbackText,
      },
    };
  }

  if (data && typeof data === 'object') {
    const { body_html: _bodyHtml, ...rest } = data;
    return {
      ...rest,
      body_text: fallbackText,
    };
  }

  return data;
}

async function connect() {
  const client = new Client({ name: 'hk-mail-snapshot-proxy', version: '1.0.0' });
  transport = new StdioClientTransport({
    command: '/usr/local/bin/mail-mcp',
    args: [],
    env: childEnvironment(),
    stderr: 'inherit',
  });

  await client.connect(transport);

  // mail-mcp has inherited its credentials. Remove password values from the
  // long-lived Node process environment immediately afterwards. *_PASS_FILE
  // paths remain available so the optional IDLE watcher can read the mounted
  // secret directly without re-exposing the password through process.env.
  for (const key of Object.keys(process.env)) {
    if (/^MAIL_IMAP_.*_PASS$/.test(key)) delete process.env[key];
  }

  return client;
}

export async function getUpstreamClient() {
  if (!clientPromise) {
    clientPromise = connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
}

export async function closeUpstreamClient() {
  if (transport) await transport.close();
  transport = undefined;
  clientPromise = undefined;
}

export async function callMailTool(name, args = {}) {
  const client = await getUpstreamClient();
  const data = await invokeTool(client, name, args);

  // mail-mcp may return no body_text for HTML-only messages. For callers that
  // explicitly requested no HTML, retry once with sanitized HTML enabled,
  // convert it locally to bounded plain text, and never expose the HTML.
  if (name === 'imap_get_message' && args.include_html === false) {
    const message = data?.message ?? data;
    if (!message?.body_text) {
      const retryData = await invokeTool(client, name, { ...args, include_html: true });
      const retryMessage = retryData?.message ?? retryData;
      const maxChars = Number.isInteger(args.body_max_chars) ? args.body_max_chars : 20_000;
      const fallbackText = htmlToText(retryMessage?.body_html, maxChars);
      if (fallbackText) return withHtmlBodyFallback(retryData, fallbackText);
    }
  }

  return data;
}

// Fail startup if the native mail-mcp process cannot be spawned/initialized,
// and scrub IMAP password variables before the HTTP proxy starts listening.
await getUpstreamClient();

// The listener is strictly opt-in. Importing it after the upstream child is
// ready keeps all existing MCP behavior unchanged when MAIL_IDLE_ENABLED is
// unset/false, while still sharing this process' in-memory snapshot store.
const { startIdleListener } = await import('./idle-listener.js');
startIdleListener({ callMailTool }).catch((error) => {
  console.error('[imap-idle] listener stopped unexpectedly', error);
});
