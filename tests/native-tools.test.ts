import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { httpFixture } from './helpers.js';
import { toolClient, call, output } from './tool-client.js';
import { toolPermission } from '../src/tool-contracts.js';

test('native file/image tools round-trip through an official MCP client and validate output schemas', async (t) => {
  const instance = await httpFixture(t);
  const client = await toolClient(t, instance.url, instance.headers);
  const listed = await client.listTools();
  assert.deepEqual(
    (await output(client, 'system_info')).available_tools,
    listed.tools.map((tool) => tool.name),
  );
  for (const tool of listed.tools.filter((tool) => Object.hasOwn(toolPermission, tool.name))) {
    assert(
      tool.description && tool.annotations && tool.outputSchema,
      tool.name + ' has an incomplete contract',
    );
  }
  const directory = await output(client, 'create_directory', { path: 'nested/inner' });
  assert.equal(
    (await output(client, 'create_directory', { path: 'nested/inner' })).path,
    directory.path,
  );
  const created = await output(client, 'write_file', {
    path: 'nested/inner/a.txt',
    content: '\ufeffПривет\r\nfoo\r\n',
  });
  assert.equal((await output(client, 'file_info', { path: 'nested/inner' })).type, 'directory');
  const read = await output(client, 'read_file', { path: 'nested/inner/a.txt', max_lines: 1 });
  assert.equal(read.bom, true);
  assert.equal(read.line_ending, 'crlf');
  assert.equal(read.next_line, 2);
  assert.equal(read.next_column, 1);
  assert.equal(read.sha256, created.sha256);
  const changed = await output(client, 'edit_file', {
    path: 'nested/inner/a.txt',
    expected_sha256: read.sha256,
    edits: [{ old_text: 'foo', new_text: 'bar' }],
  });
  const conflict = await call(
    client,
    'write_file',
    { path: 'nested/inner/a.txt', content: 'stale', overwrite: true, expected_sha256: read.sha256 },
    true,
  );
  assert.equal((conflict._meta?.['tmcp/error'] as { code: string }).code, 'conflict');
  await call(client, 'write_file', { path: 'nested/inner/a.txt', content: 'bad' }, true);
  await call(
    client,
    'edit_file',
    { path: 'nested/inner/a.txt', edits: [{ old_text: 'missing', new_text: 'x' }] },
    true,
  );
  assert.equal(
    (await output(client, 'read_file', { path: 'nested/inner/a.txt' })).sha256,
    changed.sha256,
  );
  const found = await output(client, 'find_files', { pattern: '**/*.txt' });
  assert.equal((found.entries as unknown[]).length, 1);
  const searched = await output(client, 'search_text', { query: 'BAR', glob: '**/*.txt' });
  assert.equal((searched.matches as { line: number }[])[0]?.line, 2);
  assert.equal(
    (await output(client, 'list_directory', { path: 'nested', depth: 2 })).truncated,
    false,
  );
  await output(client, 'move_path', { source: 'nested/inner/a.txt', destination: 'moved.txt' });
  await call(client, 'file_info', { path: 'nested/inner/a.txt' }, true);
  await call(client, 'move_path', { source: 'moved.txt', destination: 'moved.txt' }, true);
  await output(client, 'delete_path', { path: 'moved.txt' });
  await call(client, 'delete_path', { path: 'nested' }, true);
  await output(client, 'delete_path', { path: 'nested', recursive: true });
  await call(client, 'delete_path', { path: '.', recursive: true }, true);
  const png = await sharp({
    create: { width: 800, height: 400, channels: 3, background: '#aa5522' },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(instance.config.roots[0]!, 'image.png'), png);
  const image = await call(client, 'read_image', { path: 'image.png', max_size: 320 });
  assert.equal(image.structuredContent?.width, 320);
  assert.equal(image.structuredContent?.height, 160);
  assert.equal(image.content[0]?.type, 'image');
  const block = image.content[0];
  assert(block?.type === 'image');
  assert.equal((await sharp(Buffer.from(block.data, 'base64')).metadata()).format, 'png');
  await output(client, 'write_file', {
    path: 'bad.svg',
    content: '<svg><image href="file:///secret"/></svg>',
  });
  await call(client, 'read_image', { path: 'bad.svg' }, true);
  const audit = await output(client, 'read_audit', { limit: 300 });
  assert((audit.entries as { action: string }[]).some((entry) => entry.action === 'edit_file'));
});

test('all command tools support piped UTF-8 stdin, cursor polling, stop and owner isolation', async (t) => {
  const instance = await httpFixture(t);
  await instance.service.settings.update({ approval: { policy: 'always' } });
  const client = await toolClient(t, instance.url, instance.headers);
  const otherKey = await instance.service.tokens.create({
    name: 'Other command client',
    permissions: ['shell'],
  });
  const other = await toolClient(t, instance.url, { Authorization: `Bearer ${otherKey.token}` });
  const started = await output(client, 'run_command', {
    command: 'node -e "process.stdin.pipe(process.stdout)"',
    keep_stdin: true,
    wait_ms: 0,
  });
  await call(other, 'read_command', { job_id: started.job_id }, true);
  await call(other, 'write_command_input', { job_id: started.job_id, text: 'no' }, true);
  await call(other, 'stop_command', { job_id: started.job_id }, true);
  assert.equal((await output(other, 'list_commands')).commands instanceof Array, true);
  assert.equal(((await output(other, 'list_commands')).commands as unknown[]).length, 0);
  await output(client, 'write_command_input', {
    job_id: started.job_id,
    text: 'Привет 🙂\n',
    end: true,
  });
  let state = started,
    text = String(started.stdout);
  for (let i = 0; i < 20 && (state.status === 'running' || state.stdout_more); i++) {
    state = await output(client, 'read_command', {
      job_id: started.job_id,
      stdout_cursor: state.stdout_cursor,
      stderr_cursor: state.stderr_cursor,
      wait_ms: 1000,
    });
    text += state.stdout;
  }
  assert.equal(state.exit_code, 0);
  assert.match(text, /Привет 🙂/);
  await call(client, 'write_command_input', { job_id: started.job_id, text: 'closed' }, true);
  const long = await output(client, 'run_command', {
    command: 'node -e "setInterval(()=>{},1000)"',
    wait_ms: 0,
  });
  const stopped = await output(client, 'stop_command', { job_id: long.job_id });
  assert.equal(stopped.status, 'stopped');
  assert.equal((await output(client, 'stop_command', { job_id: long.job_id })).status, 'stopped');
  assert(((await output(client, 'list_commands')).commands as unknown[]).length >= 2);
});

test('tools/list exposes only the key capabilities and all native error results remain SDK-compatible', async (t) => {
  const instance = await httpFixture(t);
  const token = await instance.service.tokens.create({
    name: 'Read-only catalogue',
    permissions: ['files:read'],
  });
  const client = await toolClient(t, instance.url, { Authorization: `Bearer ${token.token}` });
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(
    names,
    [
      'system_info',
      'list_directory',
      'find_files',
      'search_text',
      'file_info',
      'read_file',
      'read_image',
    ].sort(),
  );
  await call(client, 'write_file', { path: 'unauthorized', content: 'no' }, true);
  await call(client, 'read_file', { path: 'missing' }, true);
  await call(client, 'read_file', { path: '.', start_line: -1 }, true);
  await call(client, 'read_file', { path: '.', misspelled_option: 1 }, true);
});
