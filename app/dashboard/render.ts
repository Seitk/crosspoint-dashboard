// Browser-only: draw a Dashboard config onto a 2D canvas and export it as a
// 1-bit PNG ready to push to the X3. Kept separate from monochrome.js (which is
// pure/DOM-free) so the pixel logic stays unit-testable in node.

import type { Dashboard, ListWidget, MetricWidget, TextWidget, Widget } from "./types";
import { packMonoToBits, thresholdRgbaToMono } from "./monochrome.js";

const PAD = 14;

export function drawDashboard(ctx: CanvasRenderingContext2D, dash: Dashboard): void {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, dash.width, dash.height);
  ctx.fillStyle = "#000000";
  ctx.strokeStyle = "#000000";
  ctx.textBaseline = "top";
  for (const widget of dash.widgets) drawWidget(ctx, widget);
}

function drawWidget(ctx: CanvasRenderingContext2D, widget: Widget): void {
  ctx.lineWidth = 2;
  ctx.strokeRect(widget.x + 1, widget.y + 1, widget.w - 2, widget.h - 2);
  switch (widget.type) {
    case "metric":
      drawMetric(ctx, widget);
      break;
    case "list":
      drawList(ctx, widget);
      break;
    case "text":
      drawText(ctx, widget);
      break;
  }
}

function drawMetric(ctx: CanvasRenderingContext2D, w: MetricWidget): void {
  ctx.textAlign = "left";
  ctx.font = "600 20px sans-serif";
  ctx.fillText(clip(ctx, w.label.toUpperCase(), w.w - PAD * 2), w.x + PAD, w.y + PAD);
  ctx.font = "700 60px sans-serif";
  ctx.fillText(clip(ctx, w.value, w.w - PAD * 2), w.x + PAD, w.y + PAD + 30);
  if (w.delta) {
    ctx.font = "500 22px sans-serif";
    ctx.fillText(clip(ctx, w.delta, w.w - PAD * 2), w.x + PAD, w.y + w.h - PAD - 24);
  }
}

function drawList(ctx: CanvasRenderingContext2D, w: ListWidget): void {
  ctx.textAlign = "left";
  ctx.font = "700 22px sans-serif";
  ctx.fillText(clip(ctx, w.title.toUpperCase(), w.w - PAD * 2), w.x + PAD, w.y + PAD);
  ctx.beginPath();
  ctx.moveTo(w.x + PAD, w.y + PAD + 30);
  ctx.lineTo(w.x + w.w - PAD, w.y + PAD + 30);
  ctx.stroke();
  ctx.font = "400 22px sans-serif";
  const lineH = 32;
  let y = w.y + PAD + 44;
  for (const item of w.items) {
    if (y + lineH > w.y + w.h - PAD) break;
    ctx.fillText(clip(ctx, `• ${item}`, w.w - PAD * 2), w.x + PAD, y);
    y += lineH;
  }
}

function drawText(ctx: CanvasRenderingContext2D, w: TextWidget): void {
  const size = w.size ?? 28;
  ctx.font = `600 ${size}px sans-serif`;
  const align = w.align ?? "left";
  ctx.textAlign = align;
  const cx = align === "center" ? w.x + w.w / 2 : w.x + PAD;
  const lines = w.text.split("\n");
  const lineH = size * 1.25;
  let y = w.y + w.h / 2 - (lines.length * lineH) / 2;
  for (const line of lines) {
    ctx.fillText(clip(ctx, line, w.w - PAD * 2), cx, y);
    y += lineH;
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
