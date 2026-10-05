import type { Config } from './config.js';

export type ConnectionStatus = 'starting' | 'connected' | 'reconnecting' | 'error' | 'local';

export interface ConnectionView {
  status: ConnectionStatus;
  mode: 'local' | 'quick' | 'named';
  localUrl: string;
  publicUrl: string | null;
  mcpUrl: string | null;
  lastError: string | null;
}

export function connectionView(config: Config, runtime?: Record<string, unknown>): ConnectionView {
  const external = new URL(config.publicUrl).protocol === 'https:';
  const mode =
    runtime?.mode === 'quick' || runtime?.mode === 'named'
      ? runtime.mode
      : external
        ? 'named'
        : 'local';
  const ready = runtime?.ready !== false;
  const reported = runtime?.connectionStatus;
  const status: ConnectionStatus =
    mode === 'local'
      ? 'local'
      : reported === 'error' || reported === 'reconnecting' || reported === 'starting'
        ? reported
        : ready && external
          ? 'connected'
          : 'starting';
  return {
    status,
    mode,
    localUrl: config.localUrl,
    publicUrl: external ? config.publicUrl : null,
    mcpUrl: status === 'connected' && external ? `${config.publicUrl}/mcp` : null,
    lastError: typeof runtime?.lastError === 'string' ? runtime.lastError : null,
  };
}
