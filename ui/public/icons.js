const paths = {
  link: [
    'M9 15 15 9',
    'M7.5 16.5 6 18a4.25 4.25 0 0 1-6-6l4-4a4.25 4.25 0 0 1 6 0',
    'm16.5 7.5 1.5-1.5a4.25 4.25 0 0 1 6 6l-4 4a4.25 4.25 0 0 1-6 0',
  ],
  connection: ['M5 15h14V4H5zM9 20h6M12 15v5', 'm9 8 2 2 4-4'],
  shield: ['m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6z', 'm8 12 3 3 5-6'],
  key: ['M14 13a5 5 0 1 0-3-3L3 18v3h4v-3h3v-3z'],
  requests: ['M6 4h12v17l-6-3-6 3z', 'M9 8h6M9 11h4'],
  servers: ['M4 3h16v7H4zM4 14h16v7H4z', 'M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6'],
  telegram: ['m3 10 18-7-4 18-6-6-4 2v-5z', 'm7 12 9-5-5 8'],
  log: ['M5 3h10l4 4v14H5z', 'M14 3v5h5M8 12h8M8 16h6'],
  settings: [
    'm9 3-1 3-3 1-2 3 2 3v4l3 2 4-1 3 1 3-2v-4l2-3-2-3-3-1-1-3z',
    'M15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  ],
  copy: ['M8 8h12v13H8zM16 8V3H3v13h5'],
  refresh: ['M20 7v5h-5M4 17v-5h5', 'M4 8a8 8 0 0 1 13-4l3 3M20 16a8 8 0 0 1-13 4l-3-3'],
  check: ['m5 12 4 4L19 6'],
  close: ['m6 6 12 12M6 18 18 6'],
  plus: ['M12 5v14M5 12h14'],
  arrow: ['M5 12h14m-5-5 5 5-5 5'],
  chevron: ['m9 5 7 7-7 7'],
  down: ['m6 9 6 6 6-6'],
  external: ['M14 3h7v7M21 3 11 13M10 5H4v15h15v-6'],
  cloud: ['M6 18a4.5 4.5 0 1 1 .5-9A6 6 0 0 1 18 8a5 5 0 0 1 0 10z'],
  monitor: ['M3 4h18v13H3zM8 21h8M12 17v4'],
  bolt: ['m13 2-8 12h6l-1 8 9-12h-7z'],
  globe: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18'],
  alert: ['m12 3 10 18H2z', 'M12 9v5M12 17v.1'],
  info: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M12 11v6M12 7v.1'],
  power: ['M12 2v10', 'M6 5a9 9 0 1 0 12 0'],
  pause: ['M8 5v14M16 5v14'],
  play: ['m8 4 12 8-12 8z'],
  trash: ['M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7'],
  edit: ['m15 3 6 6-11 11-7 1 1-7zM12 6l6 6'],
  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  file: ['M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h5'],
  terminal: ['M3 4h18v16H3z', 'm6 8 4 4-4 4M13 16h5'],
  camera: ['M3 7h4l2-3h6l2 3h4v13H3z', 'M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
  sun: [
    'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1',
    'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  ],
  moon: ['M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11z'],
  search: ['M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0M15 15l6 6'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M12 6v6l4 2'],
};

export function icon(name, className = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const attrs = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: `icon ${className}`,
  };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  for (const d of paths[name] ?? paths.info) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
