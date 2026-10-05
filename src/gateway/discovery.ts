import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parse as parseEnv } from 'dotenv';
import type { Config } from '../config.js';
import { hash, isErrno } from '../utils.js';

interface CommonServer {
  id: string;
  name: string;
  sources: string[];
  fingerprint: string;
}

export type ServerSpec = CommonServer &
  (
    | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string }
    | { kind: 'http' | 'sse'; url: string; headers: Record<string, string> }
  );

export interface Discovery {
  servers: ServerSpec[];
  sources: string[];
  diagnostics: { source: string; server?: string; message: string }[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  const record = object(value);
  if (!record || Object.values(record).some((entry) => typeof entry !== 'string'))
    throw new Error(`${field} must contain string values`);
  return record as Record<string, string>;
}

function homePath(value: string): string {
  return value === '~'
    ? os.homedir()
    : value.startsWith('~/') || value.startsWith('~\\')
      ? path.join(os.homedir(), value.slice(2))
      : value;
}

async function expand(value: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  let result = value
    .replace(/\$\{workspaceFolder\}/g, () => cwd)
    .replace(/\$\{userHome\}/g, () => os.homedir());
  result = result.replace(
    /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (
      _match,
      first: string | undefined,
      fallback: string | undefined,
      second: string | undefined,
    ) => {
      const name = first ?? second!;
      const replacement = env[name] ?? fallback;
      if (replacement === undefined) throw new Error(`Missing environment variable: ${name}`);
      return replacement;
    },
  );
  for (const match of [...result.matchAll(/\{file:([^}]+)\}/g)]) {
    const filename = path.resolve(cwd, homePath(match[1]!));
    const content = await readFile(filename, 'utf8');
    if (content.length > 65536) throw new Error('An interpolated credential file exceeds 64 KiB');
    result = result.replace(match[0], () => content.trim());
  }
  if (/\$\{input:/.test(result))
    throw new Error('Editor input variables need explicit values in mcp-servers.json');
  return result;
}

function knownConfigPaths(projectDir: string): string[] {
  const home = os.homedir();
  const roaming = process.env.APPDATA ?? path.join(home, 'Library', 'Application Support');
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const files = [
    path.join(configHome, 'opencode', 'opencode.json'),
    path.join(configHome, 'opencode', 'opencode.jsonc'),
    path.join(home, '.claude.json'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    path.join(home, '.trae', 'mcp.json'),
    path.join(roaming, 'Claude', 'claude_desktop_config.json'),
    path.join(roaming, 'Code', 'User', 'mcp.json'),
    path.join(roaming, 'Code - Insiders', 'User', 'mcp.json'),
    path.join(roaming, 'Trae', 'User', 'mcp.json'),
    path.join(roaming, 'Trae', 'User', 'mcp_config.json'),
    path.join(roaming, 'Trae CN', 'User', 'mcp.json'),
  ];
  let directory = projectDir;
  while (true) {
    files.push(
      ...[
        '.mcp.json',
        '.cursor/mcp.json',
        '.vscode/mcp.json',
        'opencode.json',
        'opencode.jsonc',
      ].map((filename) => path.join(directory, filename)),
    );
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return files;
}

export async function readJsonConfig(
  filename: string,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(filename, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const errors: ParseError[] = [];
  const data: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length)
    throw new Error(`Invalid JSON/JSONC: ${printParseErrorCode(errors[0]!.error)}`);
  const result = object(data);
  if (!result) throw new Error('MCP configuration must be a JSON object');
  return result;
}

async function normalize(
  name: string,
  raw: Record<string, unknown>,
  source: string,
  cwd: string,
  config: Config,
): Promise<ServerSpec> {
  const expandValue = (value: string) => expand(value, cwd, process.env);
  const url = raw.url ?? raw.serverUrl;
  let connection:
    | Omit<Extract<ServerSpec, { kind: 'stdio' }>, keyof CommonServer>
    | Omit<Extract<ServerSpec, { kind: 'http' | 'sse' }>, keyof CommonServer>;
  if (typeof url === 'string') {
    const expanded = new URL(await expandValue(url));
    if (!['http:', 'https:'].includes(expanded.protocol))
      throw new Error('Remote MCP URL must use HTTP or HTTPS');
    const selfHosts = new Set([
      new URL(config.localUrl).host,
      `localhost:${config.port}`,
      new URL(config.publicUrl).host,
    ]);
    if (selfHosts.has(expanded.host) && expanded.pathname.replace(/\/$/, '') === '/mcp')
      throw new Error('Skipping this gateway itself to avoid a proxy loop');
    const headers = Object.fromEntries(
      await Promise.all(
        Object.entries(strings(raw.headers, 'headers')).map(async ([key, value]) => [
          key,
          await expandValue(value),
        ]),
      ),
    );
    connection = {
      kind: raw.type === 'sse' || expanded.pathname.endsWith('/sse') ? 'sse' : 'http',
      url: expanded.href,
      headers,
    };
  } else {
    let command: string;
    let args: string[];
    if (
      Array.isArray(raw.command) &&
      raw.command.length &&
      raw.command.every((part) => typeof part === 'string')
    ) {
      command = raw.command[0] as string;
      args = raw.command.slice(1) as string[];
    } else if (
      typeof raw.command === 'string' &&
      (raw.args === undefined ||
        (Array.isArray(raw.args) && raw.args.every((part) => typeof part === 'string')))
    ) {
      command = raw.command;
      args = raw.args === undefined ? [] : (raw.args as string[]);
    } else throw new Error('A stdio server requires command and string args');
    const envFile =
      typeof raw.envFile === 'string'
        ? parseEnv(await readFile(path.resolve(cwd, await expandValue(raw.envFile))))
        : {};
    const env = Object.fromEntries(
      await Promise.all(
        Object.entries({
          ...envFile,
          ...strings(raw.env ?? raw.environment, 'env/environment'),
        }).map(async ([key, value]) => [key, await expandValue(value)]),
      ),
    );
    connection = {
      kind: 'stdio',
      command: homePath(await expandValue(command)),
      args: await Promise.all(args.map(expandValue)),
      cwd:
        typeof raw.cwd === 'string' ? path.resolve(cwd, homePath(await expandValue(raw.cwd))) : cwd,
      env,
    };
  }
  const fingerprint = hash(JSON.stringify(connection));
  const prefix =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 40) || 'server';
  return {
    ...connection,
    id: `${prefix}_${fingerprint.slice(0, 8)}`,
    name,
    sources: [source],
    fingerprint,
  };
}

export async function discoverServers(config: Config): Promise<Discovery> {
  const discovery: Discovery = { servers: [], sources: [], diagnostics: [] };
  const paths = [
    ...new Set([
      ...(config.gatewayDiscover ? knownConfigPaths(config.projectDir) : []),
      ...config.configPaths,
      config.serversFile,
    ]),
  ];
  const excluded = new Set<string>();
  const deduplicated = new Map<string, ServerSpec>();
  for (const filename of paths) {
    let data: Record<string, unknown> | undefined;
    try {
      data = await readJsonConfig(filename);
    } catch (error) {
      discovery.diagnostics.push({
        source: filename,
        message: error instanceof Error ? error.message : 'Unable to read configuration',
      });
      continue;
    }
    if (!data) continue;
    discovery.sources.push(filename);
    if (filename === config.serversFile && Array.isArray(data.excludeServers)) {
      for (const item of data.excludeServers) if (typeof item === 'string') excluded.add(item);
    }
    const groups: { values: Record<string, unknown>; cwd: string }[] = [];
    for (const key of ['mcpServers', 'mcp', 'servers']) {
      const values = object(data[key]);
      if (values) groups.push({ values, cwd: config.projectDir });
    }
    const projects = object(data.projects);
    if (projects) {
      for (const [project, details] of Object.entries(projects)) {
        const values = object(object(details)?.mcpServers);
        if (values) groups.push({ values, cwd: project });
      }
    }
    for (const group of groups) {
      for (const [name, value] of Object.entries(group.values)) {
        const raw = object(value);
        if (!raw || raw.disabled === true || raw.enabled === false) continue;
        try {
          const spec = await normalize(name, raw, filename, group.cwd, config);
          const existing = deduplicated.get(spec.fingerprint);
          if (existing) {
            if (!existing.sources.includes(filename)) existing.sources.push(filename);
          } else deduplicated.set(spec.fingerprint, spec);
        } catch (error) {
          discovery.diagnostics.push({
            source: filename,
            server: name,
            message: error instanceof Error ? error.message : 'Invalid server configuration',
          });
        }
      }
    }
  }
  discovery.servers = [...deduplicated.values()].filter(
    (server) => !excluded.has(server.id) && !excluded.has(server.name),
  );
  return discovery;
}

export function publicServer(spec: ServerSpec) {
  return { id: spec.id, name: spec.name, transport: spec.kind, sources: spec.sources };
}

export function redact(spec: ServerSpec, message: string): string {
  const secrets = spec.kind === 'stdio' ? Object.values(spec.env) : Object.values(spec.headers);
  let output = message;
  for (const secret of secrets)
    if (secret.length >= 4) output = output.split(secret).join('[redacted]');
  if (spec.kind !== 'stdio')
    output = output.split(spec.url).join(`${new URL(spec.url).origin}/[redacted-path]`);
  return output.slice(0, 2000);
}
