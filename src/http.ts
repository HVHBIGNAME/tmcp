import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidTokenError, OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { AuthProvider, scope } from './auth/provider.js';
import { AuthStore } from './auth/store.js';
import { validatePublicUrl, type Config } from './config.js';
import { Files } from './files.js';
import { Processes } from './processes.js';
import { createMcpServer, type Logger } from './tools.js';
import { errorMessage, secretEqual, SerialQueue } from './utils.js';
import { Workspace } from './workspace.js';
import { Gateway } from './gateway/gateway.js';
import { Approvals, AuditLog } from './approvals.js';
import { TokenStore } from './auth/tokens.js';
import { defaultSettings, SettingsStore, settingsPath } from './settings.js';
import { controlErrorHandler, controlRouter } from './control.js';
import { Telegram } from './telegram.js';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { OwnerSecrets } from './secrets.js';
import { allPermissions } from './permissions.js';
import type { Caller } from './tools.js';
import { z } from 'zod';
import { connectionView } from './connection.js';
import { Autostart, type AutostartControl } from './autostart.js';

export interface HttpOptions {
  log?: Logger;
  status?: () => Record<string, unknown>;
  shutdown?: () => void;
  deferGatewayWarmup?: boolean;
  rotateToken?: (kind: 'owner' | 'admin', current: string) => Promise<string>;
  restartTunnel?: (mode: 'quick' | 'named') => Promise<{ url: string }>;
  restartServer?: () => void;
  /** Directory with the control UI assets. */
  uiDir?: string;
  startedAt?: string;
  telegramApiBase?: string;
  autostart?: AutostartControl;
}

