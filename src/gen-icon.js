'use strict';
// One-shot: build a 64x64 RGBA PNG (blue gradient disc with a ring) -> src/icon.png
// Pure Node (zlib), no image libs.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 64;
const buf = Buffer.alloc(S * (1 + S * 4)); // each row: 1 filter byte + RGBA
let o = 0;
const cx = S / 2 - 0.5, cy = S / 2 - 0.5;
for (let y = 0; y < S; y++) {
  buf[o++] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    let r = 0, g = 0, b = 0, a = 0;
    if (d <= 30) {
      const t = d / 30;
      r = Math.round(91 - 30 * t);
      g = Math.round(140 - 40 * t);
      b = 255;
      a = 255;
      if (d > 20 && d < 26) { r = 255; g = 255; b = 255; } // inner ring accent
    }
    buf[o++] = r; buf[o++] = g; buf[o++] = b; buf[o++] = a;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const idat = zlib.deflateSync(buf);
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('icon.png written', png.length);
