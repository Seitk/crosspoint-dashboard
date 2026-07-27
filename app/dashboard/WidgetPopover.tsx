"use client";

// Click-to-edit popover for a single widget. Anchored to its tile on the preview
// canvas, so editing happens where you are looking rather than in a long list
// further down the page.
//
// It carries every field for the widget: display fields, span, data script, the
// cell picker (a keyboard/precision fallback for drag) and remove.

import { useEffect, useRef } from "react";

import styles from "./dashboard.module.css";
import { canPlace, cellRect, occupancy } from "./grid.js";
import { DASHBOARD_HEIGHT, type GridSpec, type Placement, type Widget } from "./types";

/** Patch shape mirrors the one in page.tsx; only valid fields are ever passed. */
type Patch = Record<string, unknown>;

/** Human-readable name, never an id — ids differ between SSR and client renders. */
function describe(w: Widget): string {
  if (w.type === "metric") return w.label || "metric";
  if (w.type === "list") return w.title || "list";
  return (w.text || "text").split("\n")[0];
}

/** Click-to-place grid map: occupied cells are disabled, so overlap is unpickable. */
function CellPicker({
  widget,
  grid,
  siblings,
  onPlace,
}: {
  widget: Widget;
  grid: GridSpec;
  siblings: Widget[];
  onPlace: (placement: Placement) => void;
}) {
  const taken = occupancy(siblings, widget.id) as Map<string, string>;
  const nameOf = new Map(siblings.map((w) => [w.id, describe(w)]));
  const self = { col: widget.col, row: widget.row, colSpan: widget.colSpan, rowSpan: widget.rowSpan };

  const move = (col: number, row: number) => {
    const keep = { col, row, colSpan: self.colSpan, rowSpan: self.rowSpan };
    if (canPlace(siblings, grid, widget.id, keep)) return onPlace(keep);
    onPlace({ col, row, colSpan: 1, rowSpan: 1 });
  };

  const rows = [];
  for (let row = 0; row < grid.rows; row++) {
    const cells = [];
    for (let col = 0; col < grid.cols; col++) {
      const isSelf =
        col >= self.col && col < self.col + self.colSpan &&
        row >= self.row && row < self.row + self.rowSpan;
      const takenBy = taken.get(`${col},${row}`);
      const state = isSelf ? "self" : takenBy ? "taken" : "free";
      cells.push(
        <button
          key={col}
          type="button"
          className={styles.cell}
          data-state={state}
          disabled={state === "taken"}
          aria-label={`cell ${col},${row}${state === "taken" ? " (occupied)" : ""}`}
          title={
            state === "taken"
              ? `occupied by ${nameOf.get(takenBy ?? "") ?? "another widget"}`
              : `move to ${col},${row}`
          }
          onClick={() => move(col, row)}
        />,
      );
    }
    rows.push(
      <div key={row} className={styles.cellRow}>
        {cells}
      </div>,
    );
  }
  return <div className={styles.cellGrid}>{rows}</div>;
}

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
        {widget.type === "metric" && (
          <>
            <input
              aria-label="label"
              placeholder="Label"
              value={widget.label}
              onChange={(e) => onChange({ label: e.target.value })}
            />
            <input
              aria-label="value"
              placeholder="Value"
              value={widget.value}
              onChange={(e) => onChange({ value: e.target.value })}
            />
            <input
              aria-label="delta"
              placeholder="Delta (optional)"
              value={widget.delta ?? ""}
              onChange={(e) => onChange({ delta: e.target.value })}
            />
          </>
        )}

        {widget.type === "list" && (
          <>
            <input
              aria-label="title"
              placeholder="Title"
              value={widget.title}
              onChange={(e) => onChange({ title: e.target.value })}
            />
            <textarea
              aria-label="items"
              placeholder="One item per line"
              value={widget.items.join("\n")}
              onChange={(e) => onChange({ items: e.target.value.split("\n") })}
            />
          </>
        )}

        {widget.type === "text" && (
          <>
            <textarea
              aria-label="text"
              placeholder="Text (newlines allowed)"
              value={widget.text}
              onChange={(e) => onChange({ text: e.target.value })}
            />
            <div className={styles.row}>
              <label className="field grow">
                Size
                <input
                  type="number"
                  value={widget.size ?? 28}
                  onChange={(e) => onChange({ size: Number(e.target.value) || 0 })}
                />
              </label>
              <label className="field grow">
                Align
                <select
                  value={widget.align ?? "left"}
                  onChange={(e) => onChange({ align: e.target.value as "left" | "center" })}
                >
                  <option value="left">left</option>
                  <option value="center">center</option>
                </select>
              </label>
            </div>
          </>
        )}

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

        <CellPicker widget={widget} grid={grid} siblings={siblings} onPlace={onPlace} />

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