export async function createApp(config: Config, options: HttpOptions = {}) {
  const log =
    options.log ??
    ((event) => console.log(JSON.stringify({ time: new Date().toISOString(), ...event })));
  const workspace = await Workspace.open(config.roots);
  const files = new Files(workspace, config.maxFileBytes);
  const processes = new Processes(workspace, config);
  const store = await AuthStore.open(config.dataDir, config.adminToken);
  const auth = new AuthProvider(config, store);
  const tokens = await TokenStore.open(config.dataDir);
  const settings = new SettingsStore(settingsPath(config.dataDir), {
    ...structuredClone(defaultSettings),
    gateway: { discover: config.gatewayDiscover, mode: config.gatewayMode },
  });
  await settings.load();
  config.gatewayDiscover = settings.get().gateway.discover;
  config.gatewayMode = settings.get().gateway.mode;
  const gateway = new Gateway(config, log);
  await gateway.reload(!options.deferGatewayWarmup);
  const approvals = new Approvals();
  const auditFile = path.join(config.dataDir, 'audit.log');
  const audit = new AuditLog(
    async (lines) => {
      if (!settings.get().logging.enabled) return;
      await appendFile(auditFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    },
    () => undefined,
  );
  let telegram: Telegram | undefined;
  let telegramSignature = '';
  const uiDir = options.uiDir ?? path.join(config.projectDir, 'ui', 'public');
  const startedAt = options.startedAt ?? new Date().toISOString();

  /** Remote control through the bot; every command maps to the same services as the GUI. */
  const handleTelegramCommand = async (_chat: string, text: string): Promise<string> => {
    const [command = '', ...rest] = text.trim().split(/\s+/);
    const argument = rest.join(' ');
    const current = settings.get();
    switch (command.toLowerCase()) {
      case '/start':
      case '/help':
        return [
          'PC MCP is running.',
          '/status — state and MCP address',
          '/pending — commands waiting for approval',
          '/allow <id> [all] — allow once or always',
          '/deny <id> — reject',
          '/servers — connected MCP servers',
          '/token <name> — issue a read and shell token',
          '/tunnel — recreate the tunnel',
          '/on <id> or /off <id> — enable or disable a token',
        ].join('\n');
      case '/status':
        return [
          `MCP: ${config.publicUrl}/mcp`,
          `Started: ${startedAt}`,
          `Shell: ${current.shell.enabled ? 'on' : 'off'}`,
          `Screenshots: ${current.screenshots.enabled ? 'on' : 'off'}`,
          `Approval policy: ${current.approval.policy}`,
          `Tokens: ${tokens.list().length}`,
        ].join('\n');
      case '/pending': {
        const waiting = approvals.list();
        return waiting.length
          ? waiting
              .map(
                (request, index) =>
                  `${index + 1}. ${request.summary}\n   ${request.cwd}\n   ${request.id}`,
              )
              .join('\n')
          : 'No commands are waiting.';
      }
      case '/allow':
      case '/deny': {
        const id = rest[0] ?? '';
        if (!id) return 'Send an approval id.';
        const allow = command.toLowerCase() === '/allow';
        try {
          approvals.respond(id, allow ? 'allow' : 'deny', rest[1] === 'all');
          return allow ? (rest[1] === 'all' ? 'Allowed and remembered.' : 'Allowed.') : 'Denied.';
        } catch (error) {
          return errorMessage(error);
        }
      }
      case '/servers': {
        const servers = gateway.listServers().servers;
        return servers.length
          ? servers
              .map((server) => `${server.name} (${server.transport}) — ${server.status}`)
              .join('\n')
          : 'No MCP servers found.';
      }
      case '/token': {
        const name = argument.trim();
        if (!name) return 'Send a token name.';
        try {
          const issued = await tokens.create({ name, permissions: ['files:read', 'shell'] });
          return `${issued.name}: ${issued.token}\nShown once, store it now.`;
        } catch (error) {
          return errorMessage(error);
        }
      }
      case '/tunnel':
        if (!options.restartTunnel) return 'Tunnel restart is unavailable here.';
        try {
          return `Restarting… ${(await options.restartTunnel(current.tunnel.mode)).url}/mcp`;
        } catch (error) {
          return errorMessage(error);
        }
      case '/on':
      case '/off': {
        try {
          await tokens.update(rest[0] ?? '', { enabled: command.toLowerCase() === '/on' });
          return `${command.toLowerCase() === '/on' ? 'Enabled' : 'Disabled'}.`;
        } catch (error) {
          return errorMessage(error);
        }
      }
      default:
        return 'Unknown command. Send /help.';
    }
  };

  const handleTelegramCallback = async (_chat: string, data: string): Promise<string> => {
    try {
      const [, id, action, remember] = z
        .tuple([
          z.literal('a'),
          z.string().uuid(),
          z.enum(['allow', 'deny']),
          z.enum(['once', 'remember']),
        ])
        .parse(data.split(':'));
      approvals.respond(id, action, remember === 'remember');
      return action === 'allow'
        ? remember === 'remember'
          ? 'Allowed and remembered.'
          : 'Allowed.'
        : 'Denied.';
    } catch (error) {
      return errorMessage(error);
    }
  };

  const settingsApplications = new SerialQueue();
  const applySettings = (): Promise<void> =>
    settingsApplications.run(async () => {
      const current = settings.get();
      const signature = JSON.stringify(current.telegram);
      if (signature !== telegramSignature) {
        await telegram?.stop();
        telegram = current.telegram.token
          ? new Telegram({
              ...current.telegram,
              apiBase: options.telegramApiBase,
            })
          : undefined;
        telegramSignature = signature;
        telegram?.start(handleTelegramCommand, handleTelegramCallback);
      }
      const gatewayChanged =
        config.gatewayDiscover !== current.gateway.discover ||
        config.gatewayMode !== current.gateway.mode;
      config.gatewayDiscover = current.gateway.discover;
      config.gatewayMode = current.gateway.mode;
      if (gatewayChanged) await gateway.reload(false);
    });
  await applySettings();
  const unsubscribeApprovals = approvals.onRequest(async (request) => {
    const delivery = await telegram?.sendApproval(request);
    if (delivery && !delivery.ok)
      log({ event: 'telegram_delivery_error', message: delivery.message ?? 'Delivery failed' });
  });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const localHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

  app.use((req, res, next) => {
    const host = req.headers.host?.toLowerCase();
    if (!host || (!localHosts.has(host) && host !== new URL(config.publicUrl).host)) {
      res.status(403).json({ error: 'Unrecognized Host' });
      return;
    }
    const origin = req.headers.origin;
    const origins = new Set([
      config.publicUrl,
      config.localUrl,
      `http://localhost:${config.port}`,
      ...config.allowedOrigins,
    ]);
    if (origin && !origins.has(origin)) {
      res.status(403).json({ error: 'Unrecognized Origin' });
      return;
    }
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.set(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
      );
      res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  /**
   * Resolves the caller and what it may do.
   *
   * Shared tokens are checked first, because they carry a narrower permission set than
   * the owner's static token and than an OAuth grant. The owner token and OAuth grants
   * always receive the full permission set.
   */
  const resolveCaller = async (presented: string): Promise<Caller> => {
    const shared = tokens.find(presented);
    if (shared) {
      await tokens.touch(shared.id);
      const record = tokens.list().find((candidate) => candidate.id === shared.id);
      return {
        id: shared.id,
        permissions: shared.permissions,
        tokenName: record?.name ?? shared.id,
      };
    }
    const info = await auth.verifyAccessToken(presented);
    return { id: info.clientId, permissions: [...allPermissions] };
  };

  const authenticate: RequestHandler = async (req, res, next) => {
    const match = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/i.exec(req.headers.authorization ?? '');
    try {
      if (!match?.[1]) throw new InvalidTokenError('A Bearer token is required');
      const caller = await resolveCaller(match[1]);
      req.auth = {
        token: match[1],
        clientId: caller.id,
        scopes: [scope],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
      res.locals.caller = caller;
      next();
    } catch (error) {
      if (!(error instanceof InvalidTokenError)) {
        next(error);
        return;
      }
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp", scope="${scope}"`,
      );
      res.status(401).json({ error: 'invalid_token' });
    }
  };

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'pc-mcp-tunnel' });
  });
  app.get('/', (_req, res) => {
    res
      .type('text')
      .send(
        'PC MCP Tunnel is running. MCP endpoint: /mcp. Authentication: OAuth or Authorization: Bearer <MCP_TOKEN>.',
      );
  });

  const admin: RequestHandler = (req, res, next) => {
    const match = /^Bearer ([A-Za-z0-9_-]{1,512})$/i.exec(req.headers.authorization ?? '');
    if (!match?.[1] || !secretEqual(match[1], config.adminToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
  app.get('/_control/status', admin, (_req, res) => {
    res.json(options.status?.() ?? { service: 'pc-mcp-tunnel', publicUrl: config.publicUrl });
  });
  const owner: OwnerSecrets = {
    bearerToken: config.bearerToken,
    adminToken: config.adminToken,
    envFile: path.join(config.projectDir, '.env'),
  };

  /**
   * Control plane for the desktop app, on its own loopback listener.
   *
   * Kept off the public listener entirely: the tunnel can never reach this port, and a
   * leaked admin secret cannot be used from outside the machine.
   */
  const controlApp = express();
  controlApp.disable('x-powered-by');
  controlApp.use((req, res, next) => {
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    if (
      !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) ||
      (origin && origin !== `http://${host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      res.status(403).json({
        error: 'invalid_origin',
        message: 'Доступ разрешён только из локального приложения.',
      });
      return;
    }
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  controlApp.get('/_control/bootstrap', (_req, res) => {
    res.json({ service: 'pc-mcp-tunnel', adminToken: config.adminToken });
  });
  controlApp.use('/_control/api', express.json({ limit: '256kb' }));
  controlApp.use(
    '/_control/api',
    controlRouter({
      tokens,
      approvals,
      audit,
      settings,
      gateway,
      processes,
      telegram: () => telegram,
      applySettings,
      owner,
      publicUrl: () => config.publicUrl,
      connection: () => connectionView(config, options.status?.()),
      capabilities: { shell: config.shellEnabled, screenshots: config.screenshotsEnabled },
      startedAt,
      log,
      autostart: options.autostart ?? new Autostart(config.projectDir, config.dataDir),
      rotateToken:
        options.rotateToken ??
        (async (kind) => (kind === 'owner' ? config.bearerToken : config.adminToken)),
      restartTunnel: options.restartTunnel ?? (async () => ({ url: config.publicUrl })),
      restartServer: options.restartServer ?? (() => undefined),
    }),
  );
  controlApp.use('/ui', (_req, res, next) => {
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  });
  controlApp.use(
    '/ui',
    express.static(uiDir, { index: 'index.html', dotfiles: 'deny', maxAge: 0 }),
  );
  controlApp.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  controlApp.use(controlErrorHandler(log));

  app.post('/_control/shutdown', admin, (_req, res) => {
    if (!options.shutdown) {
      res.status(409).json({ error: 'Shutdown is unavailable in embedded mode' });
      return;
    }
    res.json({ stopping: true });
    setImmediate(options.shutdown);
  });

  app.post(
    '/oauth/approve',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    express.urlencoded({ extended: false, limit: '8kb' }),
    (req, res) => {
      auth.approve(req, res);
    },
  );
  app.use('/register', express.json({ limit: '32kb' }));
  const makeRouter = () =>
    mcpAuthRouter({
      provider: auth,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: new URL(auth.resource),
      scopesSupported: [scope],
      resourceName: 'PC development tools',
      clientRegistrationOptions: { clientSecretExpirySeconds: 365 * 24 * 3600 },
    });
  let authRouter = makeRouter();
  // Some clients first probe the non-path-specific metadata location.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: auth.resource,
      authorization_servers: [new URL(config.publicUrl).href],
      scopes_supported: [scope],
      bearer_methods_supported: ['header'],
    });
  });
  app.use((req, res, next) => authRouter(req, res, next));

  app.use(
    '/mcp',
    rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }),
    authenticate,
  );
  app.post(
    '/mcp',
    express.json({ limit: config.maxFileBytes * 2 + 65536 }),
    async (req, res, next) => {
      const server = createMcpServer(
        { config, files, processes, log, gateway, approvals, audit, settings },
        res.locals.caller as Caller,
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once('close', () => {
        void server
          .close()
          .catch((error: unknown) =>
            log({ event: 'transport_close_error', message: errorMessage(error) }),
          );
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        next(error);
      }
    },
  );
  app.all('/mcp', (_req, res) => {
    res
      .set('Allow', 'POST, OPTIONS')
      .status(405)
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Use Streamable HTTP POST with JSON responses; SSE sessions are not used',
        },
        id: null,
      });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof OAuthError) {
      res.status(400).json(error.toResponseObject());
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'request_too_large' });
      return;
    }
    log({ event: 'http_error', message: errorMessage(error) });
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(errorHandler);

  return {
    app,
    controlApp,
    files,
    processes,
    auth,
    gateway,
    approvals,
    tokens,
    settings,
    audit,
    get telegram() {
      return telegram;
    },
    setPublicUrl(url: string) {
      config.publicUrl = validatePublicUrl(url);
      authRouter = makeRouter();
    },
    close: async () => {
      approvals.cancelAll('The server stopped');
      unsubscribeApprovals();
      await telegram?.stop();
      const results = await Promise.allSettled([processes.shutdown(), gateway.close()]);
      const errors = results.filter((result) => result.status === 'rejected');
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          'Service shutdown failed',
        );
    },
  };
}
