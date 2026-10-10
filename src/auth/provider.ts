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
import type { Permission } from '../permissions.js';
import type { Logger } from '../tools.js';
import { hash, secretEqual, token } from '../utils.js';
import { consentErrorPage, consentPage } from './consent.js';
import { AuthStore, type Authorization, type Grant, type GrantBinding } from './store.js';

export const scope = 'pc:access';
const accessLifetime = 3600;
const grantLifetime = 30 * 24 * 3600 * 1000;
const authorizationLifetime = 30 * 60 * 1000;

/** Resolves access tokens for authorization and re-checks the ones a grant is bound to. */
export interface AccessBinding {
  resolve(presented: string): GrantBinding | undefined;
  verify(binding: GrantBinding): Permission[] | undefined;
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

  constructor(
    private readonly config: Config,
    private readonly store: AuthStore,
    private readonly access: AccessBinding,
    private readonly log: Logger = () => undefined,
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

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.validateResource(params.resource);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError('A valid S256 PKCE challenge is required');
    if (!client.redirect_uris.some((uri) => redirectUriMatches(params.redirectUri, uri)))
      throw new InvalidRequestError('Unregistered redirect URI');
    // Unknown scope names are dropped rather than refused: the grant only ever carries
    // the scopes this server understands, so a client that bundles extras still works.
    const requested = params.scopes?.filter((requested) => requested === scope) ?? [];
    const scopes = requested.length ? requested : [scope];
    const id = token();
    const csrf = token();
    await this.store.transaction((draft) => {
      if (Object.keys(draft.pending).length >= 128)
        throw new TooManyRequestsError('Too many pending authorizations');
      draft.pending[id] = {
        clientId: client.client_id,
        params: { ...params, scopes, resource: this.resource },
        csrf,
        expiresAt: Date.now() + authorizationLifetime,
      };
    });
    res.cookie(this.cookieName(id), csrf, {
      httpOnly: true,
      secure: this.config.publicUrl.startsWith('https:'),
      sameSite: 'lax',
      path: '/oauth/approve',
      maxAge: authorizationLifetime,
    });
    this.log({
      event: 'oauth_consent_shown',
      client: client.client_name ?? client.client_id,
      client_id: client.client_id,
    });
    this.renderConsent(res, id, client.client_name ?? client.client_id, params.redirectUri);
  }

  private renderConsent(
    res: Response,
    id: string,
    client: string,
    redirectUri: string,
    error?: string,
  ): void {
    const nonce = token();
    res
      .status(error ? 401 : 200)
      .set(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self' ${new URL(redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
      )
      .type('html')
      .send(consentPage(id, client, redirectUri, nonce, error));
  }

  private cookieName(id: string): string {
    return `pc_mcp_${id.slice(0, 16)}`;
  }

  /** Renders a readable page in the browser instead of a raw JSON error. */
  private refuse(res: Response, title: string, detail: string, status = 400): void {
    const nonce = token();
    res
      .status(status)
      .set(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
      )
      .type('html')
      .send(consentErrorPage(title, detail, nonce));
  }

