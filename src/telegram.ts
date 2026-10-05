import { setTimeout as delay } from 'node:timers/promises';
import type { ApprovalRequest } from './approvals.js';

export interface TelegramOptions {
  token: string;
  allowedChats: string[];
  apiBase?: string;
  pollIntervalMs?: number;
}

export interface TelegramDelivery {
  ok: boolean;
  message?: string;
}

export interface TelegramStatus extends TelegramDelivery {
  status: 'checking' | 'connected' | 'error' | 'incomplete' | 'stopped';
  chats: number;
  username?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number | string }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number | string } };
  };
}

type CommandHandler = (chatId: string, text: string) => Promise<string>;

export class Telegram {
  private readonly base: string;
  private readonly chats: Set<string>;
  private readonly abort = new AbortController();
  private offset = 0;
  private loop?: Promise<void>;
  private health: TelegramStatus;

  constructor(private readonly options: TelegramOptions) {
    this.base = options.apiBase ?? 'https://api.telegram.org';
    this.chats = new Set(options.allowedChats);
    this.health = {
      ok: false,
      status: this.chats.size ? 'checking' : 'incomplete',
      chats: this.chats.size,
      message: this.chats.size ? 'Checking Telegram connection' : 'No allowed chats configured',
    };
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.base}/bot${this.options.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]),
    });
    const parsed = (await response.json()) as { ok?: boolean; result?: T; description?: string };
    if (!response.ok || !parsed.ok) {
      const detail = (parsed.description ?? `HTTP ${response.status}`).replaceAll(
        this.options.token,
        '[hidden]',
      );
      throw new Error(`Telegram ${method}: ${detail}`);
    }
    return parsed.result as T;
  }

  async check(): Promise<TelegramStatus> {
    try {
      const bot = await this.call<{ username: string }>('getMe', {});
      this.health = {
        ok: this.chats.size > 0,
        status: this.chats.size ? 'connected' : 'incomplete',
        chats: this.chats.size,
        username: bot.username,
        message: this.chats.size ? `@${bot.username}` : 'No allowed chats configured',
      };
    } catch (error) {
      this.failed(error);
    }
    return this.describe();
  }

  private failed(error: unknown): void {
    if (this.abort.signal.aborted) return;
    this.health = {
      ...this.health,
      ok: false,
      status: 'error',
      message:
        error instanceof Error
          ? error.message.replaceAll(this.options.token, '[hidden]')
          : 'Telegram is unavailable',
    };
  }

  private async broadcast(body: Record<string, unknown>): Promise<TelegramDelivery> {
    if (!this.chats.size) return { ok: false, message: 'No allowed chats configured' };
    let delivered = 0;
    let failure = '';
    for (const chat of this.chats) {
      try {
        await this.call('sendMessage', { ...body, chat_id: chat, disable_web_page_preview: true });
        delivered++;
      } catch (error) {
        this.failed(error);
        failure = this.health.message ?? 'Telegram is unavailable';
      }
    }
    return { ok: delivered > 0, message: failure || undefined };
  }

  send(message: string): Promise<TelegramDelivery> {
    return this.broadcast({ text: message.slice(0, 4000) });
  }

  sendApproval(request: ApprovalRequest): Promise<TelegramDelivery> {
    return this.broadcast({
      text: [
        'Требуется подтверждение',
        `Команда: ${request.summary.slice(0, 2000)}`,
        `Папка: ${request.cwd.slice(0, 800)}`,
        `Клиент: ${request.clientId}`,
        `До: ${request.expiresAt}`,
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Разрешить', callback_data: `a:${request.id}:allow:once` },
            { text: 'Запомнить', callback_data: `a:${request.id}:allow:remember` },
          ],
          [{ text: 'Отклонить', callback_data: `a:${request.id}:deny:once` }],
        ],
      },
    });
  }

  start(onCommand: CommandHandler, onCallback: CommandHandler): void {
    if (this.loop || this.abort.signal.aborted || !this.chats.size) return;
    this.loop = this.poll(onCommand, onCallback);
  }

  private async poll(onCommand: CommandHandler, onCallback: CommandHandler): Promise<void> {
    await this.check();
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>('getUpdates', {
          timeout: 20,
          offset: this.offset,
          allowed_updates: ['message', 'callback_query'],
        });
        if (this.abort.signal.aborted) break;
        this.health = {
          ...this.health,
          ok: true,
          status: 'connected',
          message: this.health.username ? `@${this.health.username}` : `${this.chats.size} chat(s)`,
        };
        for (const update of updates) {
          if (this.abort.signal.aborted) break;
          this.offset = update.update_id + 1;
          const callback = update.callback_query;
          if (callback?.message && callback.data) {
            const chat = String(callback.message.chat.id);
            if (!this.chats.has(chat)) continue;
            const answer = await onCallback(chat, callback.data);
            await this.call('answerCallbackQuery', {
              callback_query_id: callback.id,
              text: answer.slice(0, 200),
            });
          } else if (update.message?.text) {
            const chat = String(update.message.chat.id);
            if (!this.chats.has(chat)) continue;
            const reply = await onCommand(chat, update.message.text);
            if (reply)
              await this.call('sendMessage', { chat_id: chat, text: reply.slice(0, 4000) });
          }
        }
        // Also bounds retries when a proxy returns empty updates without long polling.
        await delay(this.options.pollIntervalMs ?? 500, undefined, {
          signal: this.abort.signal,
          ref: false,
        });
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.failed(error);
        try {
          await delay(this.options.pollIntervalMs ?? 5000, undefined, {
            signal: this.abort.signal,
            ref: false,
          });
        } catch {
          break;
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.health = { ...this.health, ok: false, status: 'stopped' };
    await this.loop;
  }

  describe(): TelegramStatus {
    return { ...this.health };
  }
}
