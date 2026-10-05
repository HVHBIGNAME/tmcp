import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationWatch } from '../src/tunnel.js';
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
