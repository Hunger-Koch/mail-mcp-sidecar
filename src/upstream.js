import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const upstreamUrl = process.env.MAIL_MCP_UPSTREAM_URL ?? 'http://127.0.0.1:8001/mcp';
let clientPromise;

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

async function connect() {
  const client = new Client({ name: 'hk-mail-snapshot-proxy', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(upstreamUrl));
  await client.connect(transport);
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

export async function callMailTool(name, args = {}) {
  const client = await getUpstreamClient();
  const result = await client.callTool({ name, arguments: args });
  if (result?.isError) {
    const message = result?.content?.find?.((item) => item?.type === 'text')?.text ?? `${name} failed`;
    throw new Error(message);
  }
  return parseToolResult(result);
}
