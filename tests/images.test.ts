import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import sharp from 'sharp';
import { imageResult } from '../src/images.js';
import { captureProcess } from '../src/captured-process.js';

test('raster conversion applies orientation, rejects unsafe formats and enforces concurrent limits', async () => {
  const jpeg = await sharp({
    create: { width: 80, height: 40, channels: 3, background: '#336699' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const image = await imageResult(jpeg, 320);
  assert.deepEqual(image.structuredContent, {
    width: 40,
    height: 80,
    mime_type: 'image/png',
    bytes: image.structuredContent.bytes,
  });
  await assert.rejects(
    imageResult(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 320),
    /raster/,
  );
  const oversized = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
  );
  oversized.writeUInt16LE(32767, 6);
  oversized.writeUInt16LE(32767, 8);
  const frame = oversized.indexOf(0x2c);
  oversized.writeUInt16LE(32767, frame + 5);
  oversized.writeUInt16LE(32767, frame + 7);
  await assert.rejects(imageResult(oversized, 320), /pixel limit/i);
  const first = imageResult(jpeg, 320),
    second = imageResult(jpeg, 320);
  await assert.rejects(imageResult(jpeg, 320), /Maximum of 2/);
  await Promise.all([first, second]);
  await assert.rejects(imageResult(jpeg, 320, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal((await imageResult(jpeg, 320)).structuredContent.width, 40);
});

test('managed capture workers preserve exact arguments and enforce output/cancellation bounds', async () => {
  const project = path.resolve('.');
  const args = ['with spaces', 'embedded"quote', 'trailing\\', '🙂 Привет'];
  const result = await captureProcess(
    process.execPath,
    ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args],
    project,
  );
  assert.deepEqual(JSON.parse(result), args);
  await assert.rejects(
    captureProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(7*1024*1024));setInterval(()=>{},1000)'],
      project,
    ),
    /output exceeds/,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(
      captureProcess(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        project,
        controller.signal,
      ),
      { name: 'AbortError' },
    );
  } finally {
    clearTimeout(timer);
  }
});
