import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, httpFixture } from './helpers.js';
import { installDesktop, windowsArgument } from '../src/desktop-install.js';
import { readConfig } from '../src/config.js';

test('desktop installation survives moving the download and preserves configuration', async (t) => {
  const { directory } = await fixture(t);
  const source = path.join(directory, 'download.exe');
  const home = path.join(directory, 'installed home');
  await mkdir(home);
  await writeFile(source, 'executable-content');
  await writeFile(path.join(home, '.env'), 'unchanged');
  const installed = await installDesktop(source, home);
  assert.equal(await readFile(installed, 'utf8'), 'executable-content');
  assert.equal(await installDesktop(installed, home), installed);
  await assert.rejects(installDesktop(path.join(directory, 'missing.exe'), home));
  assert.equal(await readFile(installed, 'utf8'), 'executable-content');
  assert.equal(await readFile(path.join(home, '.env'), 'utf8'), 'unchanged');
  assert.deepEqual((await readdir(home)).sort(), ['.env', 'TMCP.exe']);
  assert.equal(windowsArgument('C:\\a b\\'), '"C:\\a b\\\\"');
  assert.equal(windowsArgument('a"b'), '"a\\"b"');
});

test('versioned desktop payload uses permanent config paths and protects its installation', async (t) => {
  const base = await fixture(t);
  const home = path.join(base.directory, 'installed');
  await mkdir(home);
  const executable = path.join(home, 'TMCP.exe');
  await writeFile(executable, 'private runtime');
  const config = readConfig(
    {
      MCP_ENV_FILE: path.join(home, '.env'),
      MCP_DESKTOP_EXE: executable,
      MCP_ROOTS: JSON.stringify([base.directory]),
      MCP_GATEWAY_DISCOVER: 'false',
      MCP_ENABLE_SCREENSHOTS: 'false',
      MCP_SERVERS_FILE: 'servers.json',
    },
    path.join(home, 'app', 'version-hash'),
  );
  assert.equal(config.dataDir, path.join(home, '.mcp-tunnel'));
  assert.equal(config.serversFile, path.join(home, 'servers.json'));
  const instance = await httpFixture(t, config);
  const response = await fetch(`${instance.url}/mcp`, {
    method: 'POST',
    headers: {
      ...instance.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: executable } },
    }),
  });
  const body = await response.text();
  assert.match(body, /not readable through MCP tools/);
  assert.doesNotMatch(body, /private runtime/);
});
