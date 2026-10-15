import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const server = new McpServer({ name: 'fixture-backend', version: '1' });
server.registerTool(
  'echo',
  {
    inputSchema: { text: z.string(), delay_ms: z.number().default(0) },
    annotations: { readOnlyHint: true },
  },
  async ({ text, delay_ms }, extra) => {
    await delay(delay_ms, undefined, { signal: extra.signal });
    return { content: [{ type: 'text', text }], structuredContent: { echoed: text } };
  },
);
server.registerTool('tiny_image', { inputSchema: {} }, () => ({
  content: [
    {
      type: 'image',
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    },
  ],
}));
server.registerTool('fail', { inputSchema: {} }, () => ({
  isError: true,
  content: [{ type: 'text', text: 'intentional backend failure' }],
}));
server.registerTool(
  'large_result',
  {
    inputSchema: {
      bytes: z
        .number()
        .int()
        .min(0)
        .max(17 * 1024 * 1024),
    },
  },
  ({ bytes }) => ({
    content: [{ type: 'text', text: 'x'.repeat(bytes) }],
  }),
);
server.registerTool(
  'drop_after_increment',
  { inputSchema: { counter: z.string() } },
  async ({ counter }) => {
    let previous = 0;
    try {
      previous = Number(await readFile(counter, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await writeFile(counter, String(previous + 1));
    process.exit(0);
  },
);
server.registerResource('hello', 'fixture://hello', { mimeType: 'text/plain' }, () => ({
  contents: [{ uri: 'fixture://hello', text: 'resource text' }],
}));
server.registerResource(
  'item',
  new ResourceTemplate('fixture://item/{id}', { list: undefined }),
  {},
  (uri, { id }) => ({ contents: [{ uri: uri.href, text: `item ${id}` }] }),
);
server.registerResource('slow', 'fixture://slow', {}, async (uri, extra) => {
  await delay(30000, undefined, { signal: extra.signal });
  return { contents: [{ uri: uri.href, text: 'late' }] };
});
server.registerTool('long_' + 'name'.repeat(25), { inputSchema: {} }, () => ({
  content: [{ type: 'text', text: 'long tool name' }],
}));
server.registerPrompt('greet', { argsSchema: { name: z.string() } }, ({ name }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }],
}));
if (process.env.FIXTURE_START_DELAY) await delay(Number(process.env.FIXTURE_START_DELAY));
await server.connect(new StdioServerTransport());
