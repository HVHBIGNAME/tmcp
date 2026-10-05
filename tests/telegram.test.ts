import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Telegram } from '../src/telegram.js';

test('Telegram validates credentials, sends compact callback buttons and targets every allowed chat', async (t) => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let valid = true;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const method = req.url?.split('/').at(-1) ?? '';
    calls.push({ method, body });
    res.setHeader('Content-Type', 'application/json');
    if (!valid) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
    } else
      res.end(
        JSON.stringify({
          ok: true,
          result: method === 'getMe' ? { username: 'test_bot' } : { message_id: 1 },
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const bot = new Telegram({
    token: 'test-token',
    allowedChats: ['42', '43'],
    apiBase: `http://127.0.0.1:${address.port}`,
  });
  t.after(async () => {
    await bot.stop();
    server.closeAllConnections();
    server.close();
  });
  assert.equal((await bot.check()).ok, true);
  const id = randomUUID();
  await bot.sendApproval({
    id,
    fingerprint: '',
    command: 'x'.repeat(6000),
    summary: 'x'.repeat(6000),
    cwd: '/workspace',
    clientId: 'test',
    channel: 'gui',
    requestedAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
  });
  const messages = calls.filter((call) => call.method === 'sendMessage');
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert(String(message.body.text).length < 4096);
    const markup = message.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    for (const row of markup.inline_keyboard)
      for (const button of row) {
        assert(Buffer.byteLength(button.callback_data) <= 64);
        assert(button.callback_data.includes(id));
      }
  }
  valid = false;
  assert.equal((await bot.check()).ok, false);
  assert.equal(bot.describe().status, 'error');
});
