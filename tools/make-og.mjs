/**
 * codepend — the link preview image.
 *
 *   node tools/make-og.mjs [--out site/og.png] [--seed 36] [--verify]
 *
 * When this project gets shared, the card image *is* the pitch — the name does not
 * describe the product, so the picture has to. 1200×630, written by pure Node.
 *
 * There is no image library here and there never will be, so this file contains three
 * things that are normally somebody else's problem:
 *
 *   1. A PNG encoder. CRC32 + `zlib.deflateSync` over raw scanlines, wrapped in
 *      IHDR/IDAT/IEND. ~60 lines, and a decoder next to it so the output is checked by
 *      reading it back rather than by trusting it.
 *   2. A rasteriser. art.js emits SVG, and rasterising SVG in Node needs a dependency,
 *      so the `dune` family's geometry is reimplemented straight into the pixel buffer —
 *      same seeded palette (via src/art.js), same sum-of-three-sines horizons.
 *   3. A stroke font. There is no font renderer either, so the glyphs are polylines on a
 *      unit em, drawn as round-capped anti-aliased strokes. It covers A–Z, a–z, 0–9 and a
 *      little punctuation — enough for the wordmark and two short lines, and it throws by
 *      name on anything it does not have. See docs/DEMO.md for what is bakeable.
 *
 * Deterministic: same seed → same pixels. No Math.random, no Date.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _internals } from '../src/art.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WIDTH = 1200;
const HEIGHT = 630;

/* ══════════════════════════════ 1. PNG ══════════════════════════════ */

/** Standard PNG/zlib CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} buf @returns {number} uint32 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(body.length - 4, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode 8-bit RGBA into a PNG.
 *
 * Every scanline is prefixed with filter byte 0 (None), as specified. That is the
 * honest, dumb choice and it costs real bytes on a smooth gradient — a Sub/Up filter
 * would compress better — but it keeps the encoder auditable in one screen and the
 * result still lands well inside the budget (see the size printed on build).
 *
 * @param {Uint8Array} rgba W*H*4
 * @param {number} w @param {number} h
 * @returns {Buffer}
 */
export function encodePNG(rgba, w, h) {
  if (rgba.length !== w * h * 4) throw new Error(`encodePNG: expected ${w * h * 4} bytes, got ${rgba.length}`);

  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = 0;                                  // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, o + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type 6 = truecolour + alpha
  ihdr[10] = 0;   // compression: deflate
  ihdr[11] = 0;   // filter method 0
  ihdr[12] = 0;   // interlace: none

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Read a PNG back and check everything the encoder claimed. This is the unit test:
 * signature, chunk order, every chunk CRC, IHDR fields, and that the inflated data is
 * exactly h × (1 + 4w) bytes with a zero filter byte on every scanline.
 *
 * @param {Buffer} buf
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,chunks:string[],pixels:Buffer}}
 */
