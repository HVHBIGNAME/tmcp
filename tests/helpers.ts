import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { readConfig, type Config } from '../src/config.js';
import { createApp, type HttpOptions } from '../src/http.js';
import { token } from '../src/utils.js';

export async function fixture(t: TestContext, extra: NodeJS.ProcessEnv = {}) {
  const base = path.resolve('.mcp-tunnel', 'tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const dataDir = path.join(directory, 'data');
  await mkdir(dataDir, { recursive: true });
  const config = readConfig({
    MCP_TOKEN: token(),
    MCP_ADMIN_TOKEN: token(),
    MCP_ROOTS: JSON.stringify([root]),
    MCP_DATA_DIR: dataDir,
    MCP_GATEWAY_DISCOVER: 'false',
    MCP_SERVERS_FILE: path.join(directory, 'servers.json'),
    MCP_ENABLE_SCREENSHOTS: 'false',
    ...extra,
  });
  return { directory, root, config };
}

export async function httpFixture(t: TestContext, supplied?: Config, options: HttpOptions = {}) {
  const basic = supplied ? { config: supplied } : await fixture(t);
  let service: Awaited<ReturnType<typeof createApp>> | undefined;
  const server = createServer((req, res) => {
    if (service) service.app(req, res);
    else {
      res.writeHead(503);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const config = {
    ...basic.config,
    port: address.port,
    localUrl: `http://127.0.0.1:${address.port}`,
    publicUrl: `http://127.0.0.1:${address.port}`,
  };
  service = await createApp(config, { log: () => undefined, ...options });
  t.after(async () => {
    await service?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    config,
    service,
    server,
    url: config.localUrl,
    headers: { Authorization: `Bearer ${config.bearerToken}` },
  };
}

export async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
