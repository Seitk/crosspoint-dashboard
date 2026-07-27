// Browser-only: draw a Dashboard config onto a 2D canvas and export it as a
// 1-bit PNG ready to push to the X3. Kept separate from monochrome.js (which is
// pure/DOM-free) so the pixel logic stays unit-testable in node.

import type { Dashboard, PlacedWidget } from "./types";
import { anchorX, fieldLayout } from "./fields.js";
import { packMonoToBits, thresholdRgbaToMono } from "./monochrome.js";

export function drawDashboard(ctx: CanvasRenderingContext2D, dash: Dashboard): void {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, dash.width, dash.height);
  ctx.fillStyle = "#000000";
  ctx.strokeStyle = "#000000";
  ctx.textBaseline = "top";
  for (const widget of dash.widgets) drawWidget(ctx, widget);
}

/**
 * Draw a widget from its computed field boxes. Positions and sizes are decided by
 * fields.js — the same module the editor overlay hit-tests against — so what you
 * click is exactly what was drawn, and no field can spill outside its tile.
 */
function drawWidget(ctx: CanvasRenderingContext2D, widget: PlacedWidget): void {
  ctx.lineWidth = 2;
  ctx.strokeRect(widget.x + 1, widget.y + 1, widget.w - 2, widget.h - 2);
  for (const field of fieldLayout(widget, widget) as FieldBox[]) {
    drawField(ctx, field);
  }
}

/** One resolved field box from fields.js. */
type FieldBox = {
  key: string;
  text: string | string[];
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  align: CanvasTextAlign;
  weight: number;
  upper: boolean;
  multiline: boolean;
  middle: boolean;
  rule: boolean;
  lineHeight: number;
  maxLines: number;
};

function drawField(ctx: CanvasRenderingContext2D, f: FieldBox): void {
  ctx.font = `${f.weight} ${f.size}px sans-serif`;
  ctx.textAlign = f.align;
  const x = anchorX(f) as number;

  if (f.multiline) {
    // List items get a bullet; a text block splits on newlines. Either way only
    // the lines that fit are drawn — maxLines comes from the box height.
    const lines = Array.isArray(f.text)
      ? f.text.map((item) => `• ${item}`)
      : String(f.text).split("\n");
    const shown = lines.slice(0, f.maxLines);
    let y = f.middle ? f.y + f.h / 2 - (shown.length * f.lineHeight) / 2 : f.y;
    for (const line of shown) {
      ctx.fillText(clip(ctx, line, f.w), x, y);
      y += f.lineHeight;
    }
    return;
  }

  const text = f.upper ? String(f.text).toUpperCase() : String(f.text);
  if (text) ctx.fillText(clip(ctx, text, f.w), x, f.y);

  // The list title carries a rule along the bottom of its box.
  if (f.rule) {
    const ruleY = Math.round(f.y + f.h - 2);
    ctx.beginPath();
    ctx.moveTo(f.x, ruleY);
    ctx.lineTo(f.x + f.w, ruleY);
    ctx.stroke();
  }
}

/** Truncate a string with an ellipsis so it fits within `maxWidth` px. */
function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s + "…";
}

/** Overwrite a canvas with the 1-bit (thresholded) version of its own pixels. */
export function applyMonochrome(canvas: HTMLCanvasElement, threshold = 128): void {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Threshold, then write back into the same ImageData (its buffer already has
  // the exact type putImageData wants).
  img.data.set(thresholdRgbaToMono(img.data, threshold));
  ctx.putImageData(img, 0, 0);
}

/**
 * Export the dashboard as a 1-bit PNG (pixels thresholded to pure black/white).
 * Renders to an offscreen canvas so the on-screen preview is left untouched.
 */
export async function exportMonoPng(
  source: HTMLCanvasElement,
  threshold = 128,
): Promise<Blob> {
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  const img = ctx.getImageData(0, 0, source.width, source.height);
  img.data.set(thresholdRgbaToMono(img.data, threshold));

  const off = document.createElement("canvas");
  off.width = source.width;
  off.height = source.height;
  const offCtx = off.getContext("2d");
  if (!offCtx) throw new Error("2D context unavailable");
  offCtx.putImageData(img, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    off.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))),
      "image/png",
    );
  });
}

/**
 * Export the canvas as the exact packed 1-bpp framebuffer the X3 blits directly:
 * MSB-first, bit 1 = white, row stride ceil(width/8). This is what `POST /frame`
 * expects (see firmware/crosspoint-dashboard). 792×528 → 52,272 bytes.
 */
export function exportFrameBytes(
  source: HTMLCanvasElement,
  threshold = 128,
): Uint8Array<ArrayBuffer> {
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  const img = ctx.getImageData(0, 0, source.width, source.height);
  const mono = thresholdRgbaToMono(img.data, threshold);
  // Re-wrap in a fresh ArrayBuffer-backed view so the type is a concrete
  // Uint8Array<ArrayBuffer> (assignable to BlobPart/BodyInit).
  return new Uint8Array(packMonoToBits(mono, source.width, source.height));
}

/**
 * Render a whole dashboard config to packed 1-bpp frame bytes via an off-screen
 * canvas. Lets the builder push a space that isn't the one currently on screen.
 */
export function renderDashboardToFrameBytes(
  dash: Dashboard,
  threshold = 128,
): Uint8Array<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = dash.width;
  canvas.height = dash.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  drawDashboard(ctx, dash);
  return exportFrameBytes(canvas, threshold);
}
