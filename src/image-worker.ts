import screenshot from 'screenshot-desktop';
import { imageResult } from './images.js';

try {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    throw new Error(
      'No graphical session is available; configure DISPLAY and a supported screenshot provider',
    );
  const displays = await screenshot.listDisplays();
  if (process.argv[2] === 'list') {
    process.stdout.write(
      JSON.stringify(displays.map((display, index) => ({ index, name: display.name }))),
    );
  } else {
    const index = Number(process.argv[3]),
      maxSize = Number(process.argv[4]);
    if (!Number.isInteger(index) || !Number.isInteger(maxSize) || maxSize < 320 || maxSize > 2560)
      throw new Error('Invalid capture arguments');
    const display = displays[index];
    if (!display) throw new Error('Display not found; call list_displays first');
    const data = await screenshot({ format: 'png', screen: display.id });
    process.stdout.write(JSON.stringify(await imageResult(data, maxSize)));
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
