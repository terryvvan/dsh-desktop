/**
 * Renders build/icon.png from the official DSH favicon that ships inside
 * @deepseek-ai/dsh-web-frontend. electron-builder converts the 1024×1024 PNG
 * into the multi-resolution .ico it embeds in the exe and the installer.
 *
 * No source artwork is modified: the whale path is copied verbatim out of
 * electron/logo.svg (itself a verbatim copy of the packaged favicon), so the
 * icon always tracks whatever the installed DSH runtime ships.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const logoSvgPath = path.join(projectRoot, 'electron', 'logo.svg');
const outDir = path.join(projectRoot, 'build');

const require = createRequire(import.meta.url);
const sharp = require(path.join(projectRoot, 'runtime', 'app', 'node_modules', 'sharp'));

const SIZE = 1024;
const PLATE = 228; // rounded-square corner radius
const ART = 758; // brand mark box inside the plate
const OFFSET = (SIZE - ART) / 2;

const raw = readFileSync(logoSvgPath, 'utf8');
const inner = raw
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/^[\s\S]*?<svg[^>]*>/i, '')
  .replace(/<\/svg>[\s\S]*$/i, '')
  .trim();

if (!/<path/i.test(inner)) {
  throw new Error(`no drawing found in ${logoSvgPath}`);
}

// The favicon's own viewBox is 0 0 50 50.
const scale = ART / 50;

// The favicon's own path carries a dark presentation attribute, so a CSS rule
// (which outranks presentation attributes) is what actually recolours the mark.
const composed = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <style>path, g, use { fill: #FFFFFF; }</style>
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="${SIZE}" y2="${SIZE}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#5A78FF"/>
      <stop offset="1" stop-color="#2B47D6"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="${PLATE}" ry="${PLATE}" fill="url(#plate)"/>
  <g transform="translate(${OFFSET} ${OFFSET}) scale(${scale.toFixed(4)})" fill="#FFFFFF" color="#FFFFFF">${inner}</g>
</svg>`;

mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, 'icon.png');
const svg = Buffer.from(composed);
await sharp(svg, { density: 384 }).resize(SIZE, SIZE).png().toFile(target);
writeFileSync(path.join(outDir, 'icon.svg'), composed, 'utf8');
console.log(`wrote ${target}`);

// ── multi-resolution .ico ────────────────────────────────────────────────────
//
// electron-builder's own PNG→ICO converter runs in WebAssembly and dies with
// "WebAssembly.Memory(): could not allocate memory" on this machine, so the
// shell ships a ready-made .ico instead. The container is trivial: a 6-byte
// ICONDIR, one 16-byte ICONDIRENTRY per image, then the image payloads. Windows
// Vista and later accept PNG-compressed entries at every size, which keeps this
// encoder free of any BMP/DIB bit-fiddling.

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const frames = [];
for (const size of ICO_SIZES) {
  frames.push({ size, data: await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer() });
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 1 = icon
header.writeUInt16LE(frames.length, 4);

const directory = Buffer.alloc(16 * frames.length);
let offset = header.length + directory.length;
frames.forEach(({ size, data }, index) => {
  const at = index * 16;
  directory.writeUInt8(size >= 256 ? 0 : size, at); // 0 encodes 256
  directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
  directory.writeUInt8(0, at + 2); // palette size
  directory.writeUInt8(0, at + 3); // reserved
  directory.writeUInt16LE(1, at + 4); // colour planes
  directory.writeUInt16LE(32, at + 6); // bits per pixel
  directory.writeUInt32LE(data.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += data.length;
});

const icoPath = path.join(outDir, 'icon.ico');
writeFileSync(icoPath, Buffer.concat([header, directory, ...frames.map((frame) => frame.data)]));
console.log(`wrote ${icoPath} (${ICO_SIZES.join(', ')} px)`);
