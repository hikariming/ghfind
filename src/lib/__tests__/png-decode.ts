/**
 * Minimal PNG reader for the card layout test.
 *
 * `next/og` rasterizes to a real 8-bit RGBA PNG, so the test needs to look at
 * actual pixels. Pulling in a decoder for one assertion is overkill — this
 * inflates the IDAT stream with the stdlib and un-filters the scanlines, which
 * is all the probe pass needs. Non-interlaced, 8-bit RGB/RGBA only, which is
 * what resvg emits.
 */
import { inflateSync } from "node:zlib";

export interface Bitmap {
  width: number;
  height: number;
  channels: number;
  /** RGBA, 4 bytes per pixel. */
  data: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf: Buffer): Bitmap {
  if (buf.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("not a PNG");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      switch (filter) {
        case 0:
          cur[x] = v;
          break;
        case 1:
          cur[x] = (v + a) & 0xff;
          break;
        case 2:
          cur[x] = (v + b) & 0xff;
          break;
        case 3:
          cur[x] = (v + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          cur[x] = (v + paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`bad filter ${filter}`);
      }
    }
  }

  // Normalize to RGBA so callers have one layout to reason about.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = out[i * channels];
    rgba[i * 4 + 1] = out[i * channels + 1];
    rgba[i * 4 + 2] = out[i * channels + 2];
    rgba[i * 4 + 3] = channels === 4 ? out[i * channels + 3] : 255;
  }
  return { width, height, channels: 4, data: rgba };
}
