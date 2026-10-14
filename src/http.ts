import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidTokenError, OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { AuthProvider, scope } from './auth/provider.js';
import { AuthStore } from './auth/store.js';
import { validatePublicUrl, type Config } from './config.js';
import { Files } from './files.js';
import { Processes } from './processes.js';
import { createMcpServer, type Caller, type Logger } from './tools.js';
import { errorMessage, hash, SerialQueue } from './utils.js';
import { Workspace } from './workspace.js';
import { Gateway } from './gateway/gateway.js';
import { Approvals, AuditLog } from './approvals.js';
import { TokenStore } from './auth/tokens.js';
import { defaultSettings, SettingsStore, settingsPath } from './settings.js';
import { controlErrorHandler, controlRouter } from './control.js';
import { Telegram } from './telegram.js';
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { consentErrorPage } from './auth/consent.js';
import path from 'node:path';
import { parsePermissions } from './permissions.js';
import { z } from 'zod';
import { connectionView } from './connection.js';
import { autostartFor, type AutostartControl } from './autostart.js';
import { Traffic, type TrafficSpan } from './traffic.js';
import { controlPrivatePaths } from './ipc.js';
import { RequestCancellations } from './request-cancellations.js';
import { requiredPermission } from './tool-contracts.js';
import { toolError } from './tool-result.js';

export interface HttpOptions {
  log?: Logger;
  status?: () => Record<string, unknown>;
  shutdown?: () => void;
  deferGatewayWarmup?: boolean;
  restartTunnel?: (mode: 'quick' | 'named') => Promise<{ url: string }>;
  restartServer?: () => void;
  startedAt?: string;
  telegramApiBase?: string;
  autostart?: AutostartControl;
}

/**
 * Rate-limit key that survives the tunnel.
 *
 * CF-Connecting-IP is set by the Cloudflare edge and cannot be forged by the caller,
 * while X-Forwarded-For is appended to by the tunnel: its first entry is chosen by the
 * client, so keying on it would let anyone reset their own counter with every request.
 * IPv6 addresses collapse to their /64 subnet, so one client cannot rotate through a
 * prefix to get a fresh budget.
 */
const clientKey: Options['keyGenerator'] = (req) => {
  const header = req.headers['cf-connecting-ip'];
  const value = Array.isArray(header) ? header[0] : header;
  const address =
    typeof value === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(value) ? value : (req.ip ?? '');
  return ipKeyGenerator(address, 64) || 'local';
};

