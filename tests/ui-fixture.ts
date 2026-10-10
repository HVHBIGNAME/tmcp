import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/http.js';
import express from 'express';
import { listenControl, ipcFetch, type IpcRequest } from '../src/ipc.js';
import { attachBrowserBridge } from './browser-bridge.js';
import type { Page } from '@playwright/test';

export async function createUiFixture() {
  const base = path.resolve('.mcp-tunnel', 'tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'ui-'));
  const workspace = path.join(directory, 'workspace');
  const dataDir = path.join(directory, 'data');
  await mkdir(workspace);
  await mkdir(dataDir);
  const config = readConfig({
    MCP_ROOTS: JSON.stringify([workspace]),
    MCP_DATA_DIR: dataDir,
    MCP_GATEWAY_DISCOVER: 'false',
    MCP_ENABLE_SCREENSHOTS: 'false',
    MCP_SERVERS_FILE: path.join(directory, 'servers.json'),
  });
  const runtime = { mode: 'quick', ready: false, connectionStatus: 'starting' };
  let autostart = false;
  let service: Awaited<ReturnType<typeof createApp>>;
  const publicServer = createServer((req, res) => service.app(req, res));
  await new Promise<void>((resolve) => publicServer.listen(0, '127.0.0.1', resolve));
  const publicAddress = publicServer.address();
  if (!publicAddress || typeof publicAddress === 'string') throw new Error('Expected TCP address');
  config.port = publicAddress.port;
  config.localUrl = `http://127.0.0.1:${publicAddress.port}`;
  config.publicUrl = config.localUrl;
  try {
    service = await createApp(config, {
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
          return {
            enabled,
            supported: true,
            kind: 'test',
            detail: 'Запуск при входе пользователя.',
          };
        },
      },
    });
  } catch (error) {
    publicServer.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const ipc = await listenControl(config.dataDir, service.controlApp);
  const assets = express();
  assets.use('/ui', express.static(path.resolve('ui/public')));
  const server = createServer(assets);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const pages = new Set<Page>();
  return {
    service,
    config,
    runtime,
    publicUrl: config.localUrl,
    url: `http://127.0.0.1:${address.port}/ui/`,
    attach: (page: Page) => {
      pages.add(page);
      return attachBrowserBridge(page, config.dataDir);
    },
    control: (route: string, options?: IpcRequest) => ipcFetch(config.dataDir, route, options),
    directory,
    connect(url = 'https://workspace-example.trycloudflare.com') {
      service.setPublicUrl(url);
      runtime.ready = true;
      runtime.connectionStatus = 'connected';
    },
    async close() {
      for (const page of pages) {
        if (!page.isClosed()) {
          await page.goto('about:blank');
          await page.unrouteAll({ behavior: 'wait' });
          await page.close();
        }
      }
      await service.close();
      await ipc.close();
      publicServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        publicServer.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
