import assert from 'node:assert/strict';
import test from 'node:test';
import { Processes } from '../src/processes.js';
import { Workspace } from '../src/workspace.js';
import { fixture } from './helpers.js';
import { isAlive } from '../src/runtime.js';
import { isErrno } from '../src/utils.js';

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
      assert.equal(
        isAlive(job.pid),
        false,
        'the shell has exited but its child still holds stdout',
      );
      assert.equal(job.status, 'running');
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
