import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { readConfig, type Config } from '../src/config.js';
import { createApp, type HttpOptions } from '../src/http.js';
import { listenControl, ipcFetch, type IpcRequest } from '../src/ipc.js';
import { allPermissions } from '../src/permissions.js';
import { randomUUID } from 'node:crypto';

const cleanups = new WeakMap<TestContext, (() => Promise<void>)[]>();
function cleanup(t: TestContext, operation: () => Promise<void>) {
  let stack = cleanups.get(t);
  if (!stack) {
    stack = [];
    cleanups.set(t, stack);
    const pending = stack;
    t.after(async () => {
      const errors: unknown[] = [];
      for (const action of pending.reverse()) {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      }
      cleanups.delete(t);
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
    });
  }
  stack.push(operation);
}

export async function fixture(t: TestContext, extra: NodeJS.ProcessEnv = {}) {
  const base = path.resolve('.mcp-tunnel', 'tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-'));
  // Windows keeps directory handles briefly after a killed child exits, so removal retries.
  cleanup(t, () =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  );
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const dataDir = path.join(directory, 'data');
  await mkdir(dataDir, { recursive: true });
  const config = readConfig({
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
  let ipc: Awaited<ReturnType<typeof listenControl>> | undefined;
  const server = createServer((req, res) => {
    if (service) service.app(req, res);
    else {
      res.writeHead(503);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Registered before the app is built, so a failure inside createApp cannot leave the
  // listener open and hang the test process.
  cleanup(t, async () => {
    try {
      await service?.close();
    } finally {
      await ipc?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const config = {
    ...basic.config,
    port: address.port,
    localUrl: `http://127.0.0.1:${address.port}`,
    publicUrl: `http://127.0.0.1:${address.port}`,
  };
  service = await createApp(config, { log: () => undefined, ...options });
  const issued = await service.tokens.create({
    name: `Test ${randomUUID()}`,
    permissions: allPermissions,
  });
  ipc = await listenControl(config.dataDir, (req, res) => {
    if (service) service.controlApp(req, res);
    else {
      res.writeHead(503);
      res.end();
    }
  });
  return {
    config,
    get service() {
      return service!;
    },
    server,
    url: config.localUrl,
    key: issued.token,
    headers: { Authorization: `Bearer ${issued.token}` },
    control: (route: string, options?: IpcRequest) => ipcFetch(config.dataDir, route, options),
    async restart() {
      const previous = service;
      service = undefined;
      await previous?.close();
      service = await createApp(config, { log: () => undefined, ...options });
    },
  };
}

export async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
