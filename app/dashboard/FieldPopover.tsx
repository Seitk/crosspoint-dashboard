"use client";

// Editor for a single field of a widget — its text plus its styling.
//
// Anchored to the field's own box on the preview, so you edit the thing you just
// pointed at. Size is "auto" by default: fields.js derives a size that fits the
// tile, which is what stops a metric's value from spilling into its neighbour.
// An explicit size is still clamped to the same ceiling, so it cannot reintroduce
// the overflow — the input shows the value it actually resolved to.

import { useEffect, useRef } from "react";

import styles from "./dashboard.module.css";
import { cellRect, } from "./grid.js";
import { fieldLayout } from "./fields.js";
import {
  DASHBOARD_HEIGHT,
  type FieldStyle,
  type GridSpec,
  type TextAlign,
  type Widget,
} from "./types";

type FieldBox = {
  key: string;
  text: string | string[];
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  auto: boolean;
  align: TextAlign;
};

/** Fields whose content is naturally multi-line. */
const MULTILINE = new Set(["items", "text"]);

const ALIGNS: { value: TextAlign; label: string }[] = [
  { value: "left", label: "L" },
  { value: "center", label: "C" },
  { value: "right", label: "R" },
];

export default function FieldPopover({
  widget,
  fieldKey,
  grid,
  scale,
  onChangeText,
  onChangeStyle,
  onOpenWidget,
  onClose,
}: {
  widget: Widget;
  fieldKey: string;
  grid: GridSpec;
  scale: number;
  onChangeText: (value: string | string[]) => void;
  onChangeStyle: (style: FieldStyle) => void;
  onOpenWidget: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Deferred so the click that opened this popover doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      clearTimeout(t);
    };
  }, [onClose]);

  const rect = cellRect(widget, grid) as { x: number; y: number; w: number; h: number };
  const field = (fieldLayout(widget, rect) as FieldBox[]).find((f) => f.key === fieldKey);
  if (!field) return null;

  // Anchor under the field, or above it when the field sits low on the canvas.
  const below = field.y + field.h < DASHBOARD_HEIGHT * 0.6;
  const style: React.CSSProperties = below
    ? { left: field.x * scale, top: (field.y + field.h) * scale + 6 }
    : { left: field.x * scale, bottom: (DASHBOARD_HEIGHT - field.y) * scale + 6 };

  const current: FieldStyle = widget.style?.[fieldKey] ?? {};
  const multiline = MULTILINE.has(fieldKey);
  const asText = Array.isArray(field.text) ? field.text.join("\n") : String(field.text);

  const setText = (value: string) => {
    onChangeText(fieldKey === "items" ? value.split("\n") : value);
  };

  return (
    <div
      className={styles.popover}
      style={style}
      ref={ref}
      role="dialog"
      aria-label={`Edit ${fieldKey}`}
    >
      <div className={styles.popoverHead}>
        <span className={styles.tag}>{fieldKey}</span>
        <span className={styles.cellHint}>{widget.type}</span>
        <button className={styles.remove} onClick={onClose} aria-label="Close field editor">
          ×
        </button>
      </div>

      <div className={styles.fields}>
        {multiline ? (
          <textarea
            aria-label={`${fieldKey} text`}
            placeholder={fieldKey === "items" ? "One item per line" : "Text (newlines allowed)"}
            value={asText}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <input
            aria-label={`${fieldKey} text`}
            placeholder={fieldKey}
            value={asText}
            onChange={(e) => setText(e.target.value)}
          />
        )}

        <div className={styles.styleRow}>
          <label className={styles.autoToggle}>
            <input
              type="checkbox"
              aria-label="auto size"
              checked={current.size == null}
              onChange={(e) =>
                // Leaving auto seeds the box with the size auto just picked, so the
                // number never jumps when you take manual control.
                onChangeStyle(e.target.checked ? { ...current, size: undefined } : { ...current, size: field.size })
              }
            />
            Auto
          </label>
          <label className={styles.sizeField}>
            Size
            <input
              type="number"
              min={8}
              aria-label="font size"
              disabled={current.size == null}
              value={field.size}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onChangeStyle({ ...current, size: Math.max(1, n) });
              }}
            />
          </label>
        </div>

        <div className={styles.styleRow}>
          <span className={styles.styleLabel}>Align</span>
          {ALIGNS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={styles.alignButton}
              data-active={field.align === a.value ? "yes" : "no"}
              aria-label={`align ${a.value}`}
              aria-pressed={field.align === a.value}
              onClick={() => onChangeStyle({ ...current, align: a.value })}
            >
              {a.label}
            </button>
          ))}
        </div>

        {current.size != null && current.size !== field.size && (
          <p className={styles.status} style={{ color: "#888" }}>
            Clamped to {field.size}px — a larger size would run outside the tile.
          </p>
        )}

        <button className="ghost" onClick={onOpenWidget}>
          WIDGET SETTINGS…
        </button>
      </div>
    </div>
  );
}
