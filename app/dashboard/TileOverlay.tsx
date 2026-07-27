"use client";

// Draggable handles layered over the preview canvas.
//
// The canvas is a raster of exactly what the X3 receives, so it stays untouched:
// interaction happens on transparent DOM tiles positioned on top of it. They are
// real <button>s, so focus, hover and keyboard come for free.
//
// The canvas is laid out with `width: 100%`, i.e. it is almost never displayed at
// its native 792px. Every rect therefore goes through `scale`, measured from the
// canvas element itself — get this wrong and every tile is subtly misaligned.
//
// All placement decisions come from the pure helpers in grid.js; this file only
// tracks pointer deltas and asks canPlace() whether a drop may commit.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import styles from "./dashboard.module.css";
import { canPlace, cellRect, dragPlacement, resizePlacement } from "./grid.js";
import { DASHBOARD_WIDTH, type GridSpec, type Placement, type Widget } from "./types";

/** Pointer travel (in canvas px) below which a gesture counts as a click, not a drag. */
const CLICK_THRESHOLD = 4;

type Gesture = {
  id: string;
  mode: "move" | "resize";
  clientX: number;
  clientY: number;
  dx: number;
  dy: number;
  moved: boolean;
};

/** Short human label for a tile, so the overlay is readable without the canvas. */
function tileLabel(w: Widget): string {
  if (w.type === "metric") return w.label || "metric";
  if (w.type === "list") return w.title || "list";
  return (w.text || "text").split("\n")[0];
}

/**
 * Ratio between the canvas's rendered width and its native 792px. Shared by the
 * overlay and the popover anchor so they can never disagree about where a tile is.
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

export default function TileOverlay({
  widgets,
  grid,
  scale,
  selectedId,
  onSelect,
  onPlace,
}: {
  widgets: Widget[];
  grid: GridSpec;
  scale: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onPlace: (id: string, placement: Placement) => void;
}) {
  // The gesture lives in a ref *and* in state: the ref is the source of truth so
  // several pointer events in one frame each see the latest value (reading state
  // here would give the value from the last render, dropping the whole gesture);
  // the state copy exists purely to trigger the drag preview re-render. The ref
  // is only ever written from event handlers, never during render.
  const gestureRef = useRef<Gesture | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);

  const setBoth = (next: Gesture | null) => {
    gestureRef.current = next;
    setGesture(next);
  };

  /** Placement a widget would take right now, given any in-flight gesture. */
  const previewOf = useCallback(
    (w: Widget): Placement => {
      if (!gesture || gesture.id !== w.id || !gesture.moved) {
        return { col: w.col, row: w.row, colSpan: w.colSpan, rowSpan: w.rowSpan };
      }
      return gesture.mode === "move"
        ? (dragPlacement(w, gesture.dx, gesture.dy, grid) as Placement)
        : (resizePlacement(w, gesture.dx, gesture.dy, grid) as Placement);
    },
    [gesture, grid],
  );

  const start = (w: Widget, mode: Gesture["mode"]) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Capture keeps the gesture alive if the pointer leaves the tile. It throws
    // when the pointer isn't active (some synthetic/touch cases) — the drag still
    // works without it, so never let that abort the gesture.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — fall back to plain pointer events */
    }
    setBoth({ id: w.id, mode, clientX: e.clientX, clientY: e.clientY, dx: 0, dy: 0, moved: false });
  };

  const move = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    // Convert screen movement back into canvas pixels before it reaches grid.js.
    const dx = (e.clientX - g.clientX) / scale;
    const dy = (e.clientY - g.clientY) / scale;
    setBoth({ ...g, dx, dy, moved: g.moved || Math.hypot(dx, dy) > CLICK_THRESHOLD });
  };

  const end = (w: Widget) => (e: React.PointerEvent) => {
    const g = gestureRef.current;
    setBoth(null);
    if (!g || g.id !== w.id) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* nothing was captured */
    }

    if (!g.moved) {
      onSelect(w.id); // a tap, not a drag: open the editor
      return;
    }
    const placement =
      g.mode === "move"
        ? (dragPlacement(w, g.dx, g.dy, grid) as Placement)
        : (resizePlacement(w, g.dx, g.dy, grid) as Placement);
    // Illegal drops are simply refused — the tile snaps back rather than being
    // "fixed up" into somewhere the user didn't ask for.
    if (canPlace(widgets, grid, w.id, placement)) onPlace(w.id, placement);
  };

  /** Arrow keys nudge by one cell; the tiles are buttons, so this is free a11y. */
  const onKeyDown = (w: Widget) => (e: React.KeyboardEvent) => {
    const delta =
      e.key === "ArrowLeft" ? [-1, 0] :
      e.key === "ArrowRight" ? [1, 0] :
      e.key === "ArrowUp" ? [0, -1] :
      e.key === "ArrowDown" ? [0, 1] : null;
    if (!delta) return;
    e.preventDefault();
    const next = {
      col: w.col + delta[0],
      row: w.row + delta[1],
      colSpan: w.colSpan,
      rowSpan: w.rowSpan,
    };
    if (canPlace(widgets, grid, w.id, next)) onPlace(w.id, next);
  };

  // Escape cancels an in-flight drag without committing it.
  useEffect(() => {
    if (!gesture) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBoth(null);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [gesture]);

  return (
    <div className={styles.overlay} data-dragging={gesture?.moved ? "yes" : "no"}>
      {widgets.map((w) => {
        const placement = previewOf(w);
        const r = cellRect(placement, grid) as { x: number; y: number; w: number; h: number };
        const active = gesture?.id === w.id && gesture.moved;
        const legal = !active || canPlace(widgets, grid, w.id, placement);
        return (
          <button
            key={w.id}
            type="button"
            className={styles.tile}
            data-selected={selectedId === w.id ? "yes" : "no"}
            data-active={active ? "yes" : "no"}
            data-legal={legal ? "yes" : "no"}
            style={{
              left: r.x * scale,
              top: r.y * scale,
              width: r.w * scale,
              height: r.h * scale,
            }}
            aria-label={`${tileLabel(w)} — ${w.type} at cell ${w.col},${w.row}`}
            onPointerDown={start(w, "move")}
            onPointerMove={move}
            onPointerUp={end(w)}
            onPointerCancel={() => setBoth(null)}
            onKeyDown={onKeyDown(w)}
          >
            <span className={styles.tileName}>{tileLabel(w)}</span>
            <span
              className={styles.resizeHandle}
              role="presentation"
              onPointerDown={start(w, "resize")}
              onPointerMove={move}
              onPointerUp={end(w)}
            />
          </button>
        );
      })}
    </div>
  );
}
