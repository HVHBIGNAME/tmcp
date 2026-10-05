import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    write: { type: 'boolean' },
    screenshots: { type: 'boolean' },
    backends: { type: 'boolean' },
  },
});
const config = loadConfig();
const url = new URL(values.url ?? `${config.localUrl}/mcp`);
const unauthenticated = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(15000),
});
assert.equal(unauthenticated.status, 401, 'Anonymous MCP access must be blocked');
assert.match(unauthenticated.headers.get('www-authenticate') ?? '', /resource_metadata=/);
const metadata = await fetch(new URL('/.well-known/oauth-authorization-server', url), {
  signal: AbortSignal.timeout(15000),
});
assert.equal(metadata.status, 200);
console.log('PASS authentication boundary and OAuth discovery');

const client = new Client({ name: 'pc-mcp-smoke', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${config.bearerToken}` } },
  }),
  { timeout: 20000 },
);
async function tool(name: string, args: Record<string, unknown> = {}) {
  let result = CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 60000 }),
  );
  const deadline = Date.now() + config.backendConnectTimeoutMs + config.backendTimeoutMs + 10000;
  while (result._meta?.['gateway/status'] === 'running') {
    assert(Date.now() < deadline, `Backend ${name} exceeded the smoke-test deadline`);
    result = CallToolResultSchema.parse(
      await client.callTool(
        {
          name: 'mcp_read_call',
          arguments: { call_id: result._meta['gateway/call_id'], wait_ms: 1000 },
        },
        CallToolResultSchema,
        { timeout: 30000 },
      ),
    );
  }
  assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result;
}
const record = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);

try {
  const tools = await client.listTools();
  assert(tools.tools.some((entry) => entry.name === 'read_file'));
  assert(tools.tools.some((entry) => entry.name === 'mcp_call_tool'));
  const info = await tool('system_info');
  console.log(
    `PASS MCP initialize/tools/list/system_info (${tools.tools.length} tools, ${record(info.structuredContent).platform})`,
  );
  if (values.write) {
    const directory = path.join(config.roots[0]!, `.pc-mcp-smoke-${randomUUID()}`);
    const filename = path.join(directory, 'hello.txt');
    await tool('create_directory', { path: directory });
    try {
      await tool('write_file', { path: filename, content: 'Привет MCP\noriginal\n' });
      const read = record((await tool('read_file', { path: filename })).structuredContent);
      await tool('edit_file', {
        path: filename,
        expected_sha256: read.sha256,
        edits: [{ old_text: 'original', new_text: 'edited' }],
      });
      const edited = record((await tool('read_file', { path: filename })).structuredContent);
      assert.match(String(edited.content), /edited/);
      const search = record(
        (await tool('search_text', { path: directory, query: 'edited' })).structuredContent,
      );
      assert.equal(z.array(z.unknown()).parse(search.matches).length, 1);
      await tool('move_path', {
        source: filename,
        destination: path.join(directory, 'renamed.txt'),
      });
      console.log('PASS create/read/edit/search/rename with UTF-8 and conflict hashes');
    } finally {
      await tool('delete_path', { path: directory, recursive: true });
    }
  }
  if (config.shellEnabled) {
    let job = record(
      (await tool('run_command', { command: 'node --version', wait_ms: 1000 })).structuredContent,
    );
    while (job.status === 'running')
      job = record(
        (await tool('read_command', { job_id: job.job_id, wait_ms: 1000 })).structuredContent,
      );
    assert.equal(job.exit_code, 0);
    assert.match(String(job.stdout), /v\d+\./);
    console.log('PASS shell execution and job polling');
  }
  if (values.screenshots) {
    const captured = await tool('take_screenshot', { max_size: 1280 });
    const image = captured.content.find((content) => content.type === 'image');
    assert(image?.type === 'image');
    const info = await sharp(Buffer.from(image.data, 'base64')).metadata();
    assert(info.width && info.width <= 1280);
    console.log(`PASS real desktop screenshot (${info.width}x${info.height} PNG)`);
  }
  if (values.backends) {
    const listed = record((await tool('mcp_list_servers')).structuredContent);
    const backends = z.array(z.object({ id: z.string(), name: z.string() })).parse(listed.servers);
    for (const backend of backends) {
      try {
        const listedTools = record(
          (await tool('mcp_list_tools', { server_id: backend.id, limit: 1 })).structuredContent,
        );
        console.log(
          `PASS backend ${backend.name}: ${listedTools.total_in_page} tools in first page`,
        );
      } catch (error) {
        console.error(
          `FAIL backend ${backend.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
    }
  }
} finally {
  await client.close();
}
