import assert from 'node:assert/strict';
import test from 'node:test';
import { Processes } from '../src/processes.js';
import { Workspace } from '../src/workspace.js';
import { fixture } from './helpers.js';
import { isAlive } from '../src/runtime.js';
import { isErrno } from '../src/utils.js';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test(
  'a POSIX command cannot leave ordinary children running after its shell exits',
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
      let current = await processes.read('owner', job.job_id, 0, 0, 1000);
      for (let n = 0; current.status === 'running' && n < 5; n++)
        current = await processes.read('owner', job.job_id, 0, 0, 1000);
      assert.equal(current.status, 'exited');
      const descendant = Number(current.stdout.trim());
      assert(Number.isSafeInteger(descendant) && descendant > 1);
      if (isAlive(descendant)) {
        // An orphan can briefly remain as a zombie until the OS reaps it.
        const state = await promisify(execFile)('ps', [
          '-o',
          'stat=',
          '-p',
          String(descendant),
        ]).catch((error) => {
          if (error.code === 1) return { stdout: '' };
          throw error;
        });
        assert.match(state.stdout.trim(), /^(Z.*)?$/, 'Descendant is still executing');
      }
      assert.equal((await processes.stop('owner', job.job_id)).status, 'exited');
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

test(
  'Windows job closes orphaned descendants even when the shell exits normally',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { root, config } = await fixture(t);
    await writeFile(
      path.join(root, 'spawn.cjs'),
      `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(child.pid);process.exit(0);`,
    );
    const processes = new Processes(await Workspace.open([root]), config);
    t.after(() => processes.shutdown());
    let job = await processes.run('owner', {
      command: 'node spawn.cjs',
      cwd: '.',
      keep_stdin: false,
      wait_ms: 1000,
    });
    for (let n = 0; job.status === 'running' && n < 10; n++)
      job = await processes.read('owner', job.job_id, 0, 0, 1000);
    assert.equal(job.status, 'exited', job.stderr);
    const pid = Number(job.stdout.trim());
    assert(Number.isSafeInteger(pid) && pid > 0);
    for (let n = 0; isAlive(pid) && n < 100; n++) await delay(20);
    assert.equal(isAlive(pid), false, 'An ordinary descendant escaped the managed Windows job');
  },
);
