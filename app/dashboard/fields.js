// Field layout: where each piece of text inside a widget sits, and how big it is.
//
// This exists because two things need the same answer and must never disagree:
// render.ts draws the fields, and TileOverlay puts a clickable hotspot over each
// one. Both call fieldLayout(); there is no second copy of the arithmetic.
//
// It also fixes a class of bug the grid could not: the grid guarantees tiles do
// not overlap each other, but nothing stopped a tile's *contents* from spilling
// out of it. A metric's value was a hardcoded 60px drawn at a fixed offset, so on
// a short tile it ran straight through the gutter into the tile below. Sizes are
// now derived from the space actually available, and an explicit size is clamped
// to the same ceiling, which makes vertical overflow impossible to express.
//
// Pure and DOM-free (same convention as grid.js / monochrome.js) so `node --test`
// covers it directly.

/** Smallest font we will ever emit; below this text is illegible on e-ink anyway. */
export const MIN_FONT = 8;

/**
 * The fields each widget type owns, in top-to-bottom order.
 *
 * `preferred` is the size used when there is room — these are the values the
 * renderer hardcoded before this module existed, so a roomy tile looks unchanged.
 * `share` is the fraction of the tile's inner height the field is allotted; the
 * shares for a type sum to 1.
 */
const SPECS = {
  metric: [
    { key: "label", preferred: 20, share: 0.22, weight: 600, upper: true },
    { key: "value", preferred: 60, share: 0.56, weight: 700 },
    { key: "delta", preferred: 22, share: 0.22, weight: 500 },
  ],
  list: [
    { key: "title", preferred: 22, share: 0.22, weight: 700, upper: true, rule: true },
    { key: "items", preferred: 22, share: 0.78, weight: 400, multiline: true },
  ],
  text: [{ key: "text", preferred: 28, share: 1, weight: 600, multiline: true, middle: true }],
};

/** Field keys for a widget type, in draw order. */
export function fieldsOf(type) {
  return (SPECS[type] ?? []).map((f) => f.key);
}

/** Raw text a field displays. Arrays (list items) are returned as-is. */
export function fieldValue(widget, key) {
  if (key === "items") return widget.items ?? [];
  return widget[key] ?? "";
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Padding and gap scale with the tile. A fixed 14px pad ate most of a short tile,
 * leaving nothing for the text; proportional spacing keeps small tiles usable.
 */
function spacing(rect) {
  return {
    pad: clamp(Math.floor(rect.h * 0.08), 2, 14),
    gap: clamp(Math.floor(rect.h * 0.03), 1, 6),
  };
}

/**
 * Boxes for every field of `widget` inside its pixel `rect`, with the font size
 * resolved. Fields are always present even when empty, so an empty delta still
 * has a hotspot you can click to fill in.
 *
 * Returns [{ key, text, x, y, w, h, size, align, weight, upper, multiline,
 *            middle, rule, lineHeight, maxLines, auto }].
 */
export function fieldLayout(widget, rect) {
  const specs = SPECS[widget.type] ?? [];
  if (!specs.length) return [];
  const { pad, gap } = spacing(rect);
  const innerW = Math.max(1, rect.w - pad * 2);
  const available = Math.max(1, rect.h - pad * 2 - gap * (specs.length - 1));
  const style = widget.style ?? {};

  const out = [];
  let y = rect.y + pad;
  for (const spec of specs) {
    const h = Math.max(1, Math.floor(available * spec.share));
    // A single line must fit inside its own box; that ceiling applies to the
    // explicit override too, so a hand-set size can never cause a spill.
    const ceiling = Math.max(MIN_FONT, Math.floor(h));
    const override = style[spec.key]?.size;
    const auto = override == null;
    const size = clamp(auto ? spec.preferred : override, MIN_FONT, ceiling);
    const lineHeight = Math.max(1, Math.round(size * 1.25));

    out.push({
      key: spec.key,
      text: fieldValue(widget, spec.key),
      x: rect.x + pad,
      y,
      w: innerW,
      h,
      size,
      auto,
      align: style[spec.key]?.align ?? defaultAlign(widget, spec.key),
      weight: spec.weight,
      upper: !!spec.upper,
      multiline: !!spec.multiline,
      middle: !!spec.middle,
      rule: !!spec.rule,
      lineHeight,
      maxLines: Math.max(1, Math.floor(h / lineHeight)),
    });
    y += h + gap;
  }
  return out;
}

/**
 * Alignment when the field carries no explicit one. Text widgets used to hold a
 * top-level `align`, which migration folds into style.text — this keeps an
 * unmigrated widget rendering the way it always did.
 */
function defaultAlign(widget, key) {
  if (key === "text" && widget.align) return widget.align;
  return "left";
}

/** x coordinate to draw at, for a resolved field box and its alignment. */
export function anchorX(field) {
  if (field.align === "center") return field.x + field.w / 2;
  if (field.align === "right") return field.x + field.w;
  return field.x;
}

/** Which field of a widget a point falls in, or null. Used for hover/click. */
export function fieldAt(widget, rect, point) {
  for (const f of fieldLayout(widget, rect)) {
    if (point.x >= f.x && point.x <= f.x + f.w && point.y >= f.y && point.y <= f.y + f.h) {
      return f;
    }
  }
  return null;
}

// ---- migration: top-level text size/align -> style.text ---------------------

/** Fold a text widget's legacy `size`/`align` into the per-field style map. */
export function migrateWidgetStyle(widget) {
  if (widget.type !== "text") return widget;
  if (widget.size == null && widget.align == null) return widget;
  const { size, align, ...rest } = widget;
  const style = { ...(widget.style ?? {}) };
  style.text = {
    ...(style.text ?? {}),
    ...(size != null && style.text?.size == null ? { size } : {}),
    ...(align != null && style.text?.align == null ? { align } : {}),
  };
  return { ...rest, style };
}
