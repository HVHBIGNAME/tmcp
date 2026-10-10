import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog, type AuditEntry } from '../src/approvals.js';

const entry = (action: string): AuditEntry => ({
  at: new Date().toISOString(),
  actor: 'test',
  clientId: 'test',
  kind: 'file',
  action,
  detail: '',
  outcome: 'executed',
  durationMs: 1,
});

test('concurrent audit writes await durability and a failed batch can be retried', async () => {
  const stored: string[] = [];
  let available = false;
  const audit = new AuditLog(
    async (lines) => {
      if (!available) throw new Error('disk unavailable');
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored.push(...lines);
    },
    () => undefined,
  );
  await assert.rejects(audit.write(entry('first')), /disk unavailable/);
  available = true;
  await Promise.all([audit.write(entry('second')), audit.write(entry('third'))]);
  assert.deepEqual(
    stored.map((line) => JSON.parse(line).action),
    ['first', 'second', 'third'],
  );
  assert.deepEqual(audit.tail(0), []);
  assert.deepEqual(
    audit.tail(2).map((record) => record.action),
    ['third', 'second'],
  );
});
