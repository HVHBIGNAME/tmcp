import type { Page } from '@playwright/test';
import path from 'node:path';
import { ipcFetch } from '../src/ipc.js';

/** Test-only native bridge. The fixture's HTTP listener serves assets, never control. */
export async function attachBrowserBridge(page: Page, dataDir: string) {
  const streams = new Map<string, AbortController>();
  const send = async (data: unknown) => {
    if (page.isClosed()) return;
    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('tmcp-fixture-message', { detail }));
    }, data);
  };
  await page.route('**/_control/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await ipcFetch(dataDir, url.pathname + url.search, {
      method: request.method(),
      body: request.postData() ?? undefined,
    });
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'application/json',
      body: await response.text(),
    });
  });
  await page.exposeBinding('tmcpFixtureCancel', ({ frame }, id: string) => {
    if (frame === page.mainFrame()) streams.get(id)?.abort();
  });
  await page.exposeBinding('tmcpFixtureEvents', async ({ frame }, id: string) => {
    if (frame !== page.mainFrame()) return;
    const controller = new AbortController();
    streams.set(id, controller);
    try {
      const response = await ipcFetch(dataDir, '/_control/api/events', {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('Event stream unavailable');
      await send({ type: 'control-stream-open', id });
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '';
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          const frames = pending.split('\n\n');
          pending = frames.pop()!;
          for (const frame of frames) {
            const line = frame.split('\n').find((line) => line.startsWith('data: '));
            if (line) await send({ type: 'control-event', id, data: JSON.parse(line.slice(6)) });
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (!controller.signal.aborted && !page.isClosed())
        await send({ type: 'control-response', id, status: 0, message: String(error) });
    } finally {
      controller.abort();
      streams.delete(id);
      await send({ type: 'control-stream-end', id }).catch(() => undefined);
    }
  });
  page.on('close', () => {
    for (const controller of streams.values()) controller.abort();
  });
  await page.addInitScript({ path: path.resolve('tests/ui-bridge.js') });
}
