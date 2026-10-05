import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthInfo;
  }
}
