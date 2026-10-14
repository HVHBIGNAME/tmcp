import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

export async function toolClient(t: TestContext, url: string, headers: Record<string, string>) {
  const client = new Client({ name: 'tool-audit', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }),
  );
  t.after(() => client.close());
  await client.listTools();
  return client;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  error = false,
) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  assert.equal(
    Boolean(result.isError),
    error,
    `${name}: ${result.content
      .filter((x) => x.type === 'text')
      .map((x) => x.text)
      .join('\n')}`,
  );
  return result;
}

export async function output(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  assert(result.structuredContent, name + ' must return structured content');
  return result.structuredContent;
}