export async function createApp(config: Config, options: HttpOptions = {}) {
  let maintenanceUntil = 0;
  const cancellations = new RequestCancellations();
  const log =
    options.log ??
    ((event) => console.log(JSON.stringify({ time: new Date().toISOString(), ...event })));
  const workspace = await Workspace.open(config.roots, [
    path.join(config.projectDir, '.env'),
    config.envFile,
    config.serversFile,
    ...config.configPaths,
    config.dataDir,
    ...(config.desktopExecutable ? [path.dirname(config.envFile), config.desktopExecutable] : []),
    ...(await controlPrivatePaths(config.dataDir)),
  ]);
  const files = new Files(workspace, config.maxFileBytes);
  const processes = new Processes(workspace, config);
  const store = await AuthStore.open(config.dataDir);
  const tokens = await TokenStore.open(config.dataDir);
  const traffic = new Traffic();
  const auth = new AuthProvider(
    config,
    store,
    {
      resolve: (presented) => {
        const found = tokens.find(presented);
        if (found)
          return {
            tokenId: found.id,
            tokenHash: hash(presented),
            name: tokens.list().find((record) => record.id === found.id)?.name ?? found.id,
          };
        return undefined;
      },
      verify: (binding) => tokens.activeById(binding.tokenId, binding.tokenHash),
    },
    log,
  );
  const settings = new SettingsStore(settingsPath(config.dataDir), {
    ...structuredClone(defaultSettings),
    gateway: { discover: config.gatewayDiscover, mode: config.gatewayMode },
  });
  await settings.load();
  config.gatewayDiscover = settings.get().gateway.discover;
  config.gatewayMode = settings.get().gateway.mode;
  const gateway = new Gateway(config, log, (paths) => workspace.protect(paths));
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
  const hostname = (value: string) =>
    value
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();

  /**
   * The paths a browser-based MCP client needs: dynamic registration, the authorization
   * handshake and the resource itself. Authorization is a Bearer token here, never a
   * cookie, so another site cannot borrow the visitor's credentials to call these routes.
   * Control routes are available only over OS-protected IPC.
   */
  const browserSurface = (path: string) =>
    path === '/mcp' ||
    path === '/health' ||
    path === '/register' ||
    path === '/revoke' ||
    path === '/oauth/approve' ||
    path.startsWith('/authorize') ||
    path.startsWith('/token') ||
    path.startsWith('/.well-known/');

  app.use((req, res, next) => {
    const host = req.headers.host?.toLowerCase();
    const known = new Set([...localHosts, new URL(config.publicUrl).host]);
    const configured = hostname(settings.get().tunnel.hostname);
    if (configured) known.add(configured);
    if (!host || !known.has(host)) {
      res.status(403).json({ error: 'Unrecognized Host' });
      return;
    }
    const origin = req.headers.origin;
    const listed =
      origin !== undefined &&
      [
        config.publicUrl,
        config.localUrl,
        `http://localhost:${config.port}`,
        ...config.allowedOrigins,
      ].includes(origin);
    if (origin && !listed && !browserSurface(req.path) && hostname(origin) !== host) {
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
    if (origin && (listed || browserSurface(req.path))) {
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
   * Issued keys and OAuth grants share the same live permission check. Revoking the
   * key that authorized a grant also revokes that client's access.
   */
  const resolveCaller = async (presented: string): Promise<Caller> => {
    const shared = tokens.find(presented);
    if (shared) {
      void tokens
        .touch(shared.id)
        .catch((error: unknown) =>
          log({ event: 'token_usage_write_error', message: errorMessage(error) }),
        );
      const record = tokens.list().find((candidate) => candidate.id === shared.id);
      return {
        id: shared.id,
        tokenId: shared.id,
        permissions: shared.permissions,
        tokenName: record?.name ?? shared.id,
      };
    }
    const info = await auth.verifyAccessToken(presented);
    const granted = info.extra?.permissions;
    const tokenId = typeof info.extra?.tokenId === 'string' ? info.extra.tokenId : undefined;
    if (tokenId)
      void tokens
        .touch(tokenId)
        .catch((error: unknown) =>
          log({ event: 'token_usage_write_error', message: errorMessage(error) }),
        );
    return {
      id: typeof info.extra?.callerId === 'string' ? info.extra.callerId : info.clientId,
      tokenId,
      permissions: Array.isArray(granted) ? parsePermissions(granted) : [],
      tokenName: typeof info.extra?.tokenName === 'string' ? info.extra.tokenName : info.clientId,
    };
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
      (res.locals.traffic as TrafficSpan | undefined)?.authorized(caller);
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
        'PC MCP Tunnel is running. MCP endpoint: /mcp. Use a key issued in Access, directly as a Bearer token or to authorize OAuth.',
      );
  });

  /** TCP connections are rejected even if an embedder mounts this app on a port. */
  const controlApp = express();
  controlApp.disable('x-powered-by');
  controlApp.use((req, res, next) => {
    if (
      req.socket.remoteAddress !== undefined ||
      req.headers.host !== 'tmcp.local' ||
      req.headers.origin !== undefined ||
      req.headers['sec-fetch-site'] !== undefined
    ) {
      res.status(403).json({
        error: 'invalid_origin',
        message: 'Управление доступно только через локальный IPC.',
      });
      return;
    }
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  controlApp.get('/_control/bootstrap', (_req, res) => {
    res.json({ service: 'pc-mcp-tunnel' });
  });
  controlApp.get('/_control/status', (_req, res) => {
    res.json(options.status?.() ?? { service: 'pc-mcp-tunnel', publicUrl: config.publicUrl });
  });
  controlApp.post('/_control/shutdown', (_req, res) => {
    if (!options.shutdown) {
      res.status(409).json({ error: 'Shutdown is unavailable in embedded mode' });
      return;
    }
    res.json({ stopping: true });
    setImmediate(options.shutdown);
  });
  controlApp.use('/_control/api', express.json({ limit: '256kb' }));
  controlApp.use(
    '/_control/api',
    controlRouter({
      tokens,
      approvals,
      audit,
      traffic,
      settings,
      gateway,
      processes,
      telegram: () => telegram,
      applySettings,
      publicUrl: () => config.publicUrl,
      connection: () => connectionView(config, options.status?.()),
      capabilities: { shell: config.shellEnabled, screenshots: config.screenshotsEnabled },
      startedAt,
      log,
      autostart: options.autostart ?? autostartFor(config),
      maintenance: () => Date.now() < maintenanceUntil,
      setMaintenance: (enabled) => {
        maintenanceUntil = enabled ? Date.now() + 60000 : 0;
      },
      restartTunnel: options.restartTunnel ?? (async () => ({ url: config.publicUrl })),
      restartServer: options.restartServer ?? (() => undefined),
    }),
  );
  controlApp.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  controlApp.use(controlErrorHandler(log));

  const limiter = (limit: number, windowMs: number) =>
    rateLimit({
      windowMs,
      limit,
      keyGenerator: clientKey,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    });
  app.use(['/authorize', '/token', '/revoke', '/oauth/approve'], (req, res, next) => {
    const route = req.baseUrl;
    res.once('finish', () =>
      log({
        event: 'oauth_request',
        path: route,
        method: req.method,
        status: res.statusCode,
      }),
    );
    next();
  });
  // The SDK rate limits its own handlers on request.ip, which the tunnel makes
  // client-controlled through X-Forwarded-For. These run first, keyed on an address the
  // caller cannot forge, so the authorization endpoints stay bounded from the internet.
  app.use(['/token', '/authorize', '/revoke'], limiter(60, 15 * 60 * 1000));
  app.post(
    '/oauth/approve',
    limiter(10, 15 * 60 * 1000),
    express.urlencoded({ extended: false, limit: '8kb' }),
    async (req, res) => {
      await auth.approve(req, res);
    },
  );
  // Registration is public by design, so it is bounded: a client is only ever registered
  // once per integration.
  app.use('/register', limiter(20, 15 * 60 * 1000), express.json({ limit: '32kb' }));
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
    (_req, res, next) => {
      if (Date.now() < maintenanceUntil) {
        res.status(503).set('Retry-After', '15').json({
          error: 'temporarily_unavailable',
          message: 'TMCP is installing an update. Retry shortly.',
        });
        return;
      }
      next();
    },
    (req, res, next) => {
      const span = traffic.begin(req.method);
      res.locals.traffic = span;
      res.once('finish', () => span.finish(res.statusCode, true));
      res.once('close', () => span.finish(res.statusCode, res.writableFinished));
      next();
    },
    limiter(300, 60000),
    authenticate,
  );
  app.post(
    '/mcp',
    express.json({ limit: config.maxFileBytes * 2 + 65536 }),
    async (req, res, next) => {
      const span = res.locals.traffic as TrafficSpan;
      span.describe(req.body?.method, req.body?.params?.name);
      const caller = res.locals.caller as Caller;
      const toolName = req.body?.params?.name;
      const permission = typeof toolName === 'string' ? requiredPermission(toolName) : undefined;
      if (
        req.body?.method === 'tools/call' &&
        permission &&
        !caller.permissions.includes(permission)
      ) {
        span.deny();
        if (settings.get().logging.enabled)
          await audit
            .write({
              at: new Date().toISOString(),
              actor: caller.tokenName ?? caller.id,
              clientId: caller.id,
              kind: toolName.includes('command') ? 'command' : 'file',
              action: toolName,
              detail: '',
              outcome: 'denied',
              durationMs: null,
            })
            .catch((error) => log({ event: 'audit_write_error', message: errorMessage(error) }));
        res.json({
          jsonrpc: '2.0',
          id: req.body.id ?? null,
          result: toolError(
            new Error(
              `Access denied: ${toolName} needs the "${permission}" permission, which this token does not have. The owner can grant it in PC MCP under Access.`,
            ),
          ),
        });
        return;
      }
      if (
        req.body?.jsonrpc === '2.0' &&
        req.body?.method === 'notifications/cancelled' &&
        req.body.id === undefined
      ) {
        cancellations.cancel(caller.id, req.body.params?.requestId);
        res.status(202).end();
        return;
      }
      const execution = cancellations.track(
        caller.id,
        req.body?.method === 'tools/call' ? req.body.id : undefined,
      );
      res.once('finish', execution.finish);
      res.once('close', () => {
        if (!res.writableFinished) execution.abort();
        execution.finish();
      });
      const server = createMcpServer(
        {
          config,
          files,
          processes,
          log,
          gateway,
          approvals,
          audit,
          settings,
          traffic: span,
          signal: execution.signal,
        },
        caller,
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const send = transport.send.bind(transport);
      transport.send = (message, options) => {
        if ('error' in message) span.result(true);
        if ('result' in message && message.result.isError === true) span.result(true);
        return send(message, options);
      };
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
  const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof OAuthError) {
      log({
        event: 'oauth_request_rejected',
        path: req.path,
        client_id:
          typeof req.query.client_id === 'string' ? req.query.client_id.slice(0, 8) : undefined,
        reason: error.errorCode,
        message: error.message,
      });
      // The authorization page is shown to a person in a browser window, so a rejection
      // has to read as a page. A machine-facing endpoint keeps the JSON body.
      if (req.path.startsWith('/authorize')) {
        const nonce = randomUUID().replaceAll('-', '');
        res
          .status(400)
          .set(
            'Content-Security-Policy',
            `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
          )
          .type('html')
          .send(
            consentErrorPage(
              'Подключение не удалось начать',
              'Приложение отправило запрос, который этот сервер не принимает. Обновите приложение или подключите сервер напрямую по адресу и токену, без OAuth.',
              nonce,
            ),
          );
        return;
      }
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

  let closing: Promise<void> | undefined;
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
    traffic,
    get telegram() {
      return telegram;
    },
    setPublicUrl(url: string) {
      config.publicUrl = validatePublicUrl(url);
      authRouter = makeRouter();
    },
    close: () =>
      (closing ??= (async () => {
        traffic.close();
        cancellations.close();
        approvals.cancelAll('The server stopped');
        unsubscribeApprovals();
        const results = await Promise.allSettled([
          telegram?.stop(),
          processes.shutdown(),
          gateway.close(),
          audit.flush(),
          tokens.flushUsage(),
        ]);
        const errors = results.filter((result) => result.status === 'rejected');
        if (errors.length)
          throw new AggregateError(
            errors.map((result) => result.reason),
            'Service shutdown failed',
          );
      })()),
  };
}
