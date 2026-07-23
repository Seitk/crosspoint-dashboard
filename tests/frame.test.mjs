import assert from "node:assert/strict";
import test from "node:test";

import {
  luminance,
  monoFrameBytes,
  monoStride,
  packMonoToBits,
  thresholdRgbaToMono,
} from "../app/dashboard/monochrome.js";

test("luminance weights green most", () => {
  assert.ok(luminance(0, 255, 0) > luminance(255, 0, 0));
  assert.ok(luminance(255, 0, 0) > luminance(0, 0, 255));
});

test("thresholds each pixel to pure black or white", () => {
  // light gray, dark gray
  const rgba = new Uint8ClampedArray([200, 200, 200, 255, 40, 40, 40, 255]);
  const mono = thresholdRgbaToMono(rgba, 128);
  assert.equal(mono[0], 255); // light -> white
  assert.equal(mono[1], 255);
  assert.equal(mono[2], 255);
  assert.equal(mono[4], 0); // dark -> black
  assert.equal(mono[3], 255); // alpha forced opaque
  assert.equal(mono[7], 255);
});

test("threshold boundary is inclusive (>= is white)", () => {
  const rgba = new Uint8ClampedArray([128, 128, 128, 255]);
  const mono = thresholdRgbaToMono(rgba, 128);
  assert.equal(mono[0], 255);
});

test("stride and frame size match the X3 panel (792x528)", () => {
  assert.equal(monoStride(792), 99);
  assert.equal(monoFrameBytes(792, 528), 52272);
});

test("packs bits MSB-first with 1 = white", () => {
  // one 8px row: first pixel white, rest black -> 0b1000_0000
  const row = new Uint8ClampedArray(8 * 4);
  row[0] = 255;
  row[1] = 255;
  row[2] = 255;
  row[3] = 255;
  const packed = packMonoToBits(row, 8, 1);
  assert.equal(packed.length, 1);
  assert.equal(packed[0], 0x80);
});

test("packing respects row stride padding", () => {
  // width 12 -> stride 2 bytes/row; last pixel of row 0 white
  const px = new Uint8ClampedArray(12 * 4);
  px[11 * 4] = 255;
  px[11 * 4 + 1] = 255;
  px[11 * 4 + 2] = 255;
  const packed = packMonoToBits(px, 12, 1);
  assert.equal(packed.length, 2);
  assert.equal(packed[1], 0b0001_0000); // bit index 11 -> byte 1, MSB offset 3
});
