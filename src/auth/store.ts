import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { atomicWrite, hash, isErrno, SerialQueue } from '../utils.js';

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
});

const storeSchema = z.object({
  version: z.literal(1),
  adminFingerprint: z.string(),
  clients: z.array(OAuthClientInformationFullSchema),
  grants: z.array(grantSchema),
});

export type Grant = z.infer<typeof grantSchema>;
type StoreData = z.infer<typeof storeSchema>;

export class AuthStore {
  private readonly writes = new SerialQueue();

  private constructor(
    private readonly filename: string,
    private data: StoreData,
  ) {}

  static async open(dataDir: string, adminToken: string): Promise<AuthStore> {
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
      data = { version: 1, adminFingerprint: hash(adminToken), clients: [], grants: [] };
    }
    const store = new AuthStore(filename, data);
    await store.transaction((draft) => {
      if (draft.adminFingerprint !== hash(adminToken)) {
        draft.grants = [];
        draft.adminFingerprint = hash(adminToken);
      }
    });
    return store;
  }

  snapshot(): StoreData {
    return structuredClone(this.data);
  }

  transaction<T>(operation: (draft: StoreData) => T): Promise<T> {
    return this.writes.run(async () => {
      const draft = structuredClone(this.data);
      draft.grants = draft.grants.filter((grant) => grant.expiresAt > Date.now());
      const result = operation(draft);
      await atomicWrite(this.filename, JSON.stringify(draft));
      this.data = draft;
      return result;
    });
  }
}
