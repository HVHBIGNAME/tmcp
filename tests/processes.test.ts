import assert from 'node:assert/strict';
import test from 'node:test';
import { Processes } from '../src/processes.js';
import { Workspace } from '../src/workspace.js';
import { fixture } from './helpers.js';
import { isAlive } from '../src/runtime.js';

test('commands capture exit status, handle background polling and isolate clients', async (t) => {
  const { root, config } = await fixture(t);
  const processes = new Processes(await Workspace.open([root]), config);
  t.after(() => processes.shutdown());
  const command =
    process.platform === 'win32'
      ? '[Console]::WriteLine("Привет MCP"); [Console]::Error.WriteLine("failure"); exit 7'
      : 'printf "Привет MCP\\n"; printf "failure\\n" >&2; exit 7';
  let job = await processes.run('alice', { command, cwd: '.', wait_ms: 0, keep_stdin: false });
  await assert.rejects(processes.read('bob', job.job_id, 0, 0, 0), /Unknown/);
  for (let attempt = 0; job.status === 'running' && attempt < 10; attempt++)
    job = await processes.read('alice', job.job_id, 0, 0, 1000);
  assert.equal(job.status, 'failed');
  assert.equal(job.exit_code, 7);
  assert.match(job.stdout, /Привет MCP/);
  assert.match(job.stderr, /failure/);
  const next = await processes.read('alice', job.job_id, job.stdout_cursor, job.stderr_cursor, 0);
  assert.equal(next.stdout, '');
  assert.equal(next.stderr, '');
});

test('timeouts terminate long-running command processes and output memory is bounded', async (t) => {
  const { root, config } = await fixture(t, { MCP_MAX_OUTPUT_CHARS: '2048' });
  const processes = new Processes(await Workspace.open([root]), config);
  t.after(() => processes.shutdown());
  let output = await processes.run('alice', {
    command: 'node -e "process.stdout.write(\'x\'.repeat(8000))"',
    cwd: '.',
    wait_ms: 1000,
    keep_stdin: false,
  });
  for (let attempt = 0; output.status === 'running' && attempt < 10; attempt++)
    output = await processes.read('alice', output.job_id, 0, 0, 1000);
  assert.equal(output.exit_code, 0);
  assert.equal(output.stdout.length, 2048);
  assert.equal(output.stdout_truncated, true);
  let long = await processes.run('alice', {
    command: 'node -e "setInterval(()=>{},1000)"',
    cwd: '.',
    wait_ms: 0,
    keep_stdin: false,
    timeout_ms: 2000,
  });
  for (let attempt = 0; long.status === 'running' && attempt < 15; attempt++)
    long = await processes.read('alice', long.job_id, 0, 0, 1000);
  assert.equal(long.status, 'timed_out');
  assert(long.pid);
  assert.equal(isAlive(long.pid), false);
});
