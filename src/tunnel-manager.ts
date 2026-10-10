import type { Config } from './config.js';
import { validatePublicUrl } from './config.js';
import type { Settings } from './settings.js';
import { startTunnel, type CloudflareTunnel } from './tunnel.js';
import type { Logger } from './tools.js';
import { errorMessage } from './utils.js';

export interface TunnelState {
  mode: 'quick' | 'named';
  connectionStatus: 'starting' | 'connected' | 'reconnecting' | 'error';
  ready: boolean;
  lastError: string | null;
}

type ManagedTunnel = Pick<CloudflareTunnel, 'url' | 'stop'>;
type TunnelLauncher = (...args: Parameters<typeof startTunnel>) => Promise<ManagedTunnel>;

/** Reconnects the tunnel independently of the MCP listener and running commands. */
export class TunnelManager {
  private current?: ManagedTunnel;
  private pending?: Promise<string>;
  private retry?: NodeJS.Timeout;
  private readonly abort = new AbortController();
  private failures = 0;
  private mode: 'quick' | 'named' = 'quick';

  constructor(
    private readonly config: Config,
    private readonly settings: () => Settings['tunnel'],
    private readonly publish: (url: string) => void,
    private readonly changed: (state: TunnelState) => Promise<void>,
    private readonly log: Logger,
    private readonly launch: TunnelLauncher = startTunnel,
    private readonly retryBaseMs = 2000,
  ) {}

  private launchConfig(mode: 'quick' | 'named'): Config {
    const settings = this.settings();
    if (mode === 'quick') return this.config;
    const hostname = settings.hostname.trim();
    const publicUrl = hostname
      ? validatePublicUrl(hostname.startsWith('https://') ? hostname : `https://${hostname}`)
      : this.config.publicUrl;
    const tunnelToken = settings.tunnelToken || this.config.tunnelToken;
    if (!tunnelToken || !publicUrl.startsWith('https://'))
      throw new Error('Named tunnel requires a hostname and connector token');
    return { ...this.config, publicUrl, tunnelToken };
  }

  async restart(mode: 'quick' | 'named'): Promise<string> {
    if (this.abort.signal.aborted) throw new Error('The server is stopping');
    if (this.pending) throw new Error('A tunnel restart is already running');
    const config = this.launchConfig(mode);
    this.mode = mode;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.pending = this.connect(config, mode).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async connect(config: Config, mode: 'quick' | 'named'): Promise<string> {
    await this.changed({
      mode,
      ready: false,
      connectionStatus: this.current ? 'reconnecting' : 'starting',
      lastError: null,
    });
    const previous = this.current;
    this.current = undefined;
    try {
      await previous?.stop();
      const replacement = await this.launch(
        config,
        mode,
        this.log,
        (message) => {
          if (this.abort.signal.aborted) return;
          this.log({ event: 'tunnel_disconnected', message });
          this.schedule(message);
        },
        this.abort.signal,
      );
      if (this.abort.signal.aborted) {
        await replacement.stop();
        throw new Error('The server is stopping');
      }
      this.current = replacement;
      this.publish(replacement.url);
      this.failures = 0;
      await this.changed({ mode, ready: true, connectionStatus: 'connected', lastError: null });
      this.log({ event: 'tunnel_ready', mcpUrl: `${replacement.url}/mcp` });
      return replacement.url;
    } catch (error) {
      if (!this.abort.signal.aborted) this.schedule(errorMessage(error));
      throw error;
    }
  }

  private schedule(message: string): void {
    if (this.abort.signal.aborted || this.retry) return;
    this.failures++;
    const wait = Math.min(60000, this.retryBaseMs * 2 ** Math.min(this.failures - 1, 5));
    void this.changed({
      mode: this.mode,
      ready: false,
      connectionStatus: 'reconnecting',
      lastError: message,
    }).catch((error: unknown) =>
      this.log({ event: 'runtime_write_error', message: errorMessage(error) }),
    );
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.pending) {
        this.schedule(message);
        return;
      }
      void this.restart(this.mode).catch((error: unknown) => {
        this.log({ event: 'tunnel_retry_failed', message: errorMessage(error) });
        this.schedule(errorMessage(error));
      });
    }, wait);
    this.retry.unref();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    clearTimeout(this.retry);
    await this.pending?.catch(() => undefined);
    await this.current?.stop();
    this.current = undefined;
  }
}
