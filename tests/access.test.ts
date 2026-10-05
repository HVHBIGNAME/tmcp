import assert from 'node:assert/strict';
import test from 'node:test';
import { Approvals } from '../src/approvals.js';
import { compile, decide, defaultRules, type ApprovalRules } from '../src/approval.js';
import { TokenStore } from '../src/auth/tokens.js';
import { SettingsStore } from '../src/settings.js';
import { rotateEnvToken, generateSecret, readEnvFile } from '../src/secrets.js';
import { fixture } from './helpers.js';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

test('allowlist matching is exact unless a glob is used', () => {
  const rules: ApprovalRules = {
    ...defaultRules,
    policy: 'match',
    allow: ['git status', 'npm run *'],
    deny: ['rm *'],
  };
  assert.deepEqual(decide(rules, 'git status'), { action: 'allow', rule: 'git status' });
  assert.equal(decide(rules, 'git status --porcelain').action, 'ask');
  assert.equal(decide(rules, 'npm run build').action, 'allow');
  assert.deepEqual(decide(rules, 'rm -rf x'), { action: 'deny', rule: 'rm *' });
  assert.equal(decide(rules, 'curl example.com').action, 'ask');
  assert.equal(decide({ ...rules, policy: 'never' }, 'curl example.com').action, 'deny');
  assert.equal(
    decide({ ...rules, policy: 'never', allow: ['curl example.com'] }, 'curl example.com').action,
    'allow',
  );
});

test('multiline commands are matched on the first line only', () => {
  const match = compile(['npm *']);
  assert.equal(match('npm test'), 'npm *');
  assert.equal(match('rm -rf /'), undefined);
});