export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('decodePNG: bad signature');
  let off = 8;
  const chunks = [];
  const idat = [];
  let hdr = null;

  while (off < buf.length) {
    if (off + 8 > buf.length) throw new Error('decodePNG: truncated chunk header');
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const end = off + 12 + len;
    if (end > buf.length) throw new Error(`decodePNG: truncated ${type} chunk`);
    const data = buf.subarray(off + 8, off + 8 + len);
    const want = buf.readUInt32BE(off + 8 + len);
    const got = crc32(buf.subarray(off + 4, off + 8 + len));
    if (want !== got) {
      throw new Error(`decodePNG: CRC mismatch in ${type} — stored ${want.toString(16)}, computed ${got.toString(16)}`);
    }
    chunks.push(type);
    if (type === 'IHDR') {
      hdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { off = end; break; }
    off = end;
  }

  if (!hdr) throw new Error('decodePNG: no IHDR');
  if (chunks[0] !== 'IHDR') throw new Error('decodePNG: IHDR must come first');
  if (chunks[chunks.length - 1] !== 'IEND') throw new Error('decodePNG: IEND must come last');
  if (!idat.length) throw new Error('decodePNG: no IDAT');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = hdr.width * 4;
  const expect = hdr.height * (stride + 1);
  if (raw.length !== expect) throw new Error(`decodePNG: inflated ${raw.length} bytes, expected ${expect}`);

  const pixels = Buffer.alloc(hdr.height * stride);
  for (let y = 0; y < hdr.height; y++) {
    const f = raw[y * (stride + 1)];
    if (f !== 0) throw new Error(`decodePNG: scanline ${y} uses filter ${f}, expected 0`);
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { ...hdr, chunks, pixels };
}

/* ══════════════════════════════ 2. canvas ══════════════════════════════ */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** Hermite smoothstep, clamped. */
const ss = (a, b, t) => { const x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };

/** `#rrggbb` → [r,g,b] 0..255. */
function hexRGB(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * An RGBA pixel buffer with exactly the primitives this image needs: source-over
 * compositing, an SDF rounded rect, and anti-aliased round-capped polyline strokes.
 * No paths, no fills, no clipping — anything more is a graphics library.
 */
class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    this._cov = new Float32Array(w * h);
  }

  /** Source-over one pixel. `a` is 0..1. */
  blend(x, y, r, g, b, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    if (a >= 1) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; return; }
    const ia = 1 - a;
    d[i] = r * a + d[i] * ia;
    d[i + 1] = g * a + d[i + 1] * ia;
    d[i + 2] = b * a + d[i + 2] * ia;
    d[i + 3] = 255 * a + d[i + 3] * ia;
  }

  /** Fill every pixel from a callback returning `[r,g,b,a]` or null. */
  paint(fn) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = fn(x, y);
        if (c) this.blend(x, y, c[0], c[1], c[2], c[3] === undefined ? 1 : c[3]);
      }
    }
  }

  /** Anti-aliased rounded rectangle via its signed distance field. */
  roundRect(x, y, w, h, r, color, alpha = 1) {
    const [cr, cg, cb] = hexRGB(color);
    const cx = x + w / 2, cy = y + h / 2;
    const hw = w / 2 - r, hh = h / 2 - r;
    const x0 = Math.max(0, Math.floor(x - 1)), x1 = Math.min(this.w - 1, Math.ceil(x + w + 1));
    const y0 = Math.max(0, Math.floor(y - 1)), y1 = Math.min(this.h - 1, Math.ceil(y + h + 1));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const qx = Math.abs(px + 0.5 - cx) - hw;
        const qy = Math.abs(py + 0.5 - cy) - hh;
        const mx = Math.max(qx, 0), my = Math.max(qy, 0);
        const d = Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - r;
        const cov = clamp(0.5 - d, 0, 1);
        if (cov > 0) this.blend(px, py, cr, cg, cb, cov * alpha);
      }
    }
  }

  /**
   * Stroke polylines with round caps and joins.
   *
   * Coverage accumulates with `max` into a scratch buffer before compositing, so
   * overlapping segments — every join, every letter with a crossbar — paint once. Adding
   * alpha instead is the classic way to get dark blobs at every corner.
   *
   * @param {number[][]} polys flat [x0,y0,x1,y1,…] arrays, device pixels
   * @param {number} width stroke width in px
   */
  stroke(polys, width, color, alpha = 1) {
    const [cr, cg, cb] = hexRGB(color);
    const rad = width / 2;
    const pad = Math.ceil(rad + 2);
    const cov = this._cov;
    let bx0 = this.w, by0 = this.h, bx1 = -1, by1 = -1;

    for (const p of polys) {
      const n = p.length / 2;
      const segs = n === 1 ? 1 : n - 1;
      for (let s = 0; s < segs; s++) {
        const ax = p[s * 2], ay = p[s * 2 + 1];
        const bx = n === 1 ? ax : p[s * 2 + 2];
        const by = n === 1 ? ay : p[s * 2 + 3];

        const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad));
        const x1 = Math.min(this.w - 1, Math.ceil(Math.max(ax, bx) + pad));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by) - pad));
        const y1 = Math.min(this.h - 1, Math.ceil(Math.max(ay, by) + pad));
        if (x1 < x0 || y1 < y0) continue;
        if (x0 < bx0) bx0 = x0; if (x1 > bx1) bx1 = x1;
        if (y0 < by0) by0 = y0; if (y1 > by1) by1 = y1;

        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        for (let py = y0; py <= y1; py++) {
          for (let px = x0; px <= x1; px++) {
            const vx = px + 0.5 - ax, vy = py + 0.5 - ay;
            let t = len2 > 0 ? (vx * dx + vy * dy) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = vx - t * dx, ey = vy - t * dy;
            const d = Math.sqrt(ex * ex + ey * ey);
            const c = clamp(rad + 0.5 - d, 0, 1);
            const i = py * this.w + px;
            if (c > cov[i]) cov[i] = c;
          }
        }
      }
    }

    for (let py = by0; py <= by1; py++) {
      for (let px = bx0; px <= bx1; px++) {
        const i = py * this.w + px;
        const c = cov[i];
        if (c > 0) { this.blend(px, py, cr, cg, cb, c * alpha); cov[i] = 0; }
      }
    }
  }
}

