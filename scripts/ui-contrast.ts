import type { Page } from '@playwright/test';

/** Checks declared colors for text whose background axe cannot infer from native/SVG layers. */
export async function declaredContrast(page: Page, selectors: string[]) {
  return page.evaluate((targets) => {
    type Color = [number, number, number, number];
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas is unavailable for color measurement');
    const colors = {
      parse(value: string): Color {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const bytes = context.getImageData(0, 0, 1, 1).data;
        return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]! / 255];
      },
      over(front: Color, back: Color): Color {
        return [
          front[0] * front[3] + back[0] * (1 - front[3]),
          front[1] * front[3] + back[1] * (1 - front[3]),
          front[2] * front[3] + back[2] * (1 - front[3]),
          1,
        ];
      },
      luminance([r, g, b]: Color) {
        const channels = [r, g, b].map((value) => {
          const scaled = value / 255;
          return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      },
    };
    return targets.flatMap((selector) => {
      const element = document.querySelector(selector);
      if (!element || element.closest(':disabled, [aria-disabled="true"]')) return [];
      const chain: Element[] = [];
      for (let current: Element | null = element; current; current = current.parentElement)
        chain.unshift(current);
      let background: Color = [255, 255, 255, 1];
      for (const ancestor of chain)
        background = colors.over(
          colors.parse(getComputedStyle(ancestor).backgroundColor),
          background,
        );
      const style = getComputedStyle(element);
      const foreground = colors.over(colors.parse(style.color), background);
      const a = colors.luminance(foreground);
      const b = colors.luminance(background);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const minimum = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
      return [{ selector, ratio, minimum }];
    });
  }, selectors);
}
