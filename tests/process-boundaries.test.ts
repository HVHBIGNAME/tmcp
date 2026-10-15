import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { Processes } from '../src/processes.js';
import { Workspace } from '../src/workspace.js';
import { fixture } from './helpers.js';

test('output cursor rejects a split Unicode character and command history expires', async (t) => {
  const { root, config } = await fixture(t);
  const jobs = new Processes(await Workspace.open([root]), config);
  t.after(() => jobs.shutdown());
  await writeFile(path.join(root, 'output.cjs'), 'process.stdout.write("🙂x");');
  let job = await jobs.run('owner', {
    command: 'node output.cjs',
    cwd: '.',
    wait_ms: 1000,
    keep_stdin: false,
  });
  for (let n = 0; job.status === 'running' && n < 10; n++)
    job = await jobs.read('owner', job.job_id, 0, 0, 1000);
  assert.equal(job.stdout, '🙂x');
  await assert.rejects(jobs.read('owner', job.job_id, 1, 0, 0), /Unicode/);
  assert.equal((await jobs.read('owner', job.job_id, 2, 0, 0)).stdout, 'x');
  const future = Date.now() + 3600001;
  t.mock.method(Date, 'now', () => future);
  assert.deepEqual(jobs.list('owner'), []);
  await assert.rejects(jobs.read('owner', job.job_id, 0, 0, 0), /Unknown/);
});

test(
  'blocked stdin has a deadline and cannot queue repeated writes',
  { timeout: 45000 },
  async (t) => {
    const { root, config } = await fixture(t);
    const jobs = new Processes(await Workspace.open([root]), config);
    t.after(() => jobs.shutdown());
    await writeFile(
      path.join(root, 'paused.cjs'),
      'process.stdin.pause(); console.log("ready"); setInterval(()=>{},1000);',
    );
    let job = await jobs.run('owner', {
      command: 'node paused.cjs',
      cwd: '.',
      wait_ms: 1000,
      keep_stdin: true,
    });
    for (let n = 0; !job.stdout.includes('ready') && n < 10; n++)
      job = await jobs.read('owner', job.job_id, 0, 0, 500);
    assert.match(job.stdout, /ready/);
    await assert.rejects(async () => {
      for (let n = 0; n < 64; n++) await jobs.input('owner', job.job_id, '🙂'.repeat(50000), false);
    }, /stdin write timed out/);
    await assert.rejects(
      jobs.input('owner', job.job_id, 'do not duplicate', false),
      /still pending/,
    );
    assert.equal((await jobs.stop('owner', job.job_id)).status, 'stopped');
  },
);

test('cancelling a waiting command stops its owned job', async (t) => {
  const { root, config } = await fixture(t);
  const jobs = new Processes(await Workspace.open([root]), config);
  t.after(() => jobs.shutdown());
  const abort = new AbortController();
  const pending = jobs.run('owner', {
    command: 'node -e "setInterval(()=>{},1000)"',
    cwd: '.',
    wait_ms: 10000,
    keep_stdin: false,
    signal: abort.signal,
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  for (let n = 0; !jobs.list('owner').length && n < 100; n++) await delay(20);
  assert.equal(jobs.list('owner').length, 1);
  abort.abort();
  await rejected;
  const id = jobs.list('owner')[0]!.job_id;
  let final = await jobs.read('owner', id, 0, 0, 1000);
  for (let n = 0; final.status === 'running' && n < 5; n++)
    final = await jobs.read('owner', id, 0, 0, 1000);
  assert.equal(final.status, 'stopped');
});
