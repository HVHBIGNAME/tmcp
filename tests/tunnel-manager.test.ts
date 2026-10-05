import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TunnelManager, type TunnelState } from '../src/tunnel-manager.js';
import { fixture } from './helpers.js';

test('tunnel failures recover without restarting the MCP listener', async (t) => {
  const { config } = await fixture(t);
  let attempts = 0;
  const states: TunnelState[] = [];
  const urls: string[] = [];
  let disconnected: (message: string) => void = () => undefined;
  const manager = new TunnelManager(
    config,
    () => ({ mode: 'quick', hostname: '', tunnelToken: '' }),
    (url) => urls.push(url),
    async (state) => {
      states.push(state);
    },
    () => undefined,
    async (_config, _mode, _log, onExit) => {
      attempts++;
      disconnected = onExit;
      if (attempts === 1) throw new Error('temporary network failure');
      return { url: `https://tunnel-${attempts}.example.com`, stop: async () => undefined };
    },
    15,
  );
  t.after(() => manager.stop());
  await assert.rejects(manager.restart('quick'), /network failure/);
  const deadline = Date.now() + 2000;
  while (urls.length < 1 && Date.now() < deadline) await delay(10);
  assert.deepEqual(urls, ['https://tunnel-2.example.com']);
  assert.equal(states.at(-1)?.ready, true);
  disconnected('registration lost');
  while (urls.length < 2 && Date.now() < deadline) await delay(10);
  assert.equal(urls.at(-1), 'https://tunnel-3.example.com');
  assert(states.some((state) => state.connectionStatus === 'reconnecting'));
});

test('named mode uses saved domain and connector token and validates before stopping a live tunnel', async (t) => {
  const { config } = await fixture(t);
  const settings = { mode: 'quick' as 'quick' | 'named', hostname: '', tunnelToken: '' };
  let stops = 0;
  const launches: { token: string; url: string; mode: string }[] = [];
  const manager = new TunnelManager(
    config,
    () => settings,
    () => undefined,
    async () => undefined,
    () => undefined,
    async (launchConfig, mode) => {
      launches.push({ token: launchConfig.tunnelToken, url: launchConfig.publicUrl, mode });
      return {
        url: 'https://live.example.com',
        stop: async () => {
          stops++;
        },
      };
    },
  );
  t.after(() => manager.stop());
  await manager.restart('quick');
  await assert.rejects(manager.restart('named'), /Named tunnel requires/);
  assert.equal(stops, 0);
  settings.mode = 'named';
  settings.hostname = 'mcp.example.com';
  settings.tunnelToken = 'connector-test-value';
  await manager.restart('named');
  assert.equal(stops, 1);
  assert.deepEqual(launches.at(-1), {
    token: 'connector-test-value',
    url: 'https://mcp.example.com',
    mode: 'named',
  });
});
