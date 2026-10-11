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

test('external address updates automatically, including when log auto-refresh is off', async ({
  page,
  server,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(server.url);
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Копировать ссылку' })).toBeDisabled();
  server.connect();
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue(
    'https://workspace-example.trycloudflare.com/mcp',
    { timeout: 6000 },
  );
  await page.getByRole('button', { name: 'Копировать ссылку' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'https://workspace-example.trycloudflare.com/mcp',
  );
  await page.locator('nav').getByRole('button', { name: 'Журнал' }).click();
  await page.getByLabel('Автообновление').uncheck();
  await page.locator('nav').getByRole('button', { name: 'Подключение', exact: true }).click();
  server.connect('https://new-address.example.com');
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue(
    'https://new-address.example.com/mcp',
    { timeout: 6000 },
  );
});

test('registration is not a reachability check and failed checks survive polling', async ({
  page,
  server,
}) => {
  server.connect();
  await page.goto(server.url);
  await expect(page.locator('.hero-title')).toHaveText('Туннель зарегистрирован');
  await page.route('**/_control/api/connection/check', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, message: 'Внешний адрес вернул HTTP 502.' }),
    }),
  );
  await page.getByRole('button', { name: 'Проверить доступность' }).click();
  await page.getByRole('button', { name: 'Обновить состояние' }).click();
  await expect(page.locator('.hero-title')).toHaveText('Внешний адрес не отвечает');
  await expect(page.locator('.check-result')).toContainText('HTTP 502');
  await page.locator('nav [data-view="tokens"]').click();
  await page.locator('nav [data-view="overview"]').click();
  await expect(page.locator('.hero-title')).toHaveText('Туннель зарегистрирован');
  server.connect('https://replacement.example.com');
  await page.getByRole('button', { name: 'Обновить состояние' }).click();
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue(
    'https://replacement.example.com/mcp',
  );
  await expect(page.locator('.check-result')).toBeHidden();
});

