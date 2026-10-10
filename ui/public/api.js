export class ApiError extends Error {
  constructor(message, status = 0, fields = []) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

function bridge() {
  if (!window.chrome?.webview)
    throw new ApiError(
      'Откройте панель в приложении PC MCP. Управление доступно через локальный IPC.',
    );
  return window.chrome.webview;
}

function reply(message) {
  const { status, data } = message;
  if (!Number.isInteger(status) || status < 200 || status >= 300)
    throw new ApiError(
      data?.message ||
        message.message ||
        (status === 503
          ? 'Сервер запускается. Подождите немного.'
          : 'Сервер не смог выполнить действие. Повторите попытку.'),
      status || 0,
      data?.fields,
    );
  if (status === 204) return null;
  if (data === null || typeof data !== 'object')
    throw new ApiError('Сервер вернул неожиданный ответ. Повторите попытку.');
  return data;
}

/** The desktop bridge sends HTTP-framed requests over OS-protected IPC. */
export class ControlClient {
  constructor() {
    this.requests = new Set();
  }

  async call(path, { timeout = 15000, method = 'GET', body } = {}) {
    const native = bridge();
    const id = crypto.randomUUID();
    const abort = new AbortController();
    this.requests.add(abort);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        native.removeEventListener('message', receive);
        this.requests.delete(abort);
      };
      const receive = (event) => {
        if (event.data?.type !== 'control-response' || event.data.id !== id) return;
        cleanup();
        try {
          resolve(reply(event.data));
        } catch (error) {
          reject(error);
        }
      };
      abort.signal.addEventListener(
        'abort',
        () => {
          cleanup();
          native.postMessage({ type: 'control-cancel', id });
          reject(
            new ApiError('Сервер не ответил вовремя. Проверьте соединение и повторите попытку.'),
          );
        },
        { once: true },
      );
      const timer = setTimeout(() => abort.abort(), timeout);
      native.addEventListener('message', receive);
      native.postMessage({
        type: 'control-request',
        id,
        path: `/_control/api${path}`,
        method,
        body,
      });
    });
  }

  dispose() {
    for (const abort of this.requests) abort.abort();
    this.requests.clear();
  }
}

/** One request at a time; log filtering never controls connection polling. */
export class StatePoller {
  constructor(client, onData, onError, interval = 2000) {
    Object.assign(this, {
      client,
      onData,
      onError,
      interval,
      stopped: false,
      timer: null,
      pending: null,
      failures: 0,
    });
  }

  refresh() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    this.pending = this.client
      .call('/state')
      .then((data) => {
        this.failures = 0;
        this.onData(data);
      })
      .catch((error) => {
        this.failures++;
        this.onError(error);
      })
      .finally(() => {
        this.pending = null;
        if (!this.stopped)
          this.timer = setTimeout(
            () => this.refresh(),
            Math.min(10000, this.interval * Math.max(1, this.failures)),
          );
      });
    return this.pending;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.client.dispose();
  }
}

export class ActivityStream {
  constructor(client, onEvent, onConnection) {
    Object.assign(this, { client, onEvent, onConnection, controller: null });
  }

  start() {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.run(controller).finally(() => {
      if (this.controller === controller) this.controller = null;
    });
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
  }

  async run(controller) {
    let retry = 500;
    const { signal } = controller;
    while (!signal.aborted) {
      try {
        await this.subscribe(signal, () => {
          retry = 500;
          this.onConnection(true);
        });
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      this.onConnection(false);
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, retry);
        signal.addEventListener('abort', done, { once: true });
      });
      retry = Math.min(8000, retry * 2);
    }
  }

  subscribe(signal, connected) {
    const native = bridge();
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        native.removeEventListener('message', receive);
        signal.removeEventListener('abort', cleanup);
        native.postMessage({ type: 'control-cancel', id });
        resolve();
      };
      const receive = (event) => {
        if (event.data?.id !== id) return;
        if (event.data.type === 'control-stream-open') {
          clearTimeout(timer);
          connected();
        } else if (event.data.type === 'control-event') this.onEvent(event.data.data);
        else if (['control-stream-end', 'control-response'].includes(event.data.type)) cleanup();
      };
      const timer = setTimeout(cleanup, 5000);
      native.addEventListener('message', receive);
      signal.addEventListener('abort', cleanup, { once: true });
      native.postMessage({ type: 'control-subscribe', id });
    });
  }
}
