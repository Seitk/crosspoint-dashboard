// Pure, framework-free frame utilities shared by the browser renderer and the
// node test runner. No DOM, no React — safe to `import` from `node --test`.
//
// The X3 panel is 1-bit. We threshold an antialiased RGBA canvas down to pure
// black/white here so the exported PNG contains only two colors, and the
// on-device decoder maps them straight to the framebuffer.

/** ITU-R BT.601 luma of an 8-bit RGB triple. */
export function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Threshold an RGBA buffer to pure black/white. Pixels whose luminance is
 * >= `threshold` become white (255), the rest black (0). Alpha is forced opaque.
 * Returns a new buffer; the input is not mutated.
 *
 * @param {Uint8ClampedArray|Uint8Array|number[]} rgba
 * @param {number} [threshold=128]
 * @returns {Uint8ClampedArray}
 */
export function thresholdRgbaToMono(rgba, threshold = 128) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    // Round to an integer so an even gray (e.g. 128,128,128) isn't pushed below
    // the threshold by float error (0.299+0.587+0.114 !== 1.0 exactly).
    const white = Math.round(luminance(rgba[i], rgba[i + 1], rgba[i + 2])) >= threshold;
    const v = white ? 255 : 0;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}

/** Row stride in bytes for a 1-bpp packed image of `width` px (8 px per byte). */
export function monoStride(width) {
  return Math.ceil(width / 8);
}

/**
 * Byte length of a 1-bpp packed frame — matches the X3 framebuffer size when
 * called with the device geometry (792x528 -> 52272 bytes).
 * @param {number} width @param {number} height
 */
export function monoFrameBytes(width, height) {
  return monoStride(width) * height;
}

/**
 * Pack a mono RGBA buffer (already black/white) into 1-bpp bytes, MSB-first,
 * with bit value 1 = white. This is the raw-framebuffer form; the PNG transport
 * path does not send it, but it defines the "easily rendered" contract and is
 * unit-tested. On-device polarity is decided by the firmware blit.
 *
 * @param {Uint8ClampedArray|Uint8Array|number[]} monoRgba
 * @param {number} width @param {number} height
 * @returns {Uint8Array}
 */
export function packMonoToBits(monoRgba, width, height) {
  const stride = monoStride(width);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const white = monoRgba[(y * width + x) * 4] >= 128;
      if (white) {
        out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}
