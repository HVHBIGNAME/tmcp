(() => {
  const channel = new EventTarget();
  const requests = new Map();
  window.addEventListener('tmcp-fixture-message', (event) => {
    channel.dispatchEvent(new MessageEvent('message', { data: event.detail }));
  });
  window.chrome ??= {};
  window.chrome.webview = {
    addEventListener(...args) {
      channel.addEventListener(...args);
    },
    removeEventListener(...args) {
      channel.removeEventListener(...args);
    },
    postMessage(message) {
      if (message.type === 'control-subscribe') {
        void window.tmcpFixtureEvents(message.id).catch(() => {});
        return;
      }
      if (message.type === 'control-cancel') {
        requests.get(message.id)?.abort();
        void window.tmcpFixtureCancel(message.id).catch(() => {});
        return;
      }
      if (message.type !== 'control-request') return;
      const controller = new AbortController();
      requests.set(message.id, controller);
      fetch(message.path, {
        method: message.method,
        body: message.body,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = response.headers.get('content-type')?.includes('application/json')
            ? await response.json()
            : null;
          channel.dispatchEvent(
            new MessageEvent('message', {
              data: { type: 'control-response', id: message.id, status: response.status, data },
            }),
          );
        })
        .catch(() => {
          channel.dispatchEvent(
            new MessageEvent('message', {
              data: { type: 'control-response', id: message.id, status: 0 },
            }),
          );
        })
        .finally(() => requests.delete(message.id));
    },
  };
})();
