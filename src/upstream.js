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
  // long-lived Node process environment immediately afterwards.
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
  const result = await client.callTool({ name, arguments: args });
  if (result?.isError) {
    const message = result?.content?.find?.((item) => item?.type === 'text')?.text ?? `${name} failed`;
    throw new Error(message);
  }

  const data = parseToolResult(result);
  assertComplete(name, data);
  return data;
}

// Fail startup if the native mail-mcp process cannot be spawned/initialized,
// and scrub IMAP password variables before the HTTP proxy starts listening.
await getUpstreamClient();
