import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

const url = process.argv[2] ?? 'http://127.0.0.1:18787/mcp';
const token = process.argv[3] ?? '';
const label = process.argv[4] ?? 'token';

const client = new Client({ name: 'perm-check', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

/** Prints one line per tool so permission refusals are visible at a glance. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<void> {
  const result = await client.callTool({ name, arguments: args });
  const parts = z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .parse(result.content);
  const text = parts
    .map((part) => part.text ?? `[${part.type}]`)
    .join(' ')
    .replace(/\s+/g, ' ');
  console.log(
    `${label.padEnd(12)} | ${name.padEnd(16)} | error=${result.isError === true} | ${text.slice(0, 110)}`,
  );
}

await call('system_info');
await call('run_command', { command: 'echo hi', wait_ms: 500 });
await call('take_screenshot', { max_size: 640 });
await call('read_file', { path: 'package.json', max_lines: 2 });
await call('write_file', { path: 'permission-probe.txt', content: 'x' });
await client.close();
