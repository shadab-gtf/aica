/**
 * Generate the Marketplace icon.
 *
 * The activity-bar icon is an SVG and stays one — VS Code renders it as a
 * monochrome mask and it scales. The *Marketplace* icon is a different thing:
 * it is required to be a raster image, so the `icon` field in `package.json`
 * cannot point at the SVG. Pointing it there is the mistake that makes `vsce
 * package` fail at the last step.
 *
 * Written by hand rather than pulled from an image library. A 128×128 PNG is a
 * header, one deflate stream and a checksum, all of which Node has built in;
 * adding a dependency that runs at package time to draw six rectangles would
 * cost more than it saves.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SIZE = 128;

/** Colours, matching the dashboard's palette so the two look related. */
const BACKGROUND = [16, 19, 23, 255];
const LINE = [139, 149, 161, 255];
const ACCENT = [98, 168, 255, 255];

const pixels = new Uint8Array(SIZE * SIZE * 4);

function set(x, y, colour) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const offset = (y * SIZE + x) * 4;
  pixels[offset] = colour[0];
  pixels[offset + 1] = colour[1];
  pixels[offset + 2] = colour[2];
  pixels[offset + 3] = colour[3];
}

function rectangle(x, y, width, height, colour, radius = 0) {
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      if (radius > 0) {
        // Round the corners by rejecting anything outside the corner circles.
        const cx = Math.min(dx, width - 1 - dx);
        const cy = Math.min(dy, height - 1 - dy);
        if (cx < radius && cy < radius) {
          const ox = radius - cx;
          const oy = radius - cy;
          if (ox * ox + oy * oy > radius * radius) continue;
        }
      }
      set(x + dx, y + dy, colour);
    }
  }
}

function ring(cx, cy, outer, thickness, colour) {
  const inner = outer - thickness;
  for (let y = cy - outer; y <= cy + outer; y += 1) {
    for (let x = cx - outer; x <= cx + outer; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance <= outer && distance >= inner) set(x, y, colour);
    }
  }
}

// Background (Vercel-like dark mode)
rectangle(0, 0, SIZE, SIZE, BACKGROUND);

// A simple, bold 'A'
// Left pillar
rectangle(32, 28, 16, 72, ACCENT, 4);
// Right pillar
rectangle(80, 28, 16, 72, ACCENT, 4);
// Top bridge
rectangle(32, 28, 64, 16, ACCENT, 4);
// Center bridge
rectangle(32, 60, 64, 16, ACCENT, 4);

/** PNG needs a filter byte in front of every scanline; 0 means "none". */
function withFilterBytes(raw) {
  const out = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y += 1) {
    const from = y * SIZE * 4;
    const to = y * (SIZE * 4 + 1);
    out[to] = 0;
    Buffer.from(raw.buffer, from, SIZE * 4).copy(out, to + 1);
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // colour type: RGBA
// 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace.

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(withFilterBytes(pixels), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'media',
  'icon.png',
);

writeFileSync(target, png);
console.log(`wrote ${target} (${SIZE}x${SIZE}, ${png.length} bytes)`);
