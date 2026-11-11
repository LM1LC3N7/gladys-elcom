// Generates cover.png (800x534) for gladys-elcom: plain Node, no dependency.
// A lightning bolt above rising price bars and a row of house roofs, on a
// deep red to slate gradient (no ElCom logo, no official emblem).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x + y) / (W + H);
    set(x, y, [150 - 110 * t, 30 + 20 * t, 40 + 50 * t]);
  }
}
const rect = (x0, y0, w, h, color, alpha = 1) => {
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, color, alpha);
};
// Inside test of a polygon (even-odd), filled with anti-aliasing by 4x4 samples.
const polygon = (points, color) => {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y += 1) {
    for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy += 1)
        for (let sx = 0; sx < 4; sx += 1) hits += inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
      if (hits) set(x, y, color, hits / 16);
    }
  }
};
const white = [245, 246, 250];
const amber = [255, 200, 70];

// Price bars.
for (let i = 0; i < 9; i += 1) {
  const h = 60 + i * 22 + (i % 3) * 14;
  rect(120 + i * 64, 420 - h, 40, h, white, 0.22 + i * 0.03);
}
// The bolt.
polygon(
  [
    [430, 40],
    [300, 270],
    [395, 270],
    [340, 470],
    [520, 210],
    [420, 210],
    [490, 40],
  ],
  amber,
);
// Roofs.
rect(0, 470, W, 64, [30, 30, 45], 0.6);
for (let i = 0; i < 8; i += 1) {
  const x = 30 + i * 100;
  polygon(
    [
      [x, 470],
      [x + 35, 438],
      [x + 70, 470],
    ],
    white,
  );
  rect(x + 10, 470, 50, 40, white, 0.85);
}
// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
