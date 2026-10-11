// Minimal PNG encoder (RGBA8) using only node:zlib - no dependencies.
import zlib from 'node:zlib';

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// colour-index image (0..3, 255 = don't care) -> greyscale PNG, optional upscale
export function indexToPng(idx, w, h, scale = 1) {
  const shades = [0xe8, 0xa8, 0x60, 0x18];
  const W = w * scale, H = h * scale;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = idx[((y / scale) | 0) * w + ((x / scale) | 0)];
    const o = (y * W + x) * 4;
    if (v === 255) { out[o] = 0xff; out[o + 1] = 0x00; out[o + 2] = 0xff; }
    else out[o] = out[o + 1] = out[o + 2] = shades[v];
    out[o + 3] = 255;
  }
  return encodePng(W, H, out);
}
