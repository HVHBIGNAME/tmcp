import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { atomicWrite, isErrno, SerialQueue } from '../utils.js';

const bindingSchema = z.object({
  tokenId: z.string(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string(),
});

const grantSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  resource: z.string(),
  expiresAt: z.number(),
  accessHash: z.string(),
  accessExpiresAt: z.number(),
  refreshHash: z.string(),
  usedRefreshHashes: z.array(z.string()),
  /** The access token that authorized this client; the grant never outlives it. */
  binding: bindingSchema.optional(),
});

const authorizationSchema = z.object({
  clientId: z.string(),
  params: z.object({
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    redirectUri: z.url(),
    scopes: z.array(z.string()),
    state: z.string().optional(),
    resource: z.url(),
  }),
  expiresAt: z.number().finite(),
  csrf: z.string().min(32),
  binding: bindingSchema.optional(),
});

/** Identifies the access token an OAuth grant was authorized with. */
export type GrantBinding = z.infer<typeof bindingSchema>;
export type Authorization = z.infer<typeof authorizationSchema>;

const storeSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  clients: z.array(OAuthClientInformationFullSchema),
  grants: z.array(grantSchema),
  flowStateVersion: z.literal(1).optional(),
  pending: z.record(z.string(), authorizationSchema).default({}),
  codes: z.record(z.string(), authorizationSchema).default({}),
});

export type Grant = z.infer<typeof grantSchema>;
type StoreData = z.infer<typeof storeSchema>;

export class AuthStore {
  private readonly writes = new SerialQueue();

  private constructor(
    private readonly filename: string,
    private data: StoreData,
  ) {}

  static async open(dataDir: string): Promise<AuthStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(dataDir, 'oauth.json');
    let data: StoreData;
    try {
      data = storeSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if (!isErrno(error, 'ENOENT'))
        throw new Error('Cannot read OAuth store; refusing to reset existing credentials', {
          cause: error,
        });
      data = {
        version: 2,
        clients: [],
        grants: [],
        pending: {},
        codes: {},
      };
    }
    if (!data.flowStateVersion) {
      try {
        const legacy = z
          .object({ pending: z.record(z.string(), authorizationSchema) })
          .parse(JSON.parse(await readFile(path.join(dataDir, 'oauth-pending.json'), 'utf8')));
        // Old codes had no credential fingerprint. Only migrate pages that still require
        // a fresh credential proof; redemption now commits alongside the resulting grant.
        data.pending = Object.fromEntries(
          Object.entries(legacy.pending).filter(
            ([, entry]) =>
              entry.expiresAt > Date.now() &&
              data.clients.some((client) => client.client_id === entry.clientId),
          ),
        );
      } catch (error) {
        if (!isErrno(error, 'ENOENT'))
          throw new Error('Cannot migrate pending OAuth confirmations', { cause: error });
      }
    }
    const store = new AuthStore(filename, data);
    await store.transaction((draft) => {
      // Only UUIDs issued by TokenStore can bind grants. Retire legacy owner and
      // unbound grants without touching the user's client keys or bound grants.
      const issuedKey = (binding?: GrantBinding) => z.uuid().safeParse(binding?.tokenId).success;
      draft.grants = draft.grants.filter((grant) => issuedKey(grant.binding));
      draft.codes = Object.fromEntries(
        Object.entries(draft.codes).filter(([, entry]) => issuedKey(entry.binding)),
      );
      draft.version = 2;
      draft.flowStateVersion = 1;
    });
    return store;
  }

  snapshot(): StoreData {
    return structuredClone(this.data);
  }

  authorization(kind: 'pending' | 'codes', id: string): Authorization | undefined {
    const entry = this.data[kind][id];
    return entry && entry.expiresAt > Date.now() ? structuredClone(entry) : undefined;
  }

  accessGrant(digest: string) {
    const grant = this.data.grants.find((saved) => saved.accessHash === digest);
    if (!grant) return undefined;
    return {
      id: grant.id,
      clientId: grant.clientId,
      scopes: [...grant.scopes],
      resource: grant.resource,
      expiresAt: grant.expiresAt,
      accessExpiresAt: grant.accessExpiresAt,
      binding: grant.binding ? { ...grant.binding } : undefined,
    };
  }

  transaction<T>(operation: (draft: StoreData) => T): Promise<T> {
    return this.writes.run(async () => {
      const draft = structuredClone(this.data);
      draft.grants = draft.grants.filter((grant) => grant.expiresAt > Date.now());
      for (const entries of [draft.pending, draft.codes])
        for (const [id, entry] of Object.entries(entries))
          if (entry.expiresAt <= Date.now()) delete entries[id];
      const result = operation(draft);
      await atomicWrite(this.filename, JSON.stringify(draft));
      this.data = draft;
      return result;
    });
  }
}
