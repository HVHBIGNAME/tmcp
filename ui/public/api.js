export class ApiError extends Error {
  constructor(message, status = 0, fields = []) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export class ControlClient {
  constructor(base = location.origin) {
    this.base = base;
    this.admin = '';
    this.authorization = null;
    this.requests = new Set();
  }

  async authorize() {
    if (this.authorization) return this.authorization;
    this.authorization = (async () => {
      const response = await this.request('/_control/bootstrap', { method: 'GET' });
      if (typeof response?.adminToken !== 'string' || !response.adminToken)
        throw new ApiError('Не удалось открыть сессию управления. Повторяем подключение.');
      this.admin = response.adminToken;
    })().finally(() => {
      this.authorization = null;
    });
    return this.authorization;
  }

  async request(path, { timeout = 12000, ...options } = {}) {
    const abort = new AbortController();
    this.requests.add(abort);
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await fetch(`${this.base}${path}`, {
        ...options,
        signal: abort.signal,
        cache: 'no-store',
      });
      const json = (response.headers.get('content-type') ?? '').includes('application/json');
      const data = json ? await response.json() : null;
      if (!response.ok) {
        throw new ApiError(
          data?.message ||
            (response.status === 401
              ? 'Сессия истекла. Подключаемся заново.'
              : response.status === 503
                ? 'Сервер запускается. Подождите немного.'
                : 'Сервер не смог выполнить действие. Повторите попытку.'),
          response.status,
          data?.fields,
        );
      }
      if (response.status === 204) return null;
      if (!json) throw new ApiError('Сервер вернул неожиданный ответ. Повторите попытку.');
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        abort.signal.aborted
          ? 'Сервер не ответил вовремя. Проверьте соединение и повторите попытку.'
          : 'Нет связи с сервером. Приложение подключится автоматически.',
      );
    } finally {
      clearTimeout(timer);
      this.requests.delete(abort);
    }
  }

  async call(path, options = {}) {
    if (!this.admin) await this.authorize();
    const run = () =>
      this.request(`/_control/api${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${this.admin}`, 'Content-Type': 'application/json' },
      });
    try {
      return await run();
    } catch (error) {
      if (error.status !== 401) throw error;
      this.admin = '';
      await this.authorize();
      // Authentication middleware rejected the first request before any action ran.
      return run();
    }
  }

  dispose() {
    for (const abort of this.requests) abort.abort();
    this.requests.clear();
    this.admin = '';
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