/* ══════════════════════════════ 3. stroke font ══════════════════════════════ */
/*
 * Unit em, y UP: baseline y = 0, cap height y = 1, x-height y = 0.72, ascender 1.02,
 * descender −0.22. Each glyph is `[advanceWidth, ...polylines]`, a polyline being a flat
 * [x,y,x,y,…] array. A one-point polyline is a dot (the round cap draws it).
 *
 * This is a stroke alphabet, not a text engine: no kerning, no shaping, no hinting, no
 * bidi, no combining marks, ASCII only. Enough for a wordmark and two lines of display
 * copy, which is all this file is allowed to want.
 */

/** Sample an elliptical arc. Angles in degrees, y up: (cx + rx·cos a, cy + ry·sin a). */
function arc(cx, cy, rx, ry, a0, a1, steps) {
  const n = steps || Math.max(6, Math.round(Math.abs(a1 - a0) / 9));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return out;
}
/** An arc continued into more explicit points, as one polyline. */
const join = (...parts) => [].concat(...parts);

const GLYPHS = {
  ' ': [0.30],

  /* ── uppercase ───────────────────────────────────────────────────── */
  A: [0.66, [0, 0, 0.33, 1, 0.66, 0], [0.11, 0.33, 0.55, 0.33]],
  B: [0.68, [0, 0, 0, 1],
    join([0, 1, 0.34, 1], arc(0.34, 0.74, 0.26, 0.26, 90, -90), [0, 0.48]),
    join([0, 0.48, 0.38, 0.48], arc(0.38, 0.24, 0.28, 0.24, 90, -90), [0, 0])],
  C: [0.68, arc(0.34, 0.5, 0.32, 0.5, 52, 308)],
  D: [0.66, [0, 0, 0, 1], join([0, 1, 0.28, 1], arc(0.28, 0.5, 0.36, 0.5, 90, -90), [0, 0])],
  E: [0.62, [0.60, 1, 0, 1, 0, 0, 0.60, 0], [0, 0.5, 0.50, 0.5]],
  F: [0.60, [0.58, 1, 0, 1, 0, 0], [0, 0.52, 0.48, 0.52]],
  G: [0.70, join(arc(0.34, 0.5, 0.32, 0.5, 52, 340), [0.66, 0.42, 0.40, 0.42])],
  H: [0.64, [0, 0, 0, 1], [0.64, 0, 0.64, 1], [0, 0.5, 0.64, 0.5]],
  I: [0.28, [0.14, 0, 0.14, 1]],
  J: [0.56, join([0.52, 1, 0.52, 0.26], arc(0.27, 0.26, 0.25, 0.26, 0, -180))],
  K: [0.62, [0, 0, 0, 1], [0.60, 1, 0.06, 0.40], [0.22, 0.55, 0.62, 0]],
  L: [0.58, [0, 1, 0, 0, 0.56, 0]],
  M: [0.76, [0, 0, 0, 1, 0.38, 0.26, 0.76, 1, 0.76, 0]],
  N: [0.64, [0, 0, 0, 1, 0.64, 0, 0.64, 1]],
  O: [0.70, arc(0.35, 0.5, 0.35, 0.5, 0, 360)],
  P: [0.64, [0, 0, 0, 1], join([0, 1, 0.34, 1], arc(0.34, 0.74, 0.28, 0.26, 90, -90), [0, 0.48])],
  Q: [0.72, arc(0.35, 0.5, 0.35, 0.5, 0, 360), [0.44, 0.20, 0.72, -0.10]],
  R: [0.66, [0, 0, 0, 1],
    join([0, 1, 0.34, 1], arc(0.34, 0.74, 0.28, 0.26, 90, -90), [0, 0.48]),
    [0.30, 0.48, 0.66, 0]],
  S: [0.62, [0.58, 0.85, 0.52, 0.94, 0.41, 1.00, 0.28, 1.00, 0.15, 0.96, 0.06, 0.87,
    0.04, 0.76, 0.09, 0.66, 0.20, 0.60, 0.36, 0.55, 0.49, 0.49, 0.57, 0.39,
    0.57, 0.26, 0.50, 0.13, 0.37, 0.03, 0.22, 0.00, 0.10, 0.03, 0.03, 0.10]],
  T: [0.68, [0.34, 0, 0.34, 1], [0, 1, 0.68, 1]],
  U: [0.64, join([0, 1, 0, 0.32], arc(0.32, 0.32, 0.32, 0.32, 180, 360), [0.64, 1])],
  V: [0.66, [0, 1, 0.33, 0, 0.66, 1]],
  W: [0.90, [0, 1, 0.22, 0, 0.45, 0.66, 0.68, 0, 0.90, 1]],
  X: [0.62, [0, 0, 0.62, 1], [0, 1, 0.62, 0]],
  Y: [0.64, [0, 1, 0.32, 0.48, 0.64, 1], [0.32, 0.48, 0.32, 0]],
  Z: [0.66, [0.02, 1, 0.62, 1, 0.02, 0, 0.64, 0]],

  /* ── lowercase ───────────────────────────────────────────────────── */
  a: [0.60, arc(0.28, 0.36, 0.28, 0.36, 0, 360), [0.56, 0.72, 0.56, 0]],
  b: [0.62, [0, 1.02, 0, 0], arc(0.31, 0.36, 0.28, 0.36, 0, 360)],
  c: [0.58, arc(0.30, 0.36, 0.28, 0.36, 52, 308)],
  d: [0.62, [0.56, 1.02, 0.56, 0], arc(0.28, 0.36, 0.28, 0.36, 0, 360)],
  e: [0.60, [0.02, 0.40, 0.56, 0.40], arc(0.29, 0.36, 0.28, 0.36, 8, 300)],
  f: [0.42, join(arc(0.32, 0.86, 0.18, 0.16, 10, 170), [0.14, 0]), [0, 0.70, 0.42, 0.70]],
  g: [0.62, arc(0.28, 0.36, 0.28, 0.36, 0, 360),
    join([0.56, 0.72, 0.56, -0.06], arc(0.30, -0.06, 0.26, 0.16, 0, -180))],
  h: [0.62, [0, 1.02, 0, 0], join(arc(0.31, 0.44, 0.31, 0.28, 180, 0), [0.62, 0])],
  i: [0.28, [0.14, 0.94], [0.14, 0.72, 0.14, 0]],
  j: [0.36, [0.26, 0.94], join([0.26, 0.72, 0.26, -0.06], arc(0.05, -0.06, 0.21, 0.16, 0, -180))],
  k: [0.56, [0, 1.02, 0, 0], [0.54, 0.72, 0.06, 0.28], [0.22, 0.42, 0.56, 0]],
  l: [0.28, [0.14, 1.02, 0.14, 0]],
  m: [1.12, [0, 0.72, 0, 0],
    join(arc(0.28, 0.46, 0.28, 0.26, 180, 0), [0.56, 0]),
    join(arc(0.84, 0.46, 0.28, 0.26, 180, 0), [1.12, 0])],
  n: [0.60, [0, 0.72, 0, 0], join(arc(0.30, 0.44, 0.30, 0.28, 180, 0), [0.60, 0])],
  o: [0.62, arc(0.31, 0.36, 0.31, 0.36, 0, 360)],
  p: [0.62, [0, 0.72, 0, -0.22], arc(0.31, 0.36, 0.28, 0.36, 0, 360)],
  q: [0.62, [0.56, 0.72, 0.56, -0.22], arc(0.28, 0.36, 0.28, 0.36, 0, 360)],
  r: [0.42, [0, 0.72, 0, 0], arc(0.30, 0.44, 0.30, 0.28, 180, 58)],
  s: [0.56, [0.52, 0.62, 0.46, 0.69, 0.35, 0.73, 0.22, 0.72, 0.11, 0.68, 0.05, 0.60,
    0.06, 0.51, 0.14, 0.45, 0.28, 0.41, 0.42, 0.37, 0.50, 0.30, 0.51, 0.20,
    0.45, 0.09, 0.32, 0.02, 0.18, 0.01, 0.07, 0.05, 0.02, 0.11]],
  t: [0.48, join([0.18, 1.00, 0.18, 0.12], arc(0.36, 0.12, 0.18, 0.12, 180, 340)),
    [0, 0.72, 0.44, 0.72]],
  u: [0.60, join([0, 0.72, 0, 0.28], arc(0.30, 0.28, 0.30, 0.28, 180, 360), [0.60, 0.72])],
  v: [0.58, [0, 0.72, 0.29, 0, 0.58, 0.72]],
  w: [0.84, [0, 0.72, 0.21, 0, 0.42, 0.50, 0.63, 0, 0.84, 0.72]],
  x: [0.54, [0, 0.72, 0.54, 0], [0, 0, 0.54, 0.72]],
  y: [0.60, [0, 0.72, 0.30, 0.06], [0.60, 0.72, 0.18, -0.22]],
  z: [0.58, [0.02, 0.72, 0.54, 0.72, 0.02, 0, 0.56, 0]],

  /* ── digits ──────────────────────────────────────────────────────── */
  0: [0.62, arc(0.31, 0.5, 0.30, 0.5, 0, 360)],
  1: [0.44, [0.08, 0.78, 0.30, 1.0, 0.30, 0]],
  2: [0.62, [0.03, 0.76, 0.07, 0.90, 0.19, 0.99, 0.33, 1.00, 0.47, 0.94, 0.54, 0.81,
    0.51, 0.66, 0.40, 0.52, 0.03, 0.02, 0.58, 0.02]],
  3: [0.62, [0.04, 0.86, 0.12, 0.96, 0.26, 1.00, 0.42, 0.97, 0.52, 0.87, 0.51, 0.74,
    0.40, 0.62, 0.26, 0.57, 0.42, 0.55, 0.55, 0.44, 0.56, 0.28, 0.48, 0.11,
    0.32, 0.01, 0.16, 0.01, 0.05, 0.08]],
  4: [0.64, [0.46, 0, 0.46, 1, 0.02, 0.28, 0.62, 0.28]],
  5: [0.62, [0.54, 1, 0.12, 1, 0.06, 0.58, 0.20, 0.64, 0.36, 0.64, 0.50, 0.56, 0.57, 0.42,
    0.55, 0.25, 0.45, 0.10, 0.28, 0.02, 0.12, 0.04, 0.03, 0.12]],
  6: [0.62, [0.54, 0.92, 0.42, 1.00, 0.28, 0.99, 0.15, 0.90, 0.06, 0.72, 0.03, 0.48,
    0.05, 0.28, 0.14, 0.12, 0.28, 0.02, 0.44, 0.04, 0.55, 0.14, 0.59, 0.30,
    0.54, 0.45, 0.41, 0.55, 0.25, 0.55, 0.12, 0.47, 0.05, 0.36]],
  7: [0.62, [0.02, 1, 0.62, 1, 0.24, 0]],
  8: [0.62, arc(0.31, 0.75, 0.27, 0.25, 0, 360), arc(0.31, 0.27, 0.31, 0.27, 0, 360)],
  9: [0.62, [0.08, 0.08, 0.20, 0.00, 0.34, 0.01, 0.47, 0.10, 0.56, 0.28, 0.59, 0.52,
    0.57, 0.72, 0.48, 0.88, 0.34, 0.98, 0.18, 0.96, 0.07, 0.86, 0.03, 0.70,
    0.08, 0.55, 0.21, 0.45, 0.37, 0.45, 0.50, 0.53, 0.57, 0.64]],

  /* ── punctuation ─────────────────────────────────────────────────── */
  ',': [0.26, [0.11, 0.07, 0.03, -0.14]],
  '.': [0.26, [0.10, 0.05]],
  '·': [0.34, [0.16, 0.40]],
  '+': [0.60, [0.06, 0.42, 0.54, 0.42], [0.30, 0.18, 0.30, 0.66]],
  '-': [0.46, [0.04, 0.42, 0.42, 0.42]],
  '—': [0.78, [0.02, 0.42, 0.76, 0.42]],
  '/': [0.46, [0.02, -0.06, 0.44, 1.02]],
  ':': [0.26, [0.10, 0.05], [0.10, 0.50]],
  "'": [0.22, [0.09, 1.02, 0.05, 0.72]],
  '!': [0.26, [0.11, 1.0, 0.11, 0.22], [0.11, 0.05]],
  '?': [0.56, [0.04, 0.80, 0.10, 0.93, 0.22, 1.00, 0.36, 0.99, 0.48, 0.91, 0.52, 0.78,
    0.47, 0.65, 0.35, 0.55, 0.29, 0.44, 0.29, 0.28], [0.29, 0.05]],
  '(': [0.36, arc(0.36, 0.44, 0.32, 0.62, 130, 230)],
  ')': [0.36, arc(0.00, 0.44, 0.32, 0.62, 50, -50)],
  '×': [0.56, [0.08, 0.62, 0.48, 0.22], [0.08, 0.22, 0.48, 0.62]],
};

