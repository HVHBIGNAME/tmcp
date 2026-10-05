import path from 'node:path';
import { config as dotenv } from 'dotenv';
import { z } from 'zod';

const booleanSetting = z.enum(['true', 'false']).transform((value) => value === 'true');
const jsonStrings = z.string().transform((value, ctx) => {
  try {
    return z.array(z.string().min(1)).parse(JSON.parse(value));
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected a JSON array of non-empty strings' });
    return z.NEVER;
  }
});

const settings = z.object({
  MCP_TOKEN: z
    .string()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/),
  MCP_ADMIN_TOKEN: z
    .string()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/),
  MCP_PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  MCP_CONTROL_PORT: z.coerce.number().int().min(1024).max(65535).default(18790),
  MCP_PUBLIC_URL: z.string().default(''),
  MCP_ROOTS: jsonStrings.prefault('["."]'),
  MCP_ENABLE_SHELL: booleanSetting.prefault('true'),
  MCP_ENABLE_SCREENSHOTS: booleanSetting.prefault('true'),
  MCP_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(2097152),
  MCP_MAX_OUTPUT_CHARS: z.coerce.number().int().min(1024).max(1000000).default(200000),
  MCP_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(86400000).default(120000),
  MCP_DATA_DIR: z.string().min(1).default('.mcp-tunnel'),
  MCP_ALLOWED_ORIGINS: jsonStrings.prefault('[]'),
  MCP_GATEWAY_DISCOVER: booleanSetting.prefault('true'),
  MCP_GATEWAY_MODE: z.enum(['catalog', 'namespaced']).default('catalog'),
  MCP_CONFIG_PATHS: jsonStrings.prefault('[]'),
  MCP_SERVERS_FILE: z.string().min(1).default('mcp-servers.json'),
  MCP_BACKEND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3600000).default(300000),
  MCP_BACKEND_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(180000),
  CLOUDFLARED_BIN: z.string().min(1).default('cloudflared'),
  CLOUDFLARE_TUNNEL_TOKEN: z.string().default(''),
});

export interface Config {
  projectDir: string;
  port: number;
  controlPort: number;
  localUrl: string;
  publicUrl: string;
  bearerToken: string;
  adminToken: string;
  roots: string[];
  shellEnabled: boolean;
  screenshotsEnabled: boolean;
  maxFileBytes: number;
  maxOutputChars: number;
  commandTimeoutMs: number;
  dataDir: string;
  allowedOrigins: string[];
  gatewayDiscover: boolean;
  gatewayMode: 'catalog' | 'namespaced';
  configPaths: string[];
  serversFile: string;
  backendTimeoutMs: number;
  backendConnectTimeoutMs: number;
  cloudflaredBin: string;
  tunnelToken: string;
}

export function validatePublicUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('MCP_PUBLIC_URL must use HTTPS (HTTP is allowed only on loopback)');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(
      'MCP_PUBLIC_URL must be an origin without credentials, path, query or fragment',
    );
  }
  return url.origin;
}

export function readConfig(env: NodeJS.ProcessEnv, projectDir = process.cwd()): Config {
  const parsed = settings.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration. Run npm run setup first.\n${issues.join('\n')}`);
  }
  const s = parsed.data;
  if (!s.MCP_ROOTS.length) throw new Error('MCP_ROOTS must contain at least one directory');
  if (s.MCP_TOKEN === s.MCP_ADMIN_TOKEN) {
    throw new Error('MCP_TOKEN and MCP_ADMIN_TOKEN must be different secrets');
  }
  const localUrl = `http://127.0.0.1:${s.MCP_PORT}`;
  return {
    projectDir: path.resolve(projectDir),
    port: s.MCP_PORT,
    controlPort: s.MCP_CONTROL_PORT,
    localUrl,
    publicUrl: s.MCP_PUBLIC_URL ? validatePublicUrl(s.MCP_PUBLIC_URL) : localUrl,
    bearerToken: s.MCP_TOKEN,
    adminToken: s.MCP_ADMIN_TOKEN,
    roots: s.MCP_ROOTS.map((root) => path.resolve(projectDir, root)),
    shellEnabled: s.MCP_ENABLE_SHELL,
    screenshotsEnabled: s.MCP_ENABLE_SCREENSHOTS,
    maxFileBytes: s.MCP_MAX_FILE_BYTES,
    maxOutputChars: s.MCP_MAX_OUTPUT_CHARS,
    commandTimeoutMs: s.MCP_COMMAND_TIMEOUT_MS,
    dataDir: path.resolve(projectDir, s.MCP_DATA_DIR),
    allowedOrigins: s.MCP_ALLOWED_ORIGINS.map(validatePublicUrl),
    gatewayDiscover: s.MCP_GATEWAY_DISCOVER,
    gatewayMode: s.MCP_GATEWAY_MODE,
    configPaths: s.MCP_CONFIG_PATHS.map((filename) => path.resolve(projectDir, filename)),
    serversFile: path.resolve(projectDir, s.MCP_SERVERS_FILE),
    backendTimeoutMs: s.MCP_BACKEND_TIMEOUT_MS,
    backendConnectTimeoutMs: s.MCP_BACKEND_CONNECT_TIMEOUT_MS,
    cloudflaredBin: s.CLOUDFLARED_BIN,
    tunnelToken: s.CLOUDFLARE_TUNNEL_TOKEN,
  };
}

export function loadConfig(): Config {
  dotenv({ path: path.resolve('.env'), quiet: true });
  return readConfig(process.env);
}

export function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(MCP_|CLOUDFLARE_|CLOUDFLARED_|TUNNEL_)/i.test(key),
    ),
  );
}
