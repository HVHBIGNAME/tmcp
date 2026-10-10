import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, httpFixture } from './helpers.js';
import { AuthStore } from '../src/auth/store.js';
import { hash, token } from '../src/utils.js';

test('migration preserves app-issued keys and their grants, but drops owner and unbound authorizations', async (t) => {
  const instance = await httpFixture(t);
  const key = instance.service.tokens.find(instance.key)!;
  const keyFile = path.join(instance.config.dataDir, 'tokens.json');
  const before = await readFile(keyFile, 'utf8');
  const boundAccess = token();
  const ownerAccess = token();
  const unboundAccess = token();
  const binding = { tokenId: key.id, tokenHash: hash(instance.key), name: 'Existing app key' };
  const grant = {
    id: 'bound',
    clientId: 'existing-client',
    scopes: ['pc:access'],
    resource: `${instance.url}/mcp`,
    expiresAt: Date.now() + 60000,
    accessExpiresAt: Date.now() + 60000,
    accessHash: hash(boundAccess),
    refreshHash: hash(token()),
    usedRefreshHashes: [],
    binding,
  };
  const authorization = {
    clientId: grant.clientId,
    expiresAt: Date.now() + 60000,
    csrf: token(),
    binding,
    params: {
      codeChallenge: token(),
      redirectUri: 'https://client.example/callback',
      scopes: grant.scopes,
      resource: grant.resource,
    },
  };
  const filename = path.join(instance.config.dataDir, 'oauth.json');
  await writeFile(
    filename,
    JSON.stringify({
      version: 1,
      adminFingerprint: hash(token()),
      clients: [],
      flowStateVersion: 1,
      grants: [
        grant,
        {
          ...grant,
          id: 'owner',
          accessHash: hash(ownerAccess),
          binding: { ...binding, tokenId: 'mcp-token' },
        },
        { ...grant, id: 'unbound', accessHash: hash(unboundAccess), binding: undefined },
      ],
      pending: { pending: { ...authorization, binding: undefined } },
      codes: {
        bound: authorization,
        owner: { ...authorization, binding: { ...binding, tokenId: 'mcp-token' } },
        unbound: { ...authorization, binding: undefined },
      },
    }),
  );
  await instance.restart();
  assert.equal(await readFile(keyFile, 'utf8'), before);
  assert.equal((await instance.service.auth.verifyAccessToken(boundAccess)).extra?.tokenId, key.id);
  await assert.rejects(instance.service.auth.verifyAccessToken(ownerAccess));
  await assert.rejects(instance.service.auth.verifyAccessToken(unboundAccess));
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal('adminFingerprint' in saved, false);
  assert.deepEqual(
    saved.grants.map((entry: { id: string }) => entry.id),
    ['bound'],
  );
  assert.deepEqual(Object.keys(saved.codes), ['bound']);
  assert.deepEqual(Object.keys(saved.pending), ['pending']);
});

test('an unreadable OAuth store is never silently reset during migration', async (t) => {
  const { config } = await fixture(t);
  const filename = path.join(config.dataDir, 'oauth.json');
  await writeFile(filename, '{broken');
  await assert.rejects(AuthStore.open(config.dataDir), /refusing to reset existing credentials/);
  assert.equal(await readFile(filename, 'utf8'), '{broken');
});