/**
 * Side bearing. The tables above are *ink* widths — every glyph starts at x=0 and ends at
 * its advance — so setting them side by side welds the stems together: `codepend` came
 * out of the first build reading as "itrememoers". Real fonts carry whitespace inside the
 * advance; this is that whitespace, split either side of every glyph.
 */
const SB = 0.17;

/**
 * Measure a string in device pixels.
 * @throws if any character has no glyph — silently dropping one would ship a typo.
 */
function measure(text, size, tracking = 0) {
  let w = 0;
  const missing = new Set();
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (!g) { missing.add(ch); continue; }
    w += (g[0] + SB) * size + tracking;
  }
  if (missing.size) {
    throw new Error(
      `make-og: no glyph for ${[...missing].map((c) => JSON.stringify(c)).join(', ')} — `
      + 'the stroke font in tools/make-og.mjs covers A–Z a–z 0–9 and , . · + - — / : \' ! ? ( ) ×. '
      + 'Add the glyph or change the copy.',
    );
  }
  return w - (text.length ? tracking : 0);
}

/**
 * Draw a string. `y` is the baseline; the em box scales so glyph y=1 is `size` px above it.
 * @param {Canvas} cv
 * @param {{x:number,y:number,size:number,weight?:number,tracking?:number,color?:string,alpha?:number,align?:'left'|'center'}} o
 */
