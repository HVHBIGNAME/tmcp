import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/http.js';
import { readConfig } from '../src/config.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tmcp-desktop-audit-'));
await mkdir(path.join(directory, 'workspace'));
let service: Awaited<ReturnType<typeof createApp>> | undefined;
const server = createServer((req, res) => (service ? service.app(req, res) : res.end()));
const client = new Client({ name: 'desktop-tools-audit', version: '1' });
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const config = readConfig({
    MCP_PORT: String(address.port),
    MCP_ROOTS: JSON.stringify([path.join(directory, 'workspace')]),
    MCP_DATA_DIR: path.join(directory, 'data'),
    MCP_SERVERS_FILE: path.join(directory, 'servers.json'),
    MCP_GATEWAY_DISCOVER: 'false',
    MCP_ENABLE_SCREENSHOTS: 'true',
  });
  service = await createApp(config, { log: () => undefined });
  const key = await service.tokens.create({ name: 'Desktop audit', permissions: ['screen'] });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
    }),
  );
  await client.listTools();
  const displays = CallToolResultSchema.parse(
    await client.callTool({ name: 'list_displays', arguments: {} }),
  );
  assert(!displays.isError, JSON.stringify(displays.content));
  const list = displays.structuredContent?.displays as { index: number; name: string }[];
  assert(list.length > 0);
  const image = CallToolResultSchema.parse(
    await client.callTool({
      name: 'take_screenshot',
      arguments: { display: list[0]!.index, max_size: 640 },
    }),
  );
  assert(!image.isError, JSON.stringify(image.content.filter((item) => item.type === 'text')));
  assert.equal(image.content[0]?.type, 'image');
  const invalid = CallToolResultSchema.parse(
    await client.callTool({ name: 'take_screenshot', arguments: { display: 32 } }),
  );
  assert.equal(invalid.isError, true);
  const report = {
    platform: process.platform,
    displays: list.length,
    capture: image.structuredContent,
    invalidDisplayRejected: true,
    imageSaved: false,
  };
  await mkdir('.mcp-tunnel/tool-audit', { recursive: true });
  await writeFile('.mcp-tunnel/tool-audit/desktop.json', JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
} finally {
  await client.close();
  await service?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
