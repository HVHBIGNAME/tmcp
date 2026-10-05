import assert from 'node:assert/strict';
import test from 'node:test';
import { createUiFixture } from './ui-fixture.js';
import { SettingsStore } from '../src/settings.js';
import { fixture } from './helpers.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startupDefinition } from '../src/autostart.js';

test('control state distinguishes local readiness from a usable external MCP URL', async (t) => {
  const ui = await createUiFixture();
  t.after(() => ui.close());
  const base = ui.url.replace('/ui/', '');
  const headers = { Authorization: `Bearer ${ui.config.adminToken}` };
  const state = async () => (await fetch(`${base}/_control/api/state`, { headers })).json();
  const starting = await state();
  assert.equal(starting.connection.mcpUrl, null);
  assert.equal(starting.connection.status, 'starting');
  ui.connect('https://test.example.com');
  const connected = await state();
  assert.equal(connected.connection.mcpUrl, 'https://test.example.com/mcp');
  ui.runtime.connectionStatus = 'reconnecting';
  ui.runtime.ready = false;
  assert.equal((await state()).connection.mcpUrl, null);
  ui.connect('https://replacement.example.com');
  assert.equal((await state()).connection.mcpUrl, 'https://replacement.example.com/mcp');
});

test('invalid control requests return JSON without HTML, stack traces or input secrets', async (t) => {
  const ui = await createUiFixture();
  t.after(() => ui.close());
  const base = ui.url.replace('/ui/', '');
  const headers = {
    Authorization: `Bearer ${ui.config.adminToken}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${base}/_control/api/settings`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ telegram: { token: 'secret-value', allowedChats: ['not a number'] } }),
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const message = await response.text();
  assert(!message.includes('secret-value'));
  assert(!message.includes('<html'));
  assert(!message.includes('stack'));
  assert.equal(ui.service.settings.redacted().telegram.tokenSet, false);
  const origin = await fetch(`${base}/_control/bootstrap`, {
    headers: { Origin: 'https://example.com' },
  });
  assert.equal(origin.status, 403);
});

test('partial settings writes are serialized and corrupt saved settings are never replaced', async (t) => {
  const { directory } = await fixture(t);
  const filename = path.join(directory, 'settings.json');
  const settings = new SettingsStore(filename);
  await settings.load();
  await settings.update({ telegram: { token: 'private-token', allowedChats: ['42'] } });
  await Promise.all([
    settings.update({ ui: { theme: 'light' } }),
    settings.update({ shell: { enabled: false } }),
    settings.update({ telegram: { allowedChats: ['42', '43'] } }),
  ]);
  assert.equal(settings.secretFor('telegram'), 'private-token');
  assert.equal(settings.get().ui.theme, 'light');
  assert.equal(settings.get().shell.enabled, false);
  assert.equal(settings.get().ui.locale, 'ru');
  const reopened = new SettingsStore(filename);
  await reopened.load();
  assert.deepEqual(reopened.get(), settings.get());
  await writeFile(filename, '{broken');
  await assert.rejects(new SettingsStore(filename).load(), /saved file has been preserved/);
  assert.equal(await readFile(filename, 'utf8'), '{broken');
});

test('autostart definitions quote executable paths and escape platform syntax', () => {
  const linux = startupDefinition(
    'linux',
    '/home/test/My TMCP%20',
    '/opt/Node $tools/node',
    '/home/test/data',
  );
  assert.match(linux, /My TMCP%%20/);
  assert.match(linux, /Node \$\$tools/);
  assert.match(linux, /Restart=on-failure/);
  const mac = startupDefinition('darwin', '/Users/test/A&B', '/opt/node', '/Users/test/data');
  assert.match(mac, /A&amp;B/);
  assert(!mac.includes('<string>/Users/test/A&B'));
});
