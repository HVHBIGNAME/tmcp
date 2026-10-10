import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.js';
import { controlDescriptor, ipcFetch, listenControl, readControlEndpoint } from '../src/ipc.js';

test('IPC uses OS access control, keeps its ACL on replacement pipe instances, and removes stale endpoints', async (t) => {
  const { config } = await fixture(t);
  const ipc = await listenControl(config.dataDir, (req, res) => {
    assert.equal(req.socket.remoteAddress, undefined);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    for (let attempt = 0; attempt < 8; attempt++)
      assert.deepEqual(await (await ipcFetch(config.dataDir, '/_control/bootstrap')).json(), {
        ok: true,
      });
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.resolve('tests/ipc-access.ps1'),
          '-PipeName',
          ipc.endpoint.slice('\\\\.\\pipe\\'.length),
        ],
        { timeout: 15000, windowsHide: true },
      );
      const access = JSON.parse(stdout);
      assert.equal(access.owner, access.user);
      assert.equal(access.protected, true);
      assert.deepEqual(
        access.rules.map((rule: { sid: string; type: string }) => [rule.sid, rule.type]).sort(),
        [
          [access.user, 'Allow'],
          ['S-1-5-18', 'Allow'],
          ['S-1-5-2', 'Deny'],
        ].sort(),
      );
      assert.equal(access.restrictedRead, 5, 'A restricted identity must not read the pipe');
      assert.equal(access.restrictedWrite, 5, 'A restricted identity must not write the pipe');
    } else {
      assert.equal((await stat(path.dirname(ipc.endpoint))).mode & 0o777, 0o700);
      assert.equal((await stat(ipc.endpoint)).mode & 0o777, 0o600);
      await chmod(ipc.endpoint, 0o666);
      await assert.rejects(readControlEndpoint(config.dataDir), /must be private/);
      await chmod(ipc.endpoint, 0o600);
    }
  } finally {
    await ipc.close();
  }
  await assert.rejects(readControlEndpoint(config.dataDir), { code: 'ENOENT' });
});

test('control clients refuse non-IPC endpoints and arbitrary destination routes', async (t) => {
  const { config } = await fixture(t);
  const ipc = await listenControl(config.dataDir, (_req, res) => res.end());
  const filename = controlDescriptor(config.dataDir);
  const original = await readFile(filename, 'utf8');
  try {
    await assert.rejects(
      ipcFetch(config.dataDir, 'https://outside.example/'),
      /Invalid control route/,
    );
    await assert.rejects(
      ipcFetch(config.dataDir, '/_control/api/../outside'),
      /Invalid control route/,
    );
    await writeFile(
      filename,
      JSON.stringify({ version: 1, pid: process.pid, endpoint: 'https://outside.example' }),
    );
    await assert.rejects(readControlEndpoint(config.dataDir), /Invalid/);
  } finally {
    await writeFile(filename, original);
    await ipc.close();
  }
});
