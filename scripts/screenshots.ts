import { chromium } from '@playwright/test';
import { createUiFixture } from '../tests/ui-fixture.js';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

const fixture = await createUiFixture();
const browser = await chromium.launch();
try {
  fixture.connect('https://workstation.tmcp.example');
  const notion = await fixture.service.tokens.create({
    name: 'Notion',
    permissions: ['files:read', 'files:write', 'shell', 'gateway'],
  });
  const chatgpt = await fixture.service.tokens.create({
    name: 'ChatGPT',
    permissions: ['files:read', 'screen'],
  });
  await writeFile(
    path.join(fixture.config.roots[0]!, 'README.md'),
    'A sample workspace for the documentation screenshots.',
  );
  for (const [name, key, args] of [
    ['system_info', notion.token, {}],
    ['list_directory', notion.token, { path: '.' }],
    ['mcp_list_servers', notion.token, {}],
    ['read_file', chatgpt.token, { path: 'README.md' }],
  ] as const) {
    const response = await fetch(`${fixture.publicUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const result = await response.json();
    if (!response.ok || result.error || result.result?.isError)
      throw new Error(`Screenshot fixture call failed: ${name}`);
  }
  const page = await browser.newPage({
    viewport: { width: 1280, height: 920 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await fixture.attach(page);
  await page.goto(fixture.url);
  await page.getByLabel('Внешний адрес MCP').waitFor();
  await page.screenshot({
    path: path.resolve('docs/screenshots/connection.png'),
    animations: 'disabled',
  });
  await page
    .locator('.traffic-panel')
    .screenshot({ path: path.resolve('docs/screenshots/traffic.png'), animations: 'disabled' });
  await page.locator('nav [data-view="tokens"]').click();
  await page.getByRole('heading', { name: 'Notion', exact: true }).waitFor();
  await page.screenshot({
    path: path.resolve('docs/screenshots/access.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Разрешения', exact: true }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({
    path: path.resolve('docs/screenshots/permissions.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await fixture.service.settings.update({ ui: { theme: 'light' } });
  await page.locator('nav [data-view="overview"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({
    path: path.resolve('docs/screenshots/light.png'),
    animations: 'disabled',
  });
} finally {
  await browser.close();
  await fixture.close();
}
