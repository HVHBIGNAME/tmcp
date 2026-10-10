import assert from 'node:assert/strict';
import test from 'node:test';
import { Processes } from '../src/processes.js';
import { Workspace } from '../src/workspace.js';
import { fixture } from './helpers.js';
import { isAlive } from '../src/runtime.js';
import { isErrno } from '../src/utils.js';
import { setTimeout as delay } from 'node:timers/promises';

test(
  'stopping a command terminates its children even after the shell leader exits',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, config } = await fixture(t);
    const processes = new Processes(await Workspace.open([root]), config);
    const job = await processes.run('owner', {
      command: 'sleep 30 & echo $!',
      cwd: '.',
      shell: 'bash',
      wait_ms: 100,
      keep_stdin: false,
    });
    assert(job.pid && job.pid > 1);
    try {
      const deadline = performance.now() + 5000;
      while (isAlive(job.pid) && performance.now() < deadline) await delay(25);
      assert.equal(
        isAlive(job.pid),
        false,
        'the shell has exited but its child still holds stdout',
      );
      const current = await processes.read('owner', job.job_id, 0, 0, 0);
      assert.equal(current.status, 'running');
      const descendant = Number(current.stdout.trim());
      assert(Number.isSafeInteger(descendant) && descendant > 1 && isAlive(descendant));
      const started = performance.now();
      const stopped = await processes.stop('owner', job.job_id);
      assert.equal(stopped.status, 'stopped');
      assert(performance.now() - started < 3000);
    } finally {
      try {
        process.kill(-job.pid, 'SIGKILL');
      } catch (error) {
        if (!isErrno(error, 'ESRCH')) throw error;
      }
      await processes.shutdown();
    }
  },
);
