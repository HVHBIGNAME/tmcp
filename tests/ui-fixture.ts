import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/http.js';
import { token } from '../src/utils.js';

export async function createUiFixture() {
  const base = path.resolve('.mcp-tunnel', 'tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'ui-'));
  const workspace = path.join(directory, 'workspace');
  const dataDir = path.join(directory, 'data');
  await mkdir(workspace);
  await mkdir(dataDir);
  const config = readConfig({
    MCP_TOKEN: token(),
    MCP_ADMIN_TOKEN: token(),
    MCP_ROOTS: JSON.stringify([workspace]),
    MCP_DATA_DIR: dataDir,
    MCP_GATEWAY_DISCOVER: 'false',
    MCP_ENABLE_SCREENSHOTS: 'false',
    MCP_SERVERS_FILE: path.join(directory, 'servers.json'),
  });
  const runtime = { mode: 'quick', ready: false, connectionStatus: 'starting' };
  let autostart = false;
  const service = await createApp(config, {
    log: () => undefined,
    status: () => runtime,
    autostart: {
      status: async () => ({
        enabled: autostart,
        supported: true,
        kind: 'test',
        detail: 'Запуск при входе пользователя.',
      }),
      set: async (enabled) => {
        autostart = enabled;
        return { enabled, supported: true, kind: 'test', detail: 'Запуск при входе пользователя.' };
      },
    },
  });
  const server = createServer(service.controlApp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return {
    service,
    config,
    runtime,
    url: `http://127.0.0.1:${address.port}/ui/`,
    directory,
    connect(url = 'https://workspace-example.trycloudflare.com') {
      service.setPublicUrl(url);
      runtime.ready = true;
      runtime.connectionStatus = 'connected';
    },
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
