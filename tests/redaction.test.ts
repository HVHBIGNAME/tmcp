import assert from 'node:assert/strict';
import test from 'node:test';
import { redactedStream } from '../src/redaction.js';
import { redact, type ServerSpec } from '../src/gateway/discovery.js';

test('log redaction protects credentials across every chunk boundary and preserves UTF-8', () => {
  const secret = 'connector-secret-0123456789';
  const text = Buffer.from(`Готово: ${secret}, connected\n`);
  for (let split = 1; split < text.length; split++) {
    const chunks: string[] = [];
    const stream = redactedStream([secret], (chunk) => chunks.push(chunk));
    stream.write(text.subarray(0, split));
    stream.write(text.subarray(split));
    stream.end();
    assert.equal(chunks.join(''), 'Готово: [redacted], connected\n');
  }
});

test('backend errors do not restore redacted URLs or leak bare header and argument secrets', () => {
  const shared = { id: 'test', name: 'Test', fingerprint: 'test', sources: [] };
  const http: ServerSpec = {
    ...shared,
    kind: 'http',
    url: 'https://example.test/private-path?key=query-secret',
    headers: { Authorization: 'Bearer header-secret' },
  };
  const message = redact(
    http,
    'https://example.test/[redacted-path] failed https://example.test/private-path; header-secret query-secret',
  );
  assert.doesNotMatch(message, /private-path|header-secret|query-secret/);
  assert.match(message, /\[redacted-path\]/);
  const stdio: ServerSpec = {
    ...shared,
    kind: 'stdio',
    command: 'node',
    args: ['--token=argument-secret'],
    env: {},
    cwd: '.',
  };
  assert.doesNotMatch(
    redact(stdio, 'authentication failed for argument-secret'),
    /argument-secret/,
  );
});
