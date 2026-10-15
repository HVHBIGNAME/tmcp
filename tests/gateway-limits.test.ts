import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Gateway } from '../src/gateway/gateway.js';
import { fixture } from './helpers.js';

test(
  'gateway bounds concurrency, single results and retained result memory',
  { timeout: 120000 },
  async (t) => {
    const { config } = await fixture(t);
    await writeFile(
      config.serversFile,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [path.resolve('tests/fixtures/backend.mjs')],
          },
        },
      }),
    );
    const gateway = new Gateway(config, () => undefined);
    t.after(() => gateway.close());
    await gateway.reload();
    const id = gateway.listServers().servers[0]!.id;
    await gateway.client(id);
    const calls: string[] = [];
    for (let n = 0; n < 16; n++) {
      const pending = await gateway.callTool(
        'owner',
        id,
        'echo',
        { text: 'pending', delay_ms: 30000 },
        0,
      );
      calls.push(String(pending.structuredContent?.call_id));
    }
    await assert.rejects(
      gateway.callTool('owner', id, 'echo', { text: 'over budget' }, 0),
      /16 in-flight/,
    );
    for (const call of calls) gateway.cancelCall('owner', call);
    await Promise.all(
      calls.map(async (call) => {
        const result = await gateway.readCall('owner', call, 1000);
        assert.equal(result._meta?.['gateway/status'], 'cancelled');
      }),
    );
    let first = '';
    for (let n = 0; n < 5; n++) {
      const initial = await gateway.callTool(
        'owner',
        id,
        'large_result',
        { bytes: 15 * 1024 * 1024 },
        0,
      );
      const call = String(initial._meta?.['gateway/call_id']);
      let result = await gateway.readCall('owner', call, 1000);
      for (
        let attempt = 0;
        result._meta?.['gateway/status'] === 'running' && attempt < 20;
        attempt++
      )
        result = await gateway.readCall('owner', call, 1000);
      assert(!result.isError);
      assert.equal(result.content[0]?.type, 'text');
      assert(
        result.content[0]?.type === 'text' && result.content[0].text.length === 15 * 1024 * 1024,
      );
      if (n === 0) first = call;
    }
    await assert.rejects(gateway.readCall('owner', first, 0), /expired/);
    const huge = await gateway.callTool(
      'owner',
      id,
      'large_result',
      { bytes: 17 * 1024 * 1024 },
      0,
    );
    const hugeId = String(huge._meta?.['gateway/call_id']);
    let rejected = await gateway.readCall('owner', hugeId, 1000);
    for (
      let attempt = 0;
      rejected._meta?.['gateway/status'] === 'running' && attempt < 20;
      attempt++
    )
      rejected = await gateway.readCall('owner', hugeId, 1000);
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /16 MiB/);
  },
);
