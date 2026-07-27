"use client";

// Click-to-edit popover for a single widget. Anchored to its tile on the preview
// canvas, so editing happens where you are looking rather than in a long list
// further down the page.
//
// It carries the widget-level settings only: span, data script and remove.
// Position is not edited here — tiles are moved by dragging them on the canvas
// (or nudged with the arrow keys). Individual field text and styling live in
// FieldPopover, reached by clicking the field itself, so no value is editable in
// two places.

import { useEffect, useRef } from "react";

import styles from "./dashboard.module.css";
import { canPlace, cellRect } from "./grid.js";
import { DASHBOARD_HEIGHT, type GridSpec, type Placement, type Widget } from "./types";

/** Patch shape mirrors the one in page.tsx; only valid fields are ever passed. */
type Patch = Record<string, unknown>;

export default function WidgetPopover({
  widget,
  grid,
  siblings,
  scale,
  error,
  onChange,
  onPlace,
  onRemove,
  onClose,
}: {
  widget: Widget;
  grid: GridSpec;
  siblings: Widget[];
  scale: number;
  error?: string;
  onChange: (patch: Patch) => void;
  onPlace: (placement: Placement) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Escape closes; so does a click anywhere outside the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Deferred: the click that opened the popover must not immediately close it.
    const t = setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      clearTimeout(t);
    };
  }, [onClose]);

  const rect = cellRect(widget, grid) as { x: number; y: number; w: number; h: number };
  // Anchor below the tile, or above it when the tile sits low on the canvas —
  // percentages keep this correct at any rendered canvas width.
  const below = rect.y + rect.h < DASHBOARD_HEIGHT * 0.55;
  const style: React.CSSProperties = below
    ? { left: rect.x * scale, top: (rect.y + rect.h) * scale + 8 }
    : { left: rect.x * scale, bottom: (DASHBOARD_HEIGHT - rect.y) * scale + 8 };

  const setSpan = (colSpan: number, rowSpan: number) => {
    const next = { col: widget.col, row: widget.row, colSpan, rowSpan };
    if (colSpan >= 1 && rowSpan >= 1 && canPlace(siblings, grid, widget.id, next)) onPlace(next);
  };

  return (
    <div className={styles.popover} style={style} ref={ref} role="dialog" aria-label="Edit widget">
      <div className={styles.popoverHead}>
        <span className={styles.tag}>{widget.type}</span>
        <span className={styles.cellHint}>
          cell {widget.col},{widget.row}
        </span>
        <button className={styles.remove} onClick={onClose} aria-label="Close editor">
          ×
        </button>
      </div>

      <div className={styles.fields}>
        <p className={styles.status} style={{ color: "#888", margin: "0 0 4px" }}>
          Click a field on the preview to edit its text, size and alignment.
        </p>

        <div className={styles.spanControls}>
          <label>
            Span W
            <input
              type="number"
              min={1}
              max={grid.cols}
              value={widget.colSpan}
              onChange={(e) => setSpan(Math.max(1, Number(e.target.value) || 1), widget.rowSpan)}
            />
          </label>
          <label>
            Span H
            <input
              type="number"
              min={1}
              max={grid.rows}
              value={widget.rowSpan}
              onChange={(e) => setSpan(widget.colSpan, Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
        </div>

        <label className="field">
          Data script (JS, optional)
          <textarea
            aria-label="script"
            className={styles.script}
            placeholder={"const r = await fetch('https://api…');\nreturn (await r.json()).price;"}
            value={widget.script ?? ""}
            onChange={(e) => onChange({ script: e.target.value })}
            spellCheck={false}
          />
        </label>
        {error && <p className={styles.scriptError}>⚠ {error}</p>}

        <button className={styles.remove} onClick={onRemove}>
          remove widget
        </button>
      </div>
    </div>
  );
}
