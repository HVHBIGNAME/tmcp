import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { configAt } from '../src/service-control.js';
import { childEnvironment } from '../src/config.js';
import { ipcFetch } from '../src/ipc.js';

if (process.env.TMCP_AUDIT_EXTERNAL !== '1')
  throw new Error(
    'Set TMCP_AUDIT_EXTERNAL=1 to explicitly test the configured endpoint and backend catalogues.',
  );
const config = configAt(process.cwd());
const response = await ipcFetch(config.dataDir, '/_control/api/state');
assert(response.ok, 'Start the local TMCP service before its external audit');
const state = await response.json();
const endpoint = state.connection?.mcpUrl;
assert(
  typeof endpoint === 'string' && endpoint.startsWith('https://'),
  'A public HTTPS MCP endpoint is required',
);
const created = await ipcFetch(config.dataDir, '/_control/api/tokens', {
  method: 'POST',
  body: JSON.stringify({
    name: `External audit ${Date.now()}`,
    permissions: ['files:read', 'gateway'],
  }),
});
assert.equal(created.status, 201);
const issued = await created.json();
const client = new Client({ name: 'external-tool-audit', version: '1' });
const publicClient = new Client({ name: 'public-tool-audit', version: '1' });
const report: Record<string, unknown> = { endpoint, backendCalls: 'catalogue metadata only' };
try {
  await mkdir('.mcp-tunnel/tool-audit', { recursive: true });
  await writeFile(
    '.mcp-tunnel/tool-audit/active-key.json',
    JSON.stringify({ id: issued.id, name: issued.name }),
  );
  let publicReady = false;
  try {
    await publicClient.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
      }),
    );
    const tools = await publicClient.listTools();
    const system = CallToolResultSchema.parse(
      await publicClient.callTool({ name: 'system_info', arguments: {} }),
    );
    assert(!system.isError);
    report.publicMcp = {
      initialized: true,
      tools: tools.tools.length,
      platform: system.structuredContent?.platform,
    };
    publicReady = true;
  } catch (error) {
    report.publicMcp = {
      status: 'blocked',
      error: (error instanceof Error ? error.message : String(error))
        .replaceAll(issued.token, '[redacted]')
        .slice(0, 1200),
    };
  } finally {
    await publicClient.close();
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.localUrl + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
  const tools = await client.listTools();
  const system = CallToolResultSchema.parse(
    await client.callTool({ name: 'system_info', arguments: {} }),
  );
  assert(!system.isError);
  report.localMcp = {
    initialized: true,
    tools: tools.tools.length,
    platform: system.structuredContent?.platform,
  };
  const servers = CallToolResultSchema.parse(
    await client.callTool({ name: 'mcp_list_servers', arguments: {} }),
  );
  assert(!servers.isError);
  const backends = servers.structuredContent?.servers as {
    id: string;
    name: string;
    transport: string;
  }[];
  const checks: Record<string, unknown>[] = [];
  for (const backend of backends) {
    let result: CallToolResult | undefined;
    let id: unknown;
    try {
      result = CallToolResultSchema.parse(
        await client.callTool({
          name: 'mcp_list_tools',
          arguments: { server_id: backend.id, limit: 1, wait_ms: 0 },
        }),
      );
      id = result.structuredContent?.call_id;
      for (let n = 0; result._meta?.['gateway/status'] === 'running' && n < 20; n++)
        result = CallToolResultSchema.parse(
          await client.callTool({
            name: 'mcp_read_call',
            arguments: { call_id: id, wait_ms: 1000 },
          }),
        );
      checks.push({
        name: backend.name,
        transport: backend.transport,
        status: result.isError
          ? 'error'
          : result._meta?.['gateway/status'] === 'running'
            ? 'connection_pending'
            : 'catalogue_verified',
        toolsInPage: result.structuredContent?.total_in_page,
        ...(result.isError
          ? {
              error: result.content
                .filter((item) => item.type === 'text')
                .map((item) => item.text)
                .join('\n')
                .slice(0, 1000),
            }
          : {}),
      });
    } finally {
      if (id && result?._meta?.['gateway/status'] === 'running')
        await client.callTool({ name: 'mcp_cancel_call', arguments: { call_id: id } });
    }
  }
  report.backends = checks;
  if (publicReady) {
    const oauth = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'tests/live-oauth.ts'],
      {
        env: { ...childEnvironment(), TMCP_CHECK_URL: endpoint, TMCP_CHECK_KEY: issued.token },
        timeout: 150000,
        maxBuffer: 1024 * 1024,
      },
    );
    report.oauth = JSON.parse(oauth.stdout.trim());
  } else
    report.oauth = {
      status: 'blocked',
      reason: 'Public MCP endpoint did not pass its reachability check',
    };
} catch (error) {
  report.error = (error instanceof Error ? error.message : String(error)).replaceAll(
    issued.token,
    '[redacted]',
  );
  process.exitCode = 1;
} finally {
  try {
    await client.close();
  } finally {
    const removed = await ipcFetch(config.dataDir, `/_control/api/tokens/${issued.id}`, {
      method: 'DELETE',
    });
    assert(removed.ok, 'Remove the temporary audit key through the local UI');
    await rm('.mcp-tunnel/tool-audit/active-key.json', { force: true });
    report.temporaryKeyRemoved = true;
    await mkdir('.mcp-tunnel/tool-audit', { recursive: true });
    await writeFile('.mcp-tunnel/tool-audit/external.json', JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
}
