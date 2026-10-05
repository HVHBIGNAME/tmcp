import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Files } from '../src/files.js';
import { Workspace } from '../src/workspace.js';
import { fixture } from './helpers.js';

test('file operations preserve UTF-8/CRLF, reject ambiguous edits and are atomic on edit failure', async (t) => {
  const { root } = await fixture(t);
  const files = new Files(await Workspace.open([root]), 4096);
  await files.write('code.txt', '\ufeffПривет\r\nfoo foo\r\n', false, true);
  const first = await files.read('code.txt', 1, 1);
  assert.equal(first.total_lines, 2);
  assert.equal(first.next_line, 2);
  await assert.rejects(files.write('code.txt', 'overwrite', false, true), /EEXIST/);
  await assert.rejects(files.edit('code.txt', [{ old_text: 'foo', new_text: 'bar' }]), /ambiguous/);
  await assert.rejects(
    files.edit('code.txt', [
      { old_text: 'Привет', new_text: 'changed' },
      { old_text: 'missing', new_text: 'x' },
    ]),
    /not found/,
  );
  assert.equal(await readFile(path.join(root, 'code.txt'), 'utf8'), '\ufeffПривет\r\nfoo foo\r\n');
  await files.edit(
    'code.txt',
    [{ old_text: 'foo', new_text: '$&bar', replace_all: true }],
    first.sha256,
  );
  assert.equal(
    await readFile(path.join(root, 'code.txt'), 'utf8'),
    '\ufeffПривет\r\n$&bar $&bar\r\n',
  );
  await assert.rejects(
    files.edit('code.txt', [{ old_text: 'bar', new_text: 'x', replace_all: true }], first.sha256),
    /changed/,
  );
});

test('concurrent edits with the same hash cannot silently overwrite one another', async (t) => {
  const { root } = await fixture(t);
  const files = new Files(await Workspace.open([root]), 4096);
  const created = await files.write('counter', 'old', false, false);
  const results = await Promise.allSettled(
    ['one', 'two'].map((new_text) =>
      files.edit('counter', [{ old_text: 'old', new_text }], created.sha256),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('path containment rejects traversal, prefix siblings, junction escapes and dangling links', async (t) => {
  const { root, directory } = await fixture(t);
  const workspace = await Workspace.open([root]);
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'private');
  await symlink(
    outside,
    path.join(root, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await symlink(
    path.join(outside, 'missing'),
    path.join(root, 'dangling'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  for (const input of [
    '../outside/private.txt',
    `${root}-other/file`,
    'escape/private.txt',
    'escape/new/deep/file',
    'dangling/file',
  ]) {
    await assert.rejects(workspace.resolve(input));
  }
  const files = new Files(workspace, 4096);
  await files.delete('escape', false);
  assert.equal(await readFile(path.join(outside, 'private.txt'), 'utf8'), 'private');
  await assert.rejects(files.delete('.', true), /root/);
  if (process.platform === 'win32') {
    for (const input of [
      'C:relative',
      'file.txt:stream',
      '\\\\?\\C:\\anything',
      'NUL',
      'folder/COM1.txt',
      'trailing.',
    ])
      await assert.rejects(workspace.resolve(input));
  }
});

test('find/search limits and explicit recursive deletion', async (t) => {
  const { root } = await fixture(t);
  const files = new Files(await Workspace.open([root]), 4096);
  await files.write('src/a.ts', 'Needle\nneedle\n', false, true);
  await files.write('src/b.txt', 'irrelevant', false, true);
  await files.write('node_modules/skipped.ts', 'needle', false, true);
  await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  const found = await files.find('.', '**/*.ts', 10, false);
  assert.equal(found.entries.length, 1);
  const searched = await files.search('.', 'needle', '**/*.ts', false, 1);
  assert.equal(searched.matches.length, 1);
  assert.equal(searched.truncated, true);
  await assert.rejects(files.read('binary.dat', 1, 2), /Binary/);
  await assert.rejects(files.write('huge', 'x'.repeat(4097), false, false), /exceeds/);
  await assert.rejects(files.delete('src', false));
  await files.move('src/b.txt', 'moved.txt');
  await files.delete('src', true);
  assert.equal((await files.info('moved.txt')).type, 'file');
});
