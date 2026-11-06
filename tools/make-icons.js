// 產生工具列圖示（藍底白色鎖頭）。只在開發時跑一次：node tools/make-icons.js
// 不依賴任何套件，自己組 PNG 檔，所以才需要下面這段 CRC 和 chunk 的程式。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 以下座標都用 0~1 的比例，畫完再放大到各尺寸。
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function shape(x, y) {
  // 回傳 [r, g, b, a]，用 4x4 超取樣在外層平均，所以這裡只管單點。
  if (!inRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return [0, 0, 0, 0];
  const body = inRoundedRect(x, y, 0.24, 0.47, 0.76, 0.86, 0.08);
  const dx = x - 0.5, dy = y - 0.47;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const shackle = y <= 0.47 && dist >= 0.12 && dist <= 0.21;
  const keyhole = (dx * dx + (y - 0.63) ** 2 <= 0.045 ** 2) || (Math.abs(dx) <= 0.025 && y >= 0.63 && y <= 0.76);
  if ((body && !keyhole) || shackle) return [255, 255, 255, 255];
  return [37, 99, 235, 255];
}
function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const [cr, cg, cb, ca] = shape((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; }
      out[i + 3] = a / (S * S);
    }
  }
  return png(size, size, out);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), render(size));
}
console.log('icons written to', dir);
