import screenshot from 'screenshot-desktop';
import sharp from 'sharp';
import type { Files } from './files.js';

export async function imageResult(data: Buffer, maxSize: number) {
  const image = await sharp(data, { limitInputPixels: 50000000 })
    .rotate()
    .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  if (image.length > 4 * 1024 * 1024) throw new Error('Image is too large; use a smaller max_size');
  return {
    content: [{ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/png' }],
  };
}

export async function listDisplays() {
  const displays = await screenshot.listDisplays();
  return displays.map((display, index) => ({ index, name: display.name }));
}

export async function captureScreen(displayIndex: number, maxSize: number) {
  const displays = await screenshot.listDisplays();
  const display = displays[displayIndex];
  if (!display) throw new Error('Display not found; call list_displays first');
  const data = await screenshot({ format: 'png', screen: display.id });
  return imageResult(data, maxSize);
}

export async function readImage(files: Files, filename: string, maxSize: number) {
  return imageResult(await files.readBytes(filename, 16 * 1024 * 1024), maxSize);
}
