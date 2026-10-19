/*
 * Generates the extension icons without any third-party image dependency.
 * Run with: npm run icons
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'extension', 'icons');
const sizes = [16, 48, 128];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const body = Buffer.concat([name, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function roundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function circle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function scalePolygon(points, amount) {
  const cx = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  const scale = 1 - amount;
  return points.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale]);
}

const cursor = [
  [0.400, 0.330],
  [0.400, 0.790],
  [0.525, 0.665],
  [0.615, 0.875],
  [0.705, 0.830],
  [0.620, 0.620],
  [0.790, 0.620]
];
const cursorInner = scalePolygon(cursor, 0.10);

function rgba(r, g, b, a = 1) {
  return [r, g, b, a];
}

function blend(base, top) {
  const alpha = top[3] + base[3] * (1 - top[3]);
  if (!alpha) return [0, 0, 0, 0];
  return [
    (top[0] * top[3] + base[0] * base[3] * (1 - top[3])) / alpha,
    (top[1] * top[3] + base[1] * base[3] * (1 - top[3])) / alpha,
    (top[2] * top[3] + base[2] * base[3] * (1 - top[3])) / alpha,
    alpha
  ];
}

function sample(x, y) {
  let color = [0, 0, 0, 0];

  if (roundedRect(x, y, 0.015, 0.015, 0.985, 0.985, 0.215)) {
    const t = Math.max(0, Math.min(1, (x + y) / 2));
    color = [
      Math.round(12 + 16 * t),
      Math.round(23 + 27 * t),
      Math.round(42 + 38 * t),
      1
    ];

    const glow = Math.max(0, 1 - Math.hypot(x - 0.20, y - 0.12) / 0.75);
    color = blend(color, [37, 99, 235, 0.26 * glow]);

    const bottomGlow = Math.max(0, 1 - Math.hypot(x - 0.86, y - 0.88) / 0.55);
    color = blend(color, [34, 197, 94, 0.16 * bottomGlow]);

    // Browser window card with a dark rim and a cyan title bar.
    if (roundedRect(x, y, 0.155, 0.165, 0.825, 0.700, 0.075)) {
      color = [15, 23, 42, 1];
    }
    if (roundedRect(x, y, 0.180, 0.190, 0.800, 0.675, 0.060)) {
      color = [248, 250, 252, 1];
    }
    if (y < 0.330 && roundedRect(x, y, 0.180, 0.190, 0.800, 0.675, 0.060)) {
      color = [56, 189, 248, 1];
    }
    for (const cx of [0.262, 0.326, 0.390]) {
      if (circle(x, y, cx, 0.260, 0.018)) color = [248, 250, 252, 0.92];
    }
    if (y > 0.390 && y < 0.430 && roundedRect(x, y, 0.240, 0.240, 0.740, 0.660, 0.055)) {
      color = [203, 213, 225, 0.92];
    }
    if (y > 0.475 && y < 0.512 && x > 0.240 && x < 0.630) {
      color = [226, 232, 240, 0.95];
    }
    if (y > 0.555 && y < 0.592 && x > 0.240 && x < 0.545) {
      color = [226, 232, 240, 0.95];
    }

    // Cursor with a dark outline.
    if (polygon(x, y, cursor)) color = [15, 23, 42, 1];
    if (polygon(x, y, cursorInner)) color = [255, 255, 255, 1];

    // Connection status badge.
    if (circle(x, y, 0.815, 0.815, 0.128)) color = [248, 250, 252, 1];
    if (circle(x, y, 0.815, 0.815, 0.098)) color = [34, 197, 94, 1];
    if (circle(x, y, 0.788, 0.788, 0.032)) color = [134, 239, 172, 0.9];
  }

  return color;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = size <= 32 ? 8 : 4;
  const total = samples * samples;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          const color = sample(x, y);
          r += color[0] * color[3];
          g += color[1] * color[3];
          b += color[2] * color[3];
          a += color[3];
        }
      }

      const offset = (py * size + px) * 4;
      if (a > 0) {
        pixels[offset] = Math.round(r / a);
        pixels[offset + 1] = Math.round(g / a);
        pixels[offset + 2] = Math.round(b / a);
        pixels[offset + 3] = Math.round((a / total) * 255);
      }
    }
  }

  return encodePng(size, size, pixels);
}

mkdirSync(outDir, { recursive: true });
for (const size of sizes) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, render(size));
  console.log(`generated ${file}`);
}
