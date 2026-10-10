import { test as base, expect } from '@playwright/test';
import { createUiFixture } from '../ui-fixture.js';

const test = base.extend<{ server: Awaited<ReturnType<typeof createUiFixture>> }>({
  server: async ({ page }, use) => {
    const server = await createUiFixture();
    try {
      await server.attach(page);
      await use(server);
    } finally {
      await server.close();
    }
  },
});

test('live diagram shows the selected key, approval wait and returned denial; history stays focused', async ({
  page,
  request,
  server,
}) => {
  const issued = await server.service.tokens.create({
    name: 'Flow client',
    permissions: ['shell'],
  });
  server.connect();
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto(server.url);
  const panel = page.locator('.traffic-panel');
  await expect(panel).toHaveAttribute('data-connected', 'true');
  const call = (name: string, args: object) =>
    request.post(`${server.publicUrl}/mcp`, {
      headers: {
        Authorization: `Bearer ${issued.token}`,
        Accept: 'application/json, text/event-stream',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
  const pending = call('run_command', { command: 'echo flow-check', wait_ms: 0 });
  try {
    await expect(panel).toHaveAttribute('data-phase', 'waiting');
    await expect(panel.locator('.flow-token.selected')).toContainText('Flow client');
    await expect(
      panel.locator('.flow-card strong').filter({ hasText: 'run_command' }),
    ).toBeVisible();
    await expect.poll(() => server.service.approvals.list().length).toBe(1);
    await page.screenshot({ path: '.mcp-tunnel/traffic-waiting.png' });
    server.service.approvals.respond(server.service.approvals.list()[0]!.id, 'deny');
    expect((await pending).status()).toBe(200);
    await expect(panel).toHaveAttribute('data-phase', 'denied');
    const row = panel.locator('.traffic-row').first();
    await row.click();
    await expect(row).toBeFocused();
    const selected = await row.getAttribute('data-request-id');
    await call('system_info', {});
    await expect(panel.locator('.traffic-row')).toHaveCount(2);
    await expect(panel.locator(`[data-request-id="${selected}"]`)).toBeFocused();
    await expect(panel).toHaveAttribute('data-phase', 'denied');
    await panel.getByRole('button', { name: 'Следить', exact: true }).click();
    await expect(panel).toHaveAttribute('data-phase', 'returned');
    await expect(panel.locator('[data-stat="received"]')).toHaveText('2');
    await expect(panel.locator('.flow-packet.response')).not.toHaveCount(0);
  } finally {
    server.service.approvals.cancelAll('Test finished');
    await pending.catch(() => undefined);
  }
});

test('reduced motion keeps the live diagram functional without moving particles', async ({
  page,
  request,
  server,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const issued = await server.service.tokens.create({
    name: 'Reduced motion',
    permissions: ['files:read'],
  });
  await page.goto(server.url);
  await expect(page.locator('.traffic-panel')).toHaveAttribute('data-connected', 'true');
  await request.post(`${server.publicUrl}/mcp`, {
    headers: {
      Authorization: `Bearer ${issued.token}`,
      Accept: 'application/json, text/event-stream',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'system_info', arguments: {} },
    },
  });
  await expect(page.locator('.traffic-panel')).toHaveAttribute('data-phase', 'returned');
  await expect(page.locator('.traffic-row')).toHaveCount(1);
  await expect(page.locator('.flow-packet')).toHaveCount(0);
});

test('busy actions show a spinner and stay disabled across background polling', async ({
  page,
  server,
}) => {
  server.connect();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/_control/api/connection/check', async (route) => {
    await gate;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, message: 'Доступен.', latencyMs: 15 }),
    });
  });
  await page.goto(server.url);
  const check = page.getByRole('button', { name: 'Проверить доступность' });
  try {
    await check.click();
    await expect(check).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('button', { name: 'Обновить состояние' }).click();
    await expect(check).toBeDisabled();
    expect(await check.evaluate((node) => getComputedStyle(node, '::before').animationName)).toBe(
      'spin',
    );
  } finally {
    release();
  }
  await expect(check).toBeEnabled();
  await expect(page.getByText('Доступен. 15 мс.')).toBeVisible();
});
