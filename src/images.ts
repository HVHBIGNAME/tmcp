import sharp from 'sharp';
import type { Files } from './files.js';
import { fileURLToPath } from 'node:url';
import { captureProcess } from './captured-process.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

let active = 0;
async function withSlot<T>(run: () => Promise<T>) {
  if (active >= 2)
    throw new Error(
      'Maximum of 2 image operations reached; retry after the active captures finish',
    );
  active++;
  try {
    return await run();
  } finally {
    active--;
  }
}

function raster(data: Buffer) {
  return (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (data[0] === 255 && data[1] === 216 && data[2] === 255) ||
    /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii')) ||
    (data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP') ||
    data.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
    data.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])) ||
    data.subarray(4, 8).toString('ascii') === 'ftyp'
  );
}

async function transform(data: Buffer, maxSize: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!raster(data))
    throw new Error(
      'Invalid raster image. Supported: PNG, JPEG, WebP, GIF, TIFF, AVIF/HEIF; read SVG/XML as text',
    );
  const { data: image, info } = await sharp(data, { limitInputPixels: 50000000 })
    .rotate()
    .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (image.length > 4 * 1024 * 1024) throw new Error('Image is too large; use a smaller max_size');
  signal?.throwIfAborted();
  return {
    content: [{ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/png' }],
    structuredContent: {
      width: info.width,
      height: info.height,
      mime_type: 'image/png' as const,
      bytes: image.length,
    },
  };
}

export async function imageResult(data: Buffer, maxSize: number, signal?: AbortSignal) {
  return withSlot(() => transform(data, maxSize, signal));
}

async function worker(
  action: string,
  project: string,
  signal?: AbortSignal,
  display = 0,
  maxSize = 1600,
) {
  const development = import.meta.url.endsWith('.ts');
  const filename = fileURLToPath(
    new URL(development ? './image-worker.ts' : './image-worker.js', import.meta.url),
  );
  return withSlot(
    async () =>
      JSON.parse(
        await captureProcess(
          process.execPath,
          [
            ...(development ? ['--import', 'tsx'] : []),
            filename,
            action,
            String(display),
            String(maxSize),
          ],
          project,
          signal,
        ),
      ) as unknown,
  );
}

export async function listDisplays(project = process.cwd(), signal?: AbortSignal) {
  return z
    .array(z.object({ index: z.number().int(), name: z.string() }))
    .parse(await worker('list', project, signal));
}

export async function captureScreen(
  displayIndex: number,
  maxSize: number,
  project = process.cwd(),
  signal?: AbortSignal,
) {
  return CallToolResultSchema.parse(
    await worker('capture', project, signal, displayIndex, maxSize),
  );
}

export async function readImage(
  files: Files,
  filename: string,
  maxSize: number,
  signal?: AbortSignal,
) {
  return withSlot(async () =>
    transform(await files.readBytes(filename, 16 * 1024 * 1024, signal), maxSize, signal),
  );
}
