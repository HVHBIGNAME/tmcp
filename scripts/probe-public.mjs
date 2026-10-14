const endpoint = new URL(process.env.TMCP_PROBE_URL ?? 'https://mcp.spredick.ru/mcp');
if (
  endpoint.protocol !== 'https:' ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error('A public HTTPS endpoint without credentials is required');
const report = { endpoint: endpoint.href, checks: [] };
for (const [path, status, method] of [
  ['/health', 200, 'GET'],
  ['/.well-known/oauth-protected-resource/mcp', 200, 'GET'],
  ['/mcp', 401, 'POST'],
]) {
  try {
    const response = await fetch(new URL(path, endpoint), {
      method,
      signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/json' },
    });
    let ok = response.status === status;
    if (ok && status === 200) {
      const body = await response.json();
      ok =
        path === '/health'
          ? body.status === 'ok' && body.service === 'pc-mcp-tunnel'
          : body.resource === endpoint.href;
    } else {
      await response.body?.cancel();
      if (ok) ok = (response.headers.get('www-authenticate') ?? '').includes('resource_metadata=');
    }
    report.checks.push({ path, expected: status, status: response.status, ok });
  } catch (error) {
    report.checks.push({ path, expected: status, ok: false, error: error.message });
  }
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