test('drafts and focus survive polling; unsaved changes use the custom dialog', async ({
  page,
  server,
}) => {
  server.connect();
  await page.goto(server.url);
  await page.locator('nav').getByRole('button', { name: 'Telegram' }).click();
  const token = page.getByLabel('Токен бота', { exact: true });
  await token.fill('123456:private-draft');
  await page.waitForTimeout(2400);
  await expect(token).toHaveValue('123456:private-draft');
  await expect(token).toBeFocused();
  await page.locator('nav').getByRole('button', { name: 'Доступ', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Оставить изменения?' })).toBeVisible();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(token).toHaveValue('123456:private-draft');
  await page.getByRole('button', { name: 'Сохранить и проверить' }).click();
  await expect(page.getByRole('alert')).toContainText('числовой ID');
  expect(server.service.settings.redacted().telegram.tokenSet).toBe(false);
});

test('token creation, permissions, rotation and deletion work with custom dialogs', async ({
  page,
  server,
}) => {
  server.connect();
  await page.goto(server.url);
  await page.locator('nav').getByRole('button', { name: 'Доступ', exact: true }).click();
  await page.getByRole('button', { name: 'Новый токен' }).click();
  await page.getByRole('button', { name: 'Создать токен', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Введите имя');
  await expect(page.getByLabel('Имя интеграции')).toBeFocused();
  await page.getByLabel('Имя интеграции').fill('Notion test');
  await page.getByRole('button', { name: 'Создать токен', exact: true }).click();
  const issued = page.getByRole('textbox', { name: 'Новый токен', exact: true });
  await expect(issued).toBeVisible();
  const oldKey = await issued.inputValue();
  expect(server.service.tokens.find(oldKey)).toBeTruthy();
  expect(server.service.tokens.find(oldKey)?.permissions).toEqual(['files:read']);
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.getByRole('button', { name: 'Разрешения', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('checkbox', { name: /Журнал/ })
    .check();
  await page.getByRole('button', { name: 'Сохранить доступ' }).click();
  await expect.poll(() => server.service.tokens.list()[0]?.permissions).toContain('log');
  await page.getByRole('button', { name: 'Заменить', exact: true }).click();
  await page.getByRole('button', { name: 'Создать новый ключ' }).click();
  await expect(issued).not.toHaveValue(oldKey);
  expect(server.service.tokens.find(oldKey)).toBeUndefined();
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(server.service.tokens.list()).toHaveLength(1);
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить токен', exact: true }).click();
  await expect.poll(() => server.service.tokens.list()).toHaveLength(0);
});

test('IPC connection recovers without reloading or showing raw HTML errors', async ({
  page,
  server,
}) => {
  server.connect();
  let failures = 1;
  await page.route('**/_control/api/state', (route) =>
    failures-- > 0
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"starting"}',
        })
      : route.fallback(),
  );
  await page.goto(server.url);
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue(/https:/);
  await page.unroute('**/_control/api/state');
  let offline = true;
  await page.route('**/_control/api/state', (route) =>
    offline ? route.abort() : route.fallback(),
  );
  await page.getByRole('button', { name: 'Обновить состояние' }).click();
  await expect(page.getByText('Восстанавливаем связь с сервером')).toBeVisible();
  offline = false;
  await expect(page.getByText('Восстанавливаем связь с сервером')).not.toBeVisible({
    timeout: 7000,
  });
  await page.locator('nav').getByRole('button', { name: 'MCP-серверы' }).click();
  await page.route('**/_control/api/servers/reload', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'text/html',
      body: '<html><body>SECRET STACK TRACE</body></html>',
    }),
  );
  await page.getByRole('button', { name: 'Обновить список' }).click();
  await expect(page.getByRole('alert')).toContainText('Сервер не смог');
  await expect(page.locator('body')).not.toContainText('SECRET STACK TRACE');
});

test('permission fields freeze during save and recover without losing the selection', async ({
  page,
  server,
}) => {
  const issued = await server.service.tokens.create({
    name: 'Проверка сохранения',
    permissions: ['files:read'],
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/_control/api/tokens/${issued.id}`, async (route) => {
    await pending;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unavailable', message: 'Тестовый отказ сохранения' }),
    });
  });
  await page.goto(server.url);
  await page.locator('nav [data-view="tokens"]').click();
  await page.getByRole('button', { name: 'Разрешения', exact: true }).click();
  const dialog = page.getByRole('dialog');
  try {
    await dialog.getByRole('button', { name: 'Сохранить доступ' }).click();
    for (const checkbox of await dialog.getByRole('checkbox').all())
      await expect(checkbox).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }
  await expect(dialog.getByRole('alert')).toContainText('отказ сохранения');
  for (const checkbox of await dialog.getByRole('checkbox').all())
    await expect(checkbox).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: /Чтение файлов/ })).toBeChecked();
  expect(server.service.tokens.list()[0]?.permissions).toEqual(['files:read']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Разрешения', exact: true })).toBeFocused();
});

test('integration names are rendered as text in cards and permission dialogs', async ({
  page,
  server,
}) => {
  const name = '<img src=x onerror=alert(1)>';
  await server.service.tokens.create({ name, permissions: ['files:read'] });
  await page.goto(server.url);
  await page.locator('nav [data-view="tokens"]').click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Разрешения', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(name);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
});

test('settings apply explicitly, preserve secrets, theme and autostart controls work', async ({
  page,
  server,
}) => {
  server.connect();
  await server.service.settings.update({ tunnel: { tunnelToken: 'private-stored-token' } });
  await page.goto(server.url);
  await page.locator('nav').getByRole('button', { name: 'Настройки' }).click();
  await page.getByLabel('Запуск команд', { exact: true }).uncheck();
  expect(server.service.settings.get().shell.enabled).toBe(true);
  await page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Возможности компьютера' }) })
    .getByRole('button', { name: 'Сохранить изменения' })
    .click();
  await expect.poll(() => server.service.settings.get().shell.enabled).toBe(false);
  expect(server.service.settings.secretFor('tunnel')).toBe('private-stored-token');
  await page.getByLabel('Тема приложения').selectOption('light');
  await page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Оформление' }) })
    .getByRole('button', { name: 'Сохранить изменения' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Запускать при входе в систему').check();
  await expect(page.getByText('Автозапуск включён', { exact: true })).toBeVisible();
});

test('automatic update preference persists and unsaved forms block installation', async ({
  page,
  server,
}) => {
  await page.goto(server.url);
  await page.locator('nav [data-view="settings"]').click();
  await expect(page.getByRole('checkbox', { name: 'Обновлять автоматически' })).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('tmcp-fixture-message', {
        detail: {
          type: 'update-status',
          update: {
            supported: true,
            currentVersion: '2.1.0',
            status: 'current',
            message: 'Актуальная версия',
            progress: 0,
          },
        },
      }),
    ),
  );
  await page.getByRole('checkbox', { name: 'Обновлять автоматически' }).uncheck();
  await expect.poll(() => server.service.settings.get().updates.enabled).toBe(false);
  await expect.poll(() => page.evaluate('window.tmcpCanUpdate()')).toBe(true);
  await page.getByRole('checkbox', { name: 'Запуск команд', exact: true }).uncheck();
  await expect.poll(() => page.evaluate('window.tmcpCanUpdate()')).toBe(false);
  await page.reload();
  await page.locator('nav [data-view="settings"]').click();
  await expect(page.getByRole('checkbox', { name: 'Обновлять автоматически' })).not.toBeChecked();
  await expect.poll(() => page.evaluate('window.tmcpCanUpdate()')).toBe(true);
  await page.locator('nav [data-view="tokens"]').click();
  await page.getByRole('button', { name: 'Новый токен' }).click();
  await expect.poll(() => page.evaluate('window.tmcpCanUpdate()')).toBe(false);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect.poll(() => page.evaluate('window.tmcpCanUpdate()')).toBe(true);
});

test('all pages fit desktop and narrow layouts without browser errors', async ({
  page,
  server,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', async (dialog) => {
    errors.push(`Native dialog: ${dialog.message()}`);
    await dialog.dismiss();
  });
  server.connect();
  await page.goto(server.url);
  for (const size of [
    { width: 1280, height: 850 },
    { width: 940, height: 640 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    for (const view of [
      'overview',
      'tokens',
      'approvals',
      'servers',
      'telegram',
      'logs',
      'settings',
    ]) {
      await page.locator(`nav [data-view="${view}"]`).click();
      await expect(page.locator('.page-content')).toBeVisible();
      expect(
        await page.locator('.page-content').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});