function text(cv, str, o) {
  const size = o.size;
  const tracking = o.tracking || 0;
  const weight = o.weight != null ? o.weight : size * 0.11;
  let x = o.x;
  if (o.align === 'center') x -= measure(str, size, tracking) / 2;

  const polys = [];
  for (const ch of str) {
    const g = GLYPHS[ch];
    const pen = x + (SB / 2) * size;            // half the side bearing sits left of the ink
    for (let i = 1; i < g.length; i++) {
      const src = g[i];
      const dst = new Array(src.length);
      for (let k = 0; k < src.length; k += 2) {
        dst[k] = pen + src[k] * size;
        dst[k + 1] = o.y - src[k + 1] * size;   // glyph y is up, device y is down
      }
      polys.push(dst);
    }
    x += (g[0] + SB) * size + tracking;
  }
  cv.stroke(polys, weight, o.color || '#ffffff', o.alpha == null ? 1 : o.alpha);
  return x - tracking;
}

/** Shrink `size` until the string fits `maxWidth`. Tracking scales with it. */
function fit(str, maxWidth, size, tracking) {
  let s = size, t = tracking;
  while (s > 6 && measure(str, s, t) > maxWidth) { s -= 0.5; t = tracking * (s / size); }
  return { size: s, tracking: t };
}

