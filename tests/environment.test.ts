import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { childEnvironment } from '../src/config.js';

test('a private Node runtime remains callable without a global PATH and child processes do not inherit MCP credentials', async () => {
  const oldPath = process.env.PATH;
  const names = ['MCP_ENVIRONMENT_TEST', 'TMCP_CHECK_KEY', 'PC_MCP_UI_DATA_DIR'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.PATH = '';
    for (const name of names) process.env[name] = 'parent-only-secret';
    const { stdout } = await promisify(execFile)(
      'node',
      [
        '-e',
        'process.stdout.write(JSON.stringify({executable:process.execPath,secret:process.env.MCP_ENVIRONMENT_TEST,key:process.env.TMCP_CHECK_KEY,preview:process.env.PC_MCP_UI_DATA_DIR}))',
      ],
      { env: childEnvironment(), windowsHide: true },
    );
    assert.deepEqual(JSON.parse(stdout), { executable: process.execPath });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
