import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { Files } from '../src/files.js';
import { Workspace } from '../src/workspace.js';
import { atomicWrite } from '../src/utils.js';

test('cancelled queued mutations preserve existing content and leave the queue usable', async (t) => {
  const { root } = await fixture(t);
  const workspace = await Workspace.open([root]);
  const files = new Files(workspace, 4096);
  await files.write('data', 'original', false, false);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resolve = workspace.resolve.bind(workspace);
  let entered!: () => void;
  const blocked = new Promise<void>((done) => {
    entered = done;
  });
  const intercept = t.mock.method(
    workspace,
    'resolve',
    async (...args: Parameters<Workspace['resolve']>) => {
      entered();
      await barrier;
      return resolve(...args);
    },
  );
  const first = files.makeDirectory('first');
  await blocked;
  const cancelled = new AbortController();
  const second = files.write('data', 'should not commit', true, false, undefined, cancelled.signal);
  const rejected = assert.rejects(second, { name: 'AbortError' });
  cancelled.abort();
  release();
  await first;
  await rejected;
  intercept.mock.restore();
  assert.equal(await readFile(path.join(root, 'data'), 'utf8'), 'original');
  await files.edit('data', [{ old_text: 'original', new_text: 'after cancellation' }]);
  assert.equal(await readFile(path.join(root, 'data'), 'utf8'), 'after cancellation');
});

test('failed atomic replacement removes its temporary file', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'directory');
  await mkdir(target);
  await assert.rejects(atomicWrite(target, 'not a directory'));
  assert.deepEqual(await readdir(root), ['directory']);
  await assert.rejects(
    atomicWrite(path.join(root, 'cancelled'), 'no', 0o600, AbortSignal.abort()),
    { name: 'AbortError' },
  );
  assert.deepEqual(await readdir(root), ['directory']);
});

test('sparse matches cannot bypass the directory traversal ceiling', async (t) => {
  const { root } = await fixture(t);
  const files = new Files(await Workspace.open([root]), 4096);
  let visited = 0;
  t.mock.method(files, 'walk', async function* () {
    for (let index = 0; index < 100000; index++) {
      visited++;
      const name = index === 50000 ? 'target.txt' : `file-${index}`;
      yield { path: path.join(root, name), relative: name, type: 'file' as const, depth: 1 };
    }
  });
  const page = await files.find('.', '**/*.txt', 10, false);
  assert.equal(page.scanned, 20000);
  assert.equal(page.scan_limit_reached, true);
  assert.equal(page.truncated, true);
  assert.equal(page.next_offset, null);
  assert.deepEqual(page.entries, []);
  assert(visited <= 20001, 'The walker continued past its bounded scan');
});