/* ══════════════════════════════ 4. the picture ══════════════════════════════ */

/** mulberry32 — the same generator art.js uses, so "seeded" means the same thing here. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r, a, b) => a + (b - a) * r();

/**
 * `dune` from src/art.js, rasterised.
 *
 * art.js emits SVG and there is no rasteriser in Node without a dependency, so the family
 * is reimplemented rather than rendered: same palette object, same sum-of-three-sines
 * horizon, same aerial-perspective lightness ramp (layers differ in lightness only —
 * alternating hues turn distance into a flag). What is lost is the blur filters, which is
 * why the sun gets a hand-rolled radial falloff instead.
 *
 * @param {Canvas} cv
 * @param {object} P paletteFull() record
 * @param {number} seed
 */
function paintDunes(cv, P, seed) {
  const { w, h } = cv;
  const r = rng(seed);
  const K = 6;

  // Sky: a vertical ramp on the palette's own hue, brightening toward the horizon.
  // Built as a per-row LUT through art.js's oklch() so the colour maths is the product's,
  // not an approximation of it — 630 conversions instead of 756 000. The brightening is
  // pushed late (ss 0.30→0.94) so the top stays near-black for the wordmark to sit on.
  const sky = [];
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    sky.push(hexRGB(P.tone(lerp(P.bgL * 0.44, P.bgL + 0.20, ss(0.30, 0.94, t)),
      lerp(P.bgC * 0.5, P.bgC * 2.8, ss(0.2, 1, t)), 0)));
  }
  cv.paint((x, y) => { const c = sky[y]; return [c[0], c[1], c[2], 1]; });

  // Horizon bloom around the sun — the light that makes the ridges read as distance.
  const SUNX = 0.872 * w, SUNY = 0.665 * h, SUNR = 0.064 * w;
  const bloom = hexRGB(P.tone(0.66, P.C[0] * 0.5, 0));
  cv.paint((x, y) => {
    const dx = (x - SUNX) / (w * 0.44), dy = (y - SUNY) / (h * 0.40);
    const a = 0.40 * Math.pow(clamp(1 - Math.sqrt(dx * dx + dy * dy), 0, 1), 2.1);
    return a > 0.004 ? [bloom[0], bloom[1], bloom[2], a] : null;
  });

  // Aerial perspective: the far ridge is the lightest thing on the ground and each one
  // forward steps darker, ending below the card's own background. Lightness only — a
  // second hue in here turns depth into a flag (see the art.js note).
  const far = clamp(P.bgL + 0.38, 0.04, 0.96);
  const near = clamp(P.bgL * 0.72, 0.02, 0.96);
  const layers = [];
  for (let i = 0; i < K; i++) {
    const t = i / (K - 1);
    layers.push({
      // Spread across 0.63→1.06 of the frame, so each ridge gets ~50px of visible band
      // and the front one runs off the bottom edge instead of stacking inside it.
      t,
      b: lerp(0.668, 1.07, t),
      amp: lerp(0.074, 0.022, t),
      k: [between(r, 1.2, 3.6), between(r, 1.2, 3.6), between(r, 1.2, 3.6)],
      ph: [r() * Math.PI * 2, r() * Math.PI * 2, r() * Math.PI * 2],
      a: [between(r, 0.4, 1), between(r, 0.2, 0.8), between(r, 0.1, 0.5)],
      fill: hexRGB(P.tone(lerp(far, near, t), lerp(P.C[0] * 0.62, P.bgC * 0.6, t), 0)),
    });
  }

  const curve = (L, xf) => {
    const sa = L.a[0] + L.a[1] + L.a[2];
    return (L.b + (L.amp * (
      L.a[0] * Math.sin(L.k[0] * xf + L.ph[0])
      + L.a[1] * Math.sin(L.k[1] * xf + L.ph[1])
      + L.a[2] * Math.sin(L.k[2] * xf + L.ph[2])
    )) / sa) * h;
  };

  for (let i = 0; i < K; i++) {
    const L = layers[i];

    // The sun goes down behind the very first ridge, so every layer from here forward
    // cuts across it. A disc floating clear of the horizon reads as a sticker on the
    // photograph — being partly eaten is the whole effect.
    if (i === 1) {
      const disc = hexRGB(P.tone(0.88, P.C[0] * 0.38, 0));
      const halo = hexRGB(P.tone(0.78, P.C[0] * 0.52, 0));
      const R = Math.ceil(SUNR * 3.4);
      for (let y = Math.max(0, Math.floor(SUNY - R)); y < Math.min(h, Math.ceil(SUNY + R)); y++) {
        for (let x = Math.max(0, Math.floor(SUNX - R)); x < Math.min(w, Math.ceil(SUNX + R)); x++) {
          const d = Math.hypot(x + 0.5 - SUNX, y + 0.5 - SUNY);
          const g = 0.46 * Math.pow(clamp(1 - d / (SUNR * 3.2), 0, 1), 2.4);
          if (g > 0.003) cv.blend(x, y, halo[0], halo[1], halo[2], g);
          const core = clamp(SUNR + 0.5 - d, 0, 1);
          if (core > 0) cv.blend(x, y, disc[0], disc[1], disc[2], core * 0.95);
        }
      }
    }

    for (let x = 0; x < w; x++) {
      const yc = curve(L, x / w);
      const top = Math.max(0, Math.floor(yc) - 1);
      for (let y = top; y < h; y++) {
        const cov = clamp(y + 1 - yc, 0, 1);
        if (cov > 0) cv.blend(x, y, L.fill[0], L.fill[1], L.fill[2], cov);
      }
    }
  }
}

