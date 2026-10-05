import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { Gateway } from '../src/gateway/gateway.js';
import { fixture } from './helpers.js';

test('gateway proxies authenticated Streamable HTTP and falls back to authenticated legacy SSE', async (t) => {
  const { config } = await fixture(t);
  const app = express();
  app.use((req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture-secret') {
      res.sendStatus(401);
      return;
    }
    next();
  });
  app.use(express.json());
  const sessions = new Map<string, SSEServerTransport>();
  const servers = new Set<McpServer>();
  function backend() {
    const server = new McpServer({ name: 'network-fixture', version: '1' });
    server.registerTool('echo', { inputSchema: { text: z.string() } }, ({ text }) => ({
      content: [{ type: 'text', text }],
      structuredContent: { echoed: text },
    }));
    servers.add(server);
    return server;
  }
  app.post('/mcp', async (req, res) => {
    const server = backend();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once('close', () => {
      void server.close();
      servers.delete(server);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/legacy', async (_req, res) => {
    const server = backend();
    const transport = new SSEServerTransport('/messages', res);
    sessions.set(transport.sessionId, transport);
    res.once('close', () => {
      sessions.delete(transport.sessionId);
      void server.close();
      servers.delete(server);
    });
    await server.connect(transport);
  });
  app.post('/messages', async (req, res) => {
    const transport = sessions.get(String(req.query.sessionId));
    if (!transport) {
      res.sendStatus(404);
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });
  app.all('/legacy', (_req, res) => {
    res.sendStatus(405);
  });
  const http = createServer(app);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  await writeFile(
    config.serversFile,
    JSON.stringify({
      mcpServers: {
        modern: { url: `${url}/mcp`, headers: { Authorization: 'Bearer fixture-secret' } },
        legacy: {
          type: 'http',
          url: `${url}/legacy`,
          headers: { Authorization: 'Bearer fixture-secret' },
        },
      },
    }),
  );
  const gateway = new Gateway(config, () => undefined);
  t.after(async () => {
    await gateway.close();
    await Promise.all([...servers].map((server) => server.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  await gateway.reload();
  for (const server of gateway.listServers().servers) {
    const tools = await gateway.listTools(server.id, undefined, '', 0, 10);
    assert.equal(tools.tools[0]?.name, 'echo');
    const result = await gateway.callTool('owner', server.id, 'echo', { text: server.name }, 5000);
    assert.deepEqual(result.structuredContent, { echoed: server.name });
  }
});
