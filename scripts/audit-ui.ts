import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createUiFixture } from '../tests/ui-fixture.js';
import { declaredContrast } from './ui-contrast.js';

const output = path.resolve('.mcp-tunnel', 'ui-audit');
await mkdir(output, { recursive: true });
const fixture = await createUiFixture();
let browser: Browser | undefined;
const findings: object[] = [];
const manualReview: object[] = [];
const checks: object[] = [];
const snapshots = process.argv.includes('--screenshots');

async function inspect(page: Page, name: string) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = result.violations.map((issue) => ({
    id: issue.id,
    impact: issue.impact,
    nodes: issue.nodes.map((node) => ({
      target: node.target,
      summary: node.failureSummary,
    })),
  }));
  if (violations.length) findings.push({ name, violations });
  if (result.incomplete.length) {
    const selectors = result.incomplete
      .filter((issue) => issue.id === 'color-contrast')
      .flatMap((issue) => issue.nodes.map((node) => node.target.join(' ')));
    const colors = await declaredContrast(page, selectors);
    const lowContrast = colors.filter((entry) => entry.ratio < entry.minimum);
    if (lowContrast.length) findings.push({ name, declaredContrast: lowContrast });
    manualReview.push({
      name,
      declaredContrast: colors,
      issues: result.incomplete.map((issue) => ({
        id: issue.id,
        nodes: issue.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
      })),
    });
  }
  checks.push({ name, violations: violations.length, incomplete: result.incomplete.length });
  if (snapshots) {
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    await writeFile(
      path.join(output, `${name}.aria.txt`),
      await page.locator('body').ariaSnapshot(),
    );
  }
}

try {
  browser = await chromium.launch();
  fixture.connect('https://workstation.tmcp.example');
  Object.assign(fixture.runtime, {
    tunnelDiagnostics: {
      activeConnections: 3,
      protocol: 'http2',
      requestFailures: 1,
      lastFailure: { kind: 'control_stream', at: '2026-10-14T12:00:00.000Z' },
    },
  });
  await fixture.service.tokens.create({
    name: 'Исследовательский проект',
    permissions: ['files:read', 'files:write', 'shell'],
  });
  await fixture.service.tokens.create({ name: 'Чтение документов', permissions: ['files:read'] });
  for (const theme of ['dark', 'light'] as const) {
    await fixture.service.settings.update({ ui: { theme } });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await fixture.attach(page);
    await page.goto(fixture.url);
    await page.locator('.traffic-panel').waitFor();
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
      await inspect(page, `${theme}-${view}`);
    }
    await page.locator('nav [data-view="tokens"]').click();
    const launcher = page.getByRole('button', { name: 'Новый токен', exact: true });
    await launcher.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    await inspect(page, `${theme}-token-dialog`);
    await page.keyboard.press('Escape');
    if (!(await launcher.evaluate((element) => element === document.activeElement)))
      findings.push({
        name: `${theme}-dialog-focus`,
        error: 'Focus did not return to the launcher',
      });
    await page.getByRole('button', { name: 'Разрешения', exact: true }).first().click();
    await page.getByRole('dialog').waitFor();
    await inspect(page, `${theme}-permissions-dialog`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Удалить', exact: true }).first().click();
    await page.getByRole('dialog').waitFor();
    await inspect(page, `${theme}-delete-dialog`);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 320, height: 640 });
    await inspect(page, `${theme}-narrow-tokens`);
    await page.locator('nav [data-view="overview"]').click();
    await inspect(page, `${theme}-narrow-overview`);
    await context.close();
  }
  const consentContext = await browser.newContext({ reducedMotion: 'reduce' });
  const registration = await consentContext.request.post(`${fixture.publicUrl}/register`, {
    data: {
      client_name: 'Проверка интерфейса',
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  if (registration.status() !== 201) throw new Error('Cannot register the isolated audit client');
  const client = await registration.json();
  const query = new URLSearchParams({
    client_id: client.client_id,
    response_type: 'code',
    redirect_uri: 'http://127.0.0.1/callback',
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    resource: 'https://workstation.tmcp.example/mcp',
  });
  const consent = await consentContext.newPage();
  await consent.goto(`${fixture.publicUrl}/authorize?${query}`);
  await inspect(consent, 'oauth-consent');
  await consent.getByLabel(/Токен доступа/).fill('invalid-audit-key');
  await consent.getByRole('button', { name: 'Разрешить доступ' }).click();
  await consent.getByRole('alert').waitFor();
  await inspect(consent, 'oauth-invalid-key');
  await consentContext.close();
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ checks, findings, manualReview }, null, 2),
  );
  process.stdout.write(JSON.stringify({ checks, findings }, null, 2) + '\n');
  if (findings.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await fixture.close();
}
