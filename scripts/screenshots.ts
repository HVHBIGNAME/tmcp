import { chromium } from '@playwright/test';
import { createUiFixture } from '../tests/ui-fixture.js';
import path from 'node:path';

const fixture = await createUiFixture();
const browser = await chromium.launch();
try {
  fixture.connect('https://workstation.tmcp.example');
  await fixture.service.tokens.create({
    name: 'Notion',
    permissions: ['files:read', 'files:write', 'shell', 'gateway'],
  });
  await fixture.service.tokens.create({
    name: 'Claude Desktop',
    permissions: ['files:read', 'screen'],
  });
  for (const [action, actor] of [
    ['system_info', 'Notion'],
    ['read_file', 'Claude Desktop'],
    ['list_directory', 'Notion'],
  ] as const) {
    await fixture.service.audit.write({
      at: new Date().toISOString(),
      actor,
      clientId: 'demo',
      kind: 'file',
      action,
      detail: '',
      outcome: 'executed',
      durationMs: 14,
    });
  }
  const page = await browser.newPage({
    viewport: { width: 1280, height: 920 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await page.goto(fixture.url);
  await page.getByLabel('Внешний адрес MCP').waitFor();
  console.log(await page.locator('nav').ariaSnapshot());
  await page.screenshot({ path: path.resolve('docs/screenshots/connection.png') });
  await page.locator('nav [data-view="tokens"]').click();
  await page.getByRole('heading', { name: 'Notion', exact: true }).waitFor();
  await page.screenshot({ path: path.resolve('docs/screenshots/access.png') });
  await page.getByRole('button', { name: 'Разрешения', exact: true }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: path.resolve('docs/screenshots/permissions.png') });
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await fixture.service.settings.update({ ui: { theme: 'light' } });
  await page.locator('nav [data-view="overview"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: path.resolve('docs/screenshots/light.png') });
} finally {
  await browser.close();
  await fixture.close();
}