/** The ember mark from the favicon: nine cells, the lit ones on the accent. */
function paintMark(cv, x, y, cell, gap, accent, ink, lit) {
  for (let i = 0; i < 9; i++) {
    const cx = x + (i % 3) * (cell + gap);
    const cy = y + Math.floor(i / 3) * (cell + gap);
    cv.roundRect(cx, cy, cell, cell, cell * 0.28, lit[i] ? accent : ink, lit[i] ? 1 : 0.20);
  }
}

const WORDMARK = 'codepend';
const PITCH = 'YOUR AI AGENT HISTORY, AS A PHOTO ALBUM';
const SUB = 'CLAUDE CODE + CODEX + CURSOR · RUNS LOCALLY · UPLOADS NOTHING';
const CTA = 'npx codepend';

/**
 * Compose the card.
 * @param {{seed?:number}} [opts]
 * @returns {Uint8ClampedArray} RGBA
 */
export function renderOG(opts = {}) {
  const seed = opts.seed == null ? 36 : opts.seed >>> 0;

  if (!_internals || typeof _internals.paletteFull !== 'function') {
    throw new Error('make-og: src/art.js no longer exports _internals.paletteFull — the OG image and the app would drift apart');
  }
  const P = _internals.paletteFull(seed, 'dark');

  const cv = new Canvas(WIDTH, HEIGHT);
  paintDunes(cv, P, seed ^ 0x5bf03635);

  // Scrim. The type is a column down the left; the sun sets on the right. So the
  // darkening is mostly horizontal, and it is deliberately gone by ~70% width — a scrim
  // wide enough to cover the sun would buy contrast nobody needs and flatten the picture.
  const [sr, sg, sb] = hexRGB(P.tone(0.05, P.bgC * 0.4, 0));
  cv.paint((x, y) => {
    const hx = 0.60 * (1 - ss(0.05, 0.70, x / WIDTH));
    const vy = 0.22 * ss(0.55, 1.0, y / HEIGHT);
    const a = clamp(hx + vy, 0, 0.86);
    return a > 0.004 ? [sr, sg, sb, a] : null;
  });

  const ink = P.fg;                 // #F4F1EC
  const accent = P.accents[0];      // the sky blue on seed 36
  const X = 88;
  // Capped well short of the frame: the lines have to clear the sun, and a headline that
  // runs the full 1200 is unreadable at the ~500px a timeline actually renders it.
  const MAX = 830;

  paintMark(cv, X, 74, 19, 6, accent, ink, [1, 1, 0, 1, 0, 1, 0, 1, 1]);

  const wm = fit(WORDMARK, MAX, 96, 0);
  text(cv, WORDMARK, {
    x: X, y: 258, size: wm.size, tracking: wm.tracking,
    weight: wm.size * 0.105, color: ink,
  });

  const pi = fit(PITCH, MAX, 33, 2.4);
  text(cv, PITCH, {
    x: X, y: 330, size: pi.size, tracking: pi.tracking,
    weight: pi.size * 0.115, color: accent,
  });

  const su = fit(SUB, MAX, 20, 2.2);
  text(cv, SUB, {
    x: X, y: 374, size: su.size, tracking: su.tracking,
    weight: su.size * 0.12, color: ink, alpha: 0.70,
  });

  // The command, set as the thing you can copy. Light pill, dark type — the same
  // inversion the demo page and the footer use, so the card and the site rhyme.
  const cta = { size: 27, tracking: 0.4 };
  const ctaW = measure(CTA, cta.size, cta.tracking);
  const padX = 28, padY = 20;
  const pillY = 430;
  cv.roundRect(X, pillY, ctaW + padX * 2, cta.size + padY * 2, 14, ink, 0.96);
  text(cv, CTA, {
    x: X + padX, y: pillY + padY + cta.size, size: cta.size, tracking: cta.tracking,
    weight: cta.size * 0.125, color: P.bg,
  });

  return cv.data;
}

