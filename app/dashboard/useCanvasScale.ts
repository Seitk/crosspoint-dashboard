"use client";

// Lives in its own module rather than beside TileOverlay: React Fast Refresh only
// works on a module whose exports are *all* components. Exporting this hook next
// to a component made every edit to that file fall back to a full page reload
// ("Could not Fast Refresh — export is incompatible").

import { useLayoutEffect, useState } from "react";

import { DASHBOARD_WIDTH } from "./types";

/**
 * Ratio between the canvas's rendered width and its native 792px. The canvas is
 * laid out with `width: 100%`, so it is almost never displayed at native size;
 * the drag overlay and the popovers both position against this one measurement so
 * they cannot disagree about where a tile is.
 *
 * useLayoutEffect so the first paint is already aligned instead of flashing at 1.
 */
export function useCanvasScale(canvasRef: React.RefObject<HTMLCanvasElement | null>): number {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const w = canvas.getBoundingClientRect().width;
      if (w > 0) setScale(w / DASHBOARD_WIDTH);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvasRef]);
  return scale;
}