  async approve(req: Request, res: Response): Promise<void> {
    const id: unknown = req.body?.request_id;
    if (typeof id !== 'string') throw new InvalidRequestError('Missing authorization request');
    const pending = this.store.authorization('pending', id);
    if (!pending || pending.params.resource !== this.resource) {
      this.log({ event: 'oauth_consent_expired' });
      this.refuse(
        res,
        'Подключение истекло',
        'Эта вкладка уже не действует. Закройте её и нажмите «Подключить» в приложении ещё раз — откроется новая страница подтверждения.',
      );
      return;
    }
    const prefix = `${this.cookieName(id)}=`;
    const cookie = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length);
    if (!cookie || !secretEqual(cookie, pending.csrf)) {
      this.log({ event: 'oauth_consent_rejected', reason: 'browser_session' });
      this.refuse(
        res,
        'Сессия браузера не совпала',
        'Форма подтверждения пришла не из того окна браузера, которое её открыло. Закройте эту вкладку и начните подключение заново из приложения.',
      );
      return;
    }
    const denied = req.body?.deny === 'yes';
    const presented: unknown = denied ? '' : req.body?.access_token;
    const binding =
      typeof presented === 'string' && presented ? this.access.resolve(presented) : undefined;
    if (!denied && !binding) {
      this.log({ event: 'oauth_consent_rejected', reason: 'token' });
      const client = await this.clientsStore.getClient(pending.clientId);
      this.renderConsent(
        res,
        id,
        client?.client_name ?? pending.clientId,
        pending.params.redirectUri,
        'Введите действующий ключ из раздела «Доступ» и повторите подтверждение.',
      );
      return;
    }
    const destination = new URL(pending.params.redirectUri);
    const code = token();
    try {
      await this.store.transaction((draft) => {
        if (!draft.pending[id] || draft.pending[id].params.resource !== this.resource)
          throw new InvalidGrantError('Consent was already consumed');
        if (!denied) {
          if (!binding || !this.access.verify(binding))
            throw new InvalidGrantError('The authorizing token is no longer active');
          if (Object.keys(draft.codes).length >= 128)
            throw new TooManyRequestsError('Too many pending authorization codes');
          draft.codes[hash(code)] = {
            ...pending,
            binding,
            expiresAt: Date.now() + 2 * 60 * 1000,
          };
        }
        delete draft.pending[id];
      });
    } catch (error) {
      if (!(error instanceof InvalidGrantError)) throw error;
      this.refuse(res, 'Подключение истекло', 'Начните подключение заново из приложения.');
      return;
    }
    res.clearCookie(this.cookieName(id), { path: '/oauth/approve' });
    destination.searchParams.set(denied ? 'error' : 'code', denied ? 'access_denied' : code);
    this.log({
      event: denied ? 'oauth_consent_denied' : 'oauth_consent_approved',
      client_id: pending.clientId,
      token_name: binding?.name,
    });
    if (pending.params.state !== undefined)
      destination.searchParams.set('state', pending.params.state);
    res.redirect(303, destination.href);
  }

  private getCode(client: OAuthClientInformationFull, authorizationCode: string): Authorization {
    const pending = this.store.authorization('codes', hash(authorizationCode));
    if (
      !pending ||
      pending.clientId !== client.client_id ||
      pending.params.resource !== this.resource
    )
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
    this.validateResource(resource);
    const access = token();
    const refresh = token();
    const pending = await this.store.transaction((draft) => {
      const pending = draft.codes[hash(authorizationCode)];
      if (!pending || pending.clientId !== client.client_id)
        throw new InvalidGrantError('Invalid or expired authorization code');
      if (
        pending.params.resource !== this.resource ||
        (redirectUri !== undefined && redirectUri !== pending.params.redirectUri)
      )
        throw new InvalidGrantError('Authorization binding mismatch');
      if (!pending.binding || !this.access.verify(pending.binding))
        throw new InvalidGrantError('The authorizing token is no longer active');
      if (draft.grants.length >= 256)
        throw new TooManyRequestsError('Authorization capacity reached');
      draft.grants.push({
        id: token(),
        clientId: client.client_id,
        scopes: pending.params.scopes,
        resource: this.resource,
        expiresAt: Date.now() + grantLifetime,
        accessHash: hash(access),
        accessExpiresAt: Date.now() + accessLifetime * 1000,
        refreshHash: hash(refresh),
        usedRefreshHashes: [],
        binding: pending.binding,
      });
      delete draft.codes[hash(authorizationCode)];
      return pending;
    });
    this.log({
      event: 'oauth_grant_issued',
      client_id: client.client_id,
      token_name: pending.binding?.name,
    });
    return this.tokens(access, refresh, pending.params.scopes);
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
      if (!grant.binding || !this.access.verify(grant.binding))
        throw new InvalidGrantError('The authorizing token is no longer active');
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
    const digest = hash(accessToken);
    const grant = this.store.accessGrant(digest);
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      grant.accessExpiresAt <= Date.now() ||
      grant.resource !== this.resource
    )
      throw new InvalidTokenError('Invalid or expired access token');
    const permissions = grant.binding ? this.access.verify(grant.binding) : undefined;
    if (!permissions)
      throw new InvalidTokenError(
        'The access token that authorized this client is no longer active',
      );
    return {
      token: accessToken,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(grant.accessExpiresAt / 1000),
      resource: new URL(grant.resource),
      extra: {
        callerId: `oauth:${grant.id}`,
        tokenId: grant.binding!.tokenId,
        tokenName: grant.binding!.name,
        permissions,
      },
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