test('approvals ask once, remember on request and expire', async () => {
  const approvals = new Approvals(300, 4);
  const rules: ApprovalRules = { ...defaultRules, policy: 'once' };
  const first = approvals.authorize({ command: 'npm test', cwd: '/w', clientId: 'c', rules });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [pending] = approvals.list();
  assert(pending);
  assert.equal(pending.command, 'npm test');
  assert.equal(pending.channel, 'gui');
  assert.throws(
    () => approvals.respond('00000000-0000-4000-8000-000000000000', 'allow'),
    /expired|already answered/,
  );
  await assert.rejects(first, /timed out/);

  const second = approvals.authorize({ command: 'npm run build', cwd: '/w', clientId: 'c', rules });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const request = approvals.list()[0]!;
  assert.deepEqual(approvals.respond(request.id, 'allow', true), {
    action: 'allow',
    remembered: true,
  });
  assert.throws(
    () => approvals.respond(request.id, 'allow'),
    /expired|already answered/,
    'a second answer must be rejected',
  );
  assert.deepEqual(await second, { action: 'allow', remembered: true });
  assert.deepEqual(
    await approvals.authorize({ command: 'npm run build', cwd: '/w', clientId: 'c', rules }),
    { action: 'allow', remembered: true },
  );

  const denied = approvals.authorize({
    command: 'curl example.com',
    cwd: '/w',
    clientId: 'c',
    rules,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  approvals.respond(approvals.list()[0]!.id, 'deny');
  assert.deepEqual(await denied, { action: 'deny' });
  approvals.cancelAll('Server stopped');
  assert.equal(approvals.list().length, 0);
});

test('a pending approval limit is enforced', async () => {
  const approvals = new Approvals(5000, 1);
  const rules: ApprovalRules = { ...defaultRules, policy: 'once' };
  const first = approvals.authorize({ command: 'one', cwd: '/w', clientId: 'c', rules });
  first.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    approvals.authorize({ command: 'two', cwd: '/w', clientId: 'c', rules }),
    /waiting for approval/,
  );
  approvals.cancelAll('done');
  await assert.rejects(first);
});

test('shared tokens store only hashes and isolate permissions', async (t) => {
  const { directory } = await fixture(t);
  const store = await TokenStore.open(directory);
  const readOnly = await store.create({ name: 'Notion read-only', permissions: ['files:read'] });
  assert.match(readOnly.token, /^[A-Za-z0-9_-]{40,}$/);
  const onDisk = await readFile(path.join(directory, 'tokens.json'), 'utf8');
  assert(!onDisk.includes(readOnly.token), 'the plaintext token must not be stored');
  assert.deepEqual(store.find(readOnly.token)?.permissions, ['files:read']);
  assert.equal(store.find(generateSecret()), undefined);

  const rotated = await store.rotate(readOnly.id);
  assert.notEqual(rotated.token, readOnly.token);
  assert.equal(store.find(readOnly.token), undefined, 'the old secret must stop working');
  assert.deepEqual(store.find(rotated.token)?.permissions, ['files:read']);

  await store.update(readOnly.id, { permissions: ['files:read', 'shell'], enabled: false });
  assert.equal(store.find(rotated.token), undefined, 'a disabled token must not authenticate');
  await store.update(readOnly.id, { enabled: true });
  assert.equal(store.find(rotated.token)?.permissions.length, 2);
  await assert.rejects(
    store.create({ name: 'Notion read-only', permissions: ['shell'] }),
    /already exists/,
  );
  await assert.rejects(store.create({ name: 'bad', permissions: ['nope'] }), /Unknown permission/);
  await assert.rejects(store.create({ name: 'bad', permissions: [] }), /at least one/);
  await store.remove(readOnly.id);
  assert.equal(store.list().length, 0);
  await assert.rejects(store.rotate('00000000-0000-4000-8000-000000000000'), /Unknown token/);
});

test('settings keep secrets across partial updates and never expose them', async (t) => {
  const directory = await mkdtemp(path.join('.mcp-tunnel', 'tests', 'settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(path.join(directory, 'settings.json'));
  await store.load();
  assert.equal(store.redacted().telegram.tokenSet, false);

  const secret = generateSecret();
  await store.update({
    telegram: { token: secret, allowedChats: ['42'] },
    approval: { policy: 'match', allow: ['git status'], deny: [], timeoutMs: 60000 },
  });
  const view = await store.update({ telegram: { token: '', allowedChats: ['42', '43'] } });
  assert.equal(view.telegram.token, '');
  assert.equal(view.telegram.tokenSet, true);
  assert.equal(store.secretFor('telegram'), secret, 'an empty field must not erase the secret');
  assert.deepEqual(view.telegram.allowedChats, ['42', '43']);
  assert.equal(store.get().approval.policy, 'match');

  const reopened = new SettingsStore(path.join(directory, 'settings.json'));
  await reopened.load();
  assert.equal(reopened.secretFor('telegram'), secret);
  await assert.rejects(store.update({ approval: { policy: 'nope' } }));
});

test('env rotation rewrites only the requested secrets and preserves the rest', async (t) => {
  const directory = await mkdtemp(path.join('.mcp-tunnel', 'tests', 'env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, '.env');
  await rm(filename, { force: true });
  await (
    await import('node:fs/promises')
  ).writeFile(
    filename,
    '# comment\r\nMCP_TOKEN=old-owner\r\nMCP_ROOTS=["C:/work"]\r\nMCP_ADMIN_TOKEN=old-admin\r\n',
  );
  const owner = generateSecret();
  const result = await rotateEnvToken(filename, { ownerToken: owner });
  assert.deepEqual(result.updated, ['MCP_TOKEN']);
  const values = await readEnvFile(filename);
  assert.equal(values.MCP_TOKEN, owner);
  assert.equal(values.MCP_ADMIN_TOKEN, 'old-admin');
  assert.equal(values.MCP_ROOTS, '["C:/work"]');
  assert.match(await readFile(filename, 'utf8'), /# comment/);
  await assert.rejects(rotateEnvToken(filename, { ownerToken: undefined, adminToken: undefined }));
});