/* ══════════════════════════════ 5. cli ══════════════════════════════ */

function parseArgs(argv) {
  const o = { out: resolve(ROOT, 'site/og.png'), seed: 36, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') o.out = resolve(process.cwd(), argv[++i]);
    else if (a.startsWith('--out=')) o.out = resolve(process.cwd(), a.slice(6));
    else if (a === '--seed') o.seed = Number(argv[++i]) >>> 0;
    else if (a.startsWith('--seed=')) o.seed = Number(a.slice(7)) >>> 0;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--verify') o.verifyOnly = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/make-og.mjs [--out site/og.png] [--seed 36] [--quiet]');
      process.exit(0);
    } else { console.error(`make-og: unknown option ${a}`); process.exit(2); }
  }
  return o;
}

/** Everything the encoder promised, checked against the bytes on disk. */
function verify(file, expectW, expectH) {
  const buf = readFileSync(file);
  const png = decodePNG(buf);
  const problems = [];
  if (png.width !== expectW || png.height !== expectH) {
    problems.push(`IHDR says ${png.width}×${png.height}, expected ${expectW}×${expectH}`);
  }
  if (png.bitDepth !== 8) problems.push(`bit depth ${png.bitDepth}, expected 8`);
  if (png.colorType !== 6) problems.push(`colour type ${png.colorType}, expected 6 (RGBA)`);
  if (png.interlace !== 0) problems.push('interlaced');
  if (png.pixels.length !== expectW * expectH * 4) problems.push('pixel buffer is the wrong length');
  // Fully transparent output would still pass every structural check above.
  let opaque = 0;
  for (let i = 3; i < png.pixels.length; i += 4) if (png.pixels[i] === 255) opaque++;
  if (opaque !== expectW * expectH) problems.push(`${expectW * expectH - opaque} pixels are not fully opaque`);
  if (problems.length) throw new Error(`make-og: verification failed — ${problems.join('; ')}`);
  return { png, bytes: buf.length };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.verifyOnly) {
    const rgba = renderOG({ seed: o.seed });
    const png = encodePNG(rgba, WIDTH, HEIGHT);
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, png);
  }
  const { png, bytes } = verify(o.out, WIDTH, HEIGHT);
  if (!o.quiet) {
    console.log(
      `make-og: ${o.verifyOnly ? 'checked' : 'wrote'} ${o.out} — ${png.width}×${png.height}, `
      + `${(bytes / 1024).toFixed(1)} KB, chunks [${png.chunks.join(' ')}], all CRCs ok`,
    );
  }
}

if (process.argv[1] && process.argv[1].endsWith('make-og.mjs')) main();

export { WIDTH, HEIGHT, GLYPHS, measure };
export default renderOG;
