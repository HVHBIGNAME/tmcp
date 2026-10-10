import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRegistrationWatch, startTunnel } from '../src/tunnel.js';
import { fixture } from './helpers.js';

const registrationError =
  'ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"';

test('registration watch needs consecutive failures and recovers on re-registration', () => {
  const watch = createRegistrationWatch(3);
  watch.feed('INF Registered tunnel connection connIndex=0 event=0');
  assert.equal(watch.reported, false);
  watch.feed(registrationError);
  watch.feed('INF Retrying connection in up to 1m4s');
  assert.equal(watch.failures, 1);
  assert.equal(watch.reported, false, 'a single transient error must not drop the tunnel');
  watch.feed(registrationError);
  assert.equal(watch.reported, false);
  watch.feed(registrationError);
  assert.equal(watch.reported, true);
  watch.feed(registrationError);
  assert.equal(watch.reported, true, 'reported once, not per chunk');
  watch.feed('INF Registered tunnel connection connIndex=1 event=0');
  assert.equal(watch.reported, false);
  assert.equal(watch.failures, 0);
});

test('individual reconnects and cancelled requests do not drop a tunnel with healthy connections', () => {
  const watch = createRegistrationWatch(3);
  watch.feed('INF Registered tunnel connection connIndex=0 event=0');
  watch.feed('INF Registered tunnel connection connIndex=1 event=0');
  for (let attempt = 0; attempt < 5; attempt++) {
    watch.feed('ERR failed to serve incoming request error="client disconnected"');
    watch.feed('WRN Connection terminated error="context canceled" connIndex=0');
  }
  assert.equal(watch.reported, false, 'connection 1 is still registered');
  assert.equal(watch.failures, 0);
  watch.feed('WRN Connection terminated connIndex=1');
  assert.equal(watch.failures, 1, 'count failures only once no healthy connection remains');
  watch.feed('WRN Connection terminated connIndex=1\nWRN Connection terminated connIndex=1');
  assert.equal(watch.reported, true);
});

test('a silent total outage is reported after a recovery window and cleared by recovery', () => {
  let now = 0;
  const watch = createRegistrationWatch(3, 100, () => now);
  watch.feed('INF Registered tunnel connection connIndex=0');
  watch.feed('WRN Connection terminated connIndex=0');
  assert.equal(watch.reported, false);
  now = 101;
  assert.equal(watch.reported, true, 'loss must not require another log message');
  watch.feed('INF Registered tunnel connection connIndex=0');
  assert.equal(watch.reported, false);
});

test('a tunnel whose registration is lost is reported only after consecutive failures', async (t) => {
  await fixture(t);
  // Windows cannot spawn a .cmd without a shell, so the process-level path is exercised by
  // the live supervisor; this covers the escalation logic that decides when to recreate.
  const outcomes: string[] = [];
  const watch = createRegistrationWatch(2);
  const report = () => {
    if (watch.reported && !outcomes.length)
      outcomes.push('Tunnel registration was lost and is not recovering');
  };
  watch.feed('INF Registered tunnel connection connIndex=0 event=0');
  watch.feed(registrationError);
  report();
  assert.deepEqual(outcomes, [], 'a single transient failure must not drop a healthy tunnel');
  watch.feed(registrationError);
  report();
  assert.deepEqual(outcomes, ['Tunnel registration was lost and is not recovering']);
});

test('process watcher preserves chunked registrations and reports complete loss once', async (t) => {
  const { directory, config } = await fixture(t, { CLOUDFLARED_PROTOCOL: 'http2' });
  await writeFile(
    path.join(directory, 'tunnel'),
    `import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
if (process.argv[process.argv.indexOf('--protocol') + 1] !== 'http2') process.exit(2);
process.stdout.write('https://fixture.trycloudflare.com\\n');
process.stderr.write('INF Registered tunnel connection connIndex=0\\n');
await delay(20);
process.stderr.write('INF Registered tunnel con');
await delay(20);
process.stderr.write('nection connIndex=1\\n');
await delay(20);
process.stderr.write('WRN Connection terminated connIndex=0\\n'.repeat(3));
process.stdout.write('fixture_stable\\n');
while (!existsSync('drop-remaining')) await delay(20);
process.stderr.write('WRN Connection terminated connIndex=1\\n'.repeat(3));
setInterval(() => {}, 1000);
`,
  );
  const losses: string[] = [];
  let stable = false;
  const tunnel = await startTunnel(
    { ...config, projectDir: directory, cloudflaredBin: process.execPath },
    'quick',
    (entry) => {
      if (typeof entry.message === 'string' && entry.message.includes('fixture_stable'))
        stable = true;
    },
    (message) => losses.push(message),
    undefined,
    { confirmations: 3, interval: 10 },
  );
  try {
    for (let attempt = 0; attempt < 100 && !stable; attempt++) await delay(20);
    assert(stable, 'the fake tunnel reached its stable state');
    await delay(100);
    assert.deepEqual(losses, []);
    await writeFile(path.join(directory, 'drop-remaining'), '');
    for (let attempt = 0; attempt < 100 && !losses.length; attempt++) await delay(20);
    await delay(30);
    assert.deepEqual(losses, ['Tunnel registration was lost and is not recovering']);
  } finally {
    await tunnel.stop();
  }
});
