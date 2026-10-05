import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fixture, httpFixture } from './helpers.js';

const exec = promisify(execFile);
const cli = path.resolve('src/cli.ts');

test('CLI help runs without configuration and setup preserves existing keys', async (t) => {
  const { directory, root } = await fixture(t);
  const run = (...args: string[]) =>
    exec(process.execPath, ['--import', 'tsx', cli, '--home', directory, ...args], {
      timeout: 15000,
    });
  const help = await run('--help');
  assert.match(help.stdout, /tmcp token create/);
  await assert.rejects(access(path.join(directory, '.env')));
  await run('setup', '--root', root, '--port', '19876');
  const first = await readFile(path.join(directory, '.env'), 'utf8');
  assert.match(first, /MCP_PORT=19876/);
  assert.match(first, /MCP_TOKEN=[A-Za-z0-9_-]{40,}/);
  await run('setup', '--root', directory, '--port', '19877');
  assert.equal(await readFile(path.join(directory, '.env'), 'utf8'), first);
});

test('CLI creates, lists, disables and deletes keys through the isolated control API', async (t) => {
  const base = await fixture(t);
  const instance = await httpFixture(t, base.config, {
    status: () => ({ service: 'pc-mcp-tunnel', ready: true, pid: process.pid }),
  });
  const controlServer = createServer(instance.service.controlApp);
  await new Promise<void>((resolve) => controlServer.listen(0, '127.0.0.1', resolve));
  const address = controlServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  t.after(() => {
    controlServer.closeAllConnections();
    controlServer.close();
  });
  const config = instance.config;
  await writeFile(
    path.join(base.directory, '.env'),
    [
      `MCP_PORT=${config.port}`,
      `MCP_CONTROL_PORT=${address.port}`,
      `MCP_TOKEN=${config.bearerToken}`,
      `MCP_ADMIN_TOKEN=${config.adminToken}`,
      `MCP_ROOTS=${JSON.stringify([base.root.replaceAll('\\', '/')])}`,
      `MCP_DATA_DIR=${config.dataDir.replaceAll('\\', '/')}`,
    ].join('\n'),
  );
  const run = (...args: string[]) =>
    exec(process.execPath, ['--import', 'tsx', cli, '--home', base.directory, ...args], {
      timeout: 15000,
    });
  const created = JSON.parse(
    (await run('token', 'create', '--name', 'CLI test', '--permissions', 'files:read,shell'))
      .stdout,
  ) as { id: string; token: string };
  assert(instance.service.tokens.find(created.token));
  const listed = await run('token', 'list', '--json');
  assert(!listed.stdout.includes(created.token));
  await run('token', 'disable', created.id);
  assert.equal(instance.service.tokens.find(created.token), undefined);
  await run('token', 'delete', created.id, '--yes');
  assert.equal(instance.service.tokens.list().length, 0);
});
