import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { Config } from '../config.js';
import { hash, secretEqual, token } from '../utils.js';
import { consentPage } from './consent.js';
import { AuthStore, type Grant } from './store.js';

export const scope = 'pc:access';
const accessLifetime = 3600;
const grantLifetime = 30 * 24 * 3600 * 1000;

interface PendingAuthorization {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
  csrf: string;
}

function validateRedirect(uri: string): void {
  const url = new URL(uri);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  ) {
    throw new InvalidClientMetadataError(
      'redirect_uris must use HTTPS or loopback HTTP, without credentials or fragments',
    );
  }
}

export class AuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, PendingAuthorization>();

  constructor(
    private readonly config: Config,
    private readonly store: AuthStore,
  ) {
    this.clientsStore = {
      getClient: (id) => this.store.snapshot().clients.find((client) => client.client_id === id),
      registerClient: async (client) => {
        const registered = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        if (!client.redirect_uris.length || client.redirect_uris.length > 10)
          throw new InvalidClientMetadataError('Provide 1–10 redirect URIs');
        client.redirect_uris.forEach(validateRedirect);
        if (
          !['none', 'client_secret_post', 'client_secret_basic'].includes(
            client.token_endpoint_auth_method ?? 'client_secret_post',
          )
        ) {
          throw new InvalidClientMetadataError('Unsupported token authentication method');
        }
        return this.store.transaction((draft) => {
          const active = new Set(draft.grants.map((grant) => grant.clientId));
          draft.clients = draft.clients.filter(
            (saved) =>
              active.has(saved.client_id) ||
              (saved.client_id_issued_at ?? 0) > Date.now() / 1000 - 3600,
          );
          if (draft.clients.length >= 128)
            throw new TooManyRequestsError('Client registration capacity reached');
          draft.clients.push(registered);
          return registered;
        });
      },
    };
  }

  get resource(): string {
    return `${this.config.publicUrl}/mcp`;
  }

  private validateResource(resource?: URL): void {
    if (resource && resource.href !== this.resource)
      throw new InvalidTargetError('Unknown MCP resource');
  }

  private prune(): void {
    for (const entries of [this.pending, this.codes]) {
      for (const [key, value] of entries) if (value.expiresAt <= Date.now()) entries.delete(key);
    }
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.prune();
    this.validateResource(params.resource);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError('A valid S256 PKCE challenge is required');
    if (!client.redirect_uris.some((uri) => redirectUriMatches(params.redirectUri, uri)))
      throw new InvalidRequestError('Unregistered redirect URI');
    const scopes = params.scopes?.length ? params.scopes : [scope];
    if (scopes.some((requested) => requested !== scope))
      throw new InvalidScopeError('Unknown scope');
    if (this.pending.size >= 128) throw new TooManyRequestsError('Too many pending authorizations');
    const id = token();
    const csrf = token();
    const nonce = token();
    this.pending.set(id, {
      clientId: client.client_id,
      params: { ...params, scopes, resource: new URL(this.resource) },
      csrf,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    res.cookie(this.cookieName(id), csrf, {
      httpOnly: true,
      secure: this.config.publicUrl.startsWith('https:'),
      sameSite: 'lax',
      path: '/oauth/approve',
      maxAge: 10 * 60 * 1000,
    });
    res.set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    res
      .type('html')
      .send(consentPage(id, client.client_name ?? client.client_id, params.redirectUri, nonce));
  }

  private cookieName(id: string): string {
    return `pc_mcp_${id.slice(0, 16)}`;
  }

  approve(req: Request, res: Response): void {
    this.prune();
    const id: unknown = req.body?.request_id;
    if (typeof id !== 'string') throw new InvalidRequestError('Missing authorization request');
    const pending = this.pending.get(id);
    if (!pending)
      throw new InvalidRequestError('Authorization expired; reconnect from the MCP client');
    const prefix = `${this.cookieName(id)}=`;
    const cookie = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length);
    if (!cookie || !secretEqual(cookie, pending.csrf))
      throw new InvalidRequestError('Invalid browser session; restart authorization');
    const denied = req.body?.deny === 'yes';
    if (
      !denied &&
      (typeof req.body?.admin_token !== 'string' ||
        !secretEqual(req.body.admin_token, this.config.adminToken))
    ) {
      res
        .status(401)
        .type('text')
        .send('Неверный MCP_ADMIN_TOKEN. Вернитесь назад и повторите вход.');
      return;
    }
    this.pending.delete(id);
    res.clearCookie(this.cookieName(id), { path: '/oauth/approve' });
    const destination = new URL(pending.params.redirectUri);
    if (denied) destination.searchParams.set('error', 'access_denied');
    else {
      const code = token();
      this.codes.set(hash(code), { ...pending, expiresAt: Date.now() + 2 * 60 * 1000 });
      destination.searchParams.set('code', code);
    }
    if (pending.params.state !== undefined)
      destination.searchParams.set('state', pending.params.state);
    res.redirect(303, destination.href);
  }

  private getCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): PendingAuthorization {
    this.prune();
    const pending = this.codes.get(hash(authorizationCode));
    if (!pending || pending.clientId !== client.client_id)
      throw new InvalidGrantError('Invalid or expired authorization code');
    return pending;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.getCode(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const pending = this.getCode(client, authorizationCode);
    this.validateResource(resource);
    if (
      pending.params.resource?.href !== this.resource ||
      (redirectUri !== undefined && redirectUri !== pending.params.redirectUri)
    )
      throw new InvalidGrantError('Authorization binding mismatch');
    // No await before consumption: concurrent exchanges cannot redeem the same code twice.
    this.codes.delete(hash(authorizationCode));
    const access = token();
    const refresh = token();
    await this.store.transaction((draft) => {
      if (draft.grants.length >= 256)
        throw new TooManyRequestsError('Authorization capacity reached');
      draft.grants.push({
        id: token(),
        clientId: client.client_id,
        scopes: pending.params.scopes ?? [scope],
        resource: this.resource,
        expiresAt: Date.now() + grantLifetime,
        accessHash: hash(access),
        accessExpiresAt: Date.now() + accessLifetime * 1000,
        refreshHash: hash(refresh),
        usedRefreshHashes: [],
      });
    });
    return this.tokens(access, refresh, pending.params.scopes ?? [scope]);
  }

  private tokens(access: string, refresh: string, scopes: string[]): OAuthTokens {
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: accessLifetime,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.validateResource(resource);
    const digest = hash(refreshToken);
    const access = token();
    const refresh = token();
    const granted = await this.store.transaction((draft) => {
      const replay = draft.grants.find(
        (grant) => grant.clientId === client.client_id && grant.usedRefreshHashes.includes(digest),
      );
      if (replay) {
        draft.grants = draft.grants.filter((grant) => grant.id !== replay.id);
        return null;
      }
      const grant = draft.grants.find(
        (saved) =>
          saved.clientId === client.client_id &&
          saved.refreshHash === digest &&
          saved.resource === this.resource,
      );
      if (!grant) throw new InvalidGrantError('Invalid or expired refresh token');
      if (scopes?.some((requested) => !grant.scopes.includes(requested)))
        throw new InvalidScopeError('Refresh cannot expand scopes');
      grant.usedRefreshHashes.push(grant.refreshHash);
      // Bound per-grant storage even if a client refreshes much more often than once an hour.
      if (grant.usedRefreshHashes.length > 2048) {
        draft.grants = draft.grants.filter((saved) => saved.id !== grant.id);
        return null;
      }
      grant.accessHash = hash(access);
      grant.refreshHash = hash(refresh);
      grant.accessExpiresAt = Math.min(Date.now() + accessLifetime * 1000, grant.expiresAt);
      if (scopes) grant.scopes = scopes;
      return grant;
    });
    if (!granted) throw new InvalidGrantError('Refresh token reuse detected; authorize again');
    return {
      ...this.tokens(access, refresh, granted.scopes),
      expires_in: Math.max(0, Math.floor((granted.accessExpiresAt - Date.now()) / 1000)),
    };
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    if (secretEqual(accessToken, this.config.bearerToken))
      return {
        token: accessToken,
        clientId: 'static-token',
        scopes: [scope],
        resource: new URL(this.resource),
      };
    const digest = hash(accessToken);
    const grant = this.store.snapshot().grants.find((saved) => saved.accessHash === digest);
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      grant.accessExpiresAt <= Date.now() ||
      grant.resource !== this.resource
    )
      throw new InvalidTokenError('Invalid or expired access token');
    return {
      token: accessToken,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(grant.accessExpiresAt / 1000),
      resource: new URL(grant.resource),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const digest = hash(request.token);
    const matches = (grant: Grant) =>
      grant.accessHash === digest ||
      grant.refreshHash === digest ||
      grant.usedRefreshHashes.includes(digest);
    await this.store.transaction((draft) => {
      draft.grants = draft.grants.filter(
        (grant) => grant.clientId !== client.client_id || !matches(grant),
      );
    });
  }
}
