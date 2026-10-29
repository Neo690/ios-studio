#!/usr/bin/env node

// The icon the panel wears as an application: the same blue rounded square and
// white handset the page uses as its favicon, drawn here instead of shipped as
// an opaque binary, so the colour and the shape exist in one readable place.
//
// Windows wants a `.ico` whose largest image is 256×256, and a running window
// wants a `.png` for its taskbar entry, so both are written from the same
// pixels. No image library is involved: a PNG is a header, a zlib stream and a
// CRC per chunk; an ICO is a directory in front of PNG files. Node can write
// both on its own, which keeps this shell's dependency count at two (Electron
// and its packager) rather than three.
//
// Usage:  node desktop/studio/build-icon.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, 'assets');
const SIZE = 256;
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

// Geometry in 256px units, scaled from the favicon's 64px viewBox: the same
// proportions, drawn big enough for a taskbar to read.
const INSET = 8;
const CORNER = 54;
const STROKE = 13.1;
const PHONE = { cx: 128, cy: 128, halfW: 41.25, halfH: 71.25, r: 22.5 };
const DOT = { cx: 128, cy: 176.75, r: 9.75 };
// Top and bottom of the gradient; the page's --accent is the middle of it.
const TOP = [58, 166, 255];
const BOTTOM = [10, 99, 240];

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Signed distance to a rounded rectangle: negative inside, in pixels. */
function sdRoundRect(px, py, { cx, cy, halfW, halfH, r }) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  return (
    Math.min(Math.max(qx, qy), 0) +
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) -
    r
  );
}

/** Anti-aliased coverage from a signed distance: half a pixel of feather. */
const coverage = (distance) => clamp01(0.5 - distance);

/** The RGBA pixels of one 256×256 icon. */
function render(size = SIZE) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / SIZE;
  const square = {
    cx: size / 2,
    cy: size / 2,
    halfW: (SIZE - 2 * INSET) * scale * 0.5,
    halfH: (SIZE - 2 * INSET) * scale * 0.5,
    r: CORNER * scale,
  };
  const phone = {
    cx: PHONE.cx * scale,
    cy: PHONE.cy * scale,
    halfW: PHONE.halfW * scale,
    halfH: PHONE.halfH * scale,
    r: PHONE.r * scale,
  };
  const dot = { cx: DOT.cx * scale, cy: DOT.cy * scale, r: DOT.r * scale };
  const stroke = STROKE * scale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const inside = coverage(sdRoundRect(px, py, square));
      const index = (y * size + x) * 4;
      if (inside <= 0) continue;

      const t = y / (size - 1);
      let r = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
      let g = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
      let b = TOP[2] + (BOTTOM[2] - TOP[2]) * t;

      // The handset is a stroked outline plus a filled home dot, so the gradient
      // shows through the middle of the phone exactly as it does in the favicon.
      const outline = coverage(
        Math.abs(sdRoundRect(px, py, phone)) - stroke / 2,
      );
      const home = coverage(Math.hypot(px - dot.cx, py - dot.cy) - dot.r);
      const white = Math.max(outline, home);
      if (white > 0) {
        r += (255 - r) * white;
        g += (255 - g) * white;
        b += (255 - b) * white;
      }

      rgba[index] = Math.round(r);
      rgba[index + 1] = Math.round(g);
      rgba[index + 2] = Math.round(b);
      rgba[index + 3] = Math.round(inside * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC of type+data. */
function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');
  const body = Buffer.concat([header.subarray(4), data]);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([header, data, trailer]);
}

/** A truecolour-with-alpha PNG of one square image. */
function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    // Filter type 0: the rows are already smooth gradients, so nothing is worth
    // predicting here and a fixed filter keeps this readable.
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Area-averaged downscale, through premultiplied alpha so edges keep their colour. */
function downscale(rgba, from, to) {
  const out = Buffer.alloc(to * to * 4);
  const ratio = from / to;
  for (let y = 0; y < to; y += 1) {
    const y0 = Math.floor(y * ratio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ratio));
    for (let x = 0; x < to; x += 1) {
      const x0 = Math.floor(x * ratio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * ratio));
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * from + sx) * 4;
          const weight = rgba[index + 3] / 255;
          r += rgba[index] * weight;
          g += rgba[index + 1] * weight;
          b += rgba[index + 2] * weight;
          alpha += weight;
          count += 1;
        }
      }
      const index = (y * to + x) * 4;
      out[index] = alpha ? Math.round(r / alpha) : 0;
      out[index + 1] = alpha ? Math.round(g / alpha) : 0;
      out[index + 2] = alpha ? Math.round(b / alpha) : 0;
      out[index + 3] = Math.round((alpha / count) * 255);
    }
  }
  return out;
}

/** An ICO holding one PNG per size; Windows has read PNG entries since Vista. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = [];
  let offset = 6 + images.length * 16;
  for (const { size, bytes } of images) {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0: the field is one byte wide.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette size
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(bytes.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += bytes.length;
    directory.push(entry);
  }

  return Buffer.concat([
    header,
    ...directory,
    ...images.map((image) => image.bytes),
  ]);
}

const pixels = render(SIZE);
const images = ICO_SIZES.map((size) => ({
  size,
  bytes: png(size, size === SIZE ? pixels : downscale(pixels, SIZE, size)),
}));

mkdirSync(ASSETS, { recursive: true });
const pngPath = path.join(ASSETS, 'icon.png');
const icoPath = path.join(ASSETS, 'icon.ico');
writeFileSync(pngPath, images[images.length - 1].bytes);
writeFileSync(icoPath, ico(images));

console.log(`icon: ${pngPath} (${SIZE}px)`);
console.log(
  `icon: ${icoPath} (${ICO_SIZES.join(', ')}px, ${ICO_SIZES.length} images)`,
);
