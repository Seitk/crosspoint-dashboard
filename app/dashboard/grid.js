// Grid layout + overlap validation for CrossPoint X3 dashboards.
//
// Why a grid: the X3 blits whatever pixel rectangles it is given and does no
// collision handling — two widgets with overlapping x/y/w/h simply draw on top
// of each other. Widgets therefore store *grid* coordinates (col/row/colSpan/
// rowSpan) and their pixel rects are computed here. Cells are disjoint by
// construction, so an overlap cannot be expressed in the first place.
//
// Pure and DOM-free on purpose (same convention as monochrome.js and
// scripts-core.js) so `node --test` covers it directly. Both the builder UI and
// the `skills/crosspoint-dashboard` CLI import this one module, so the two can
// never drift apart.

/** X3 e-ink geometry (landscape blit). Verified against firmware @ 1.4.1. */
export const CANVAS = { width: 792, height: 528 };

/** Starting grid for a new space. Few big tiles — e-ink text needs to be large. */
export const DEFAULT_GRID = { cols: 2, rows: 2, margin: 16, gutter: 12 };

/** Pixel size of one cell, plus the stride between cell origins. */
export function cellMetrics(grid, canvas = CANVAS) {
  const { cols, rows, margin, gutter } = { ...DEFAULT_GRID, ...grid };
  if (!(cols > 0) || !(rows > 0)) throw new Error("grid needs positive cols and rows");
  const cellW = (canvas.width - 2 * margin - (cols - 1) * gutter) / cols;
  const cellH = (canvas.height - 2 * margin - (rows - 1) * gutter) / rows;
  if (cellW <= 0 || cellH <= 0) {
    throw new Error(`grid too dense for the canvas (cellW=${cellW}, cellH=${cellH})`);
  }
  return { cellW, cellH, margin, gutter, cols, rows };
}

/** Pixel rect for a grid placement. The single place cells become pixels. */
export function cellRect(placement, grid, canvas = CANVAS) {
  const { cellW, cellH, margin, gutter } = cellMetrics(grid, canvas);
  const { col, row, colSpan = 1, rowSpan = 1 } = placement;
  return {
    x: Math.round(margin + col * (cellW + gutter)),
    y: Math.round(margin + row * (cellH + gutter)),
    w: Math.round(colSpan * cellW + (colSpan - 1) * gutter),
    h: Math.round(rowSpan * cellH + (rowSpan - 1) * gutter),
  };
}

/** True when a placement fits entirely inside the grid. */
export function inBounds(placement, grid) {
  const { cols, rows } = { ...DEFAULT_GRID, ...grid };
  const { col, row, colSpan = 1, rowSpan = 1 } = placement;
  return (
    col >= 0 && row >= 0 && colSpan >= 1 && rowSpan >= 1 &&
    col + colSpan <= cols && row + rowSpan <= rows
  );
}

/** Every "col,row" cell a placement covers. */
export function cellsOf(placement) {
  const { col, row, colSpan = 1, rowSpan = 1 } = placement;
  const out = [];
  for (let c = col; c < col + colSpan; c++) {
    for (let r = row; r < row + rowSpan; r++) out.push(`${c},${r}`);
  }
  return out;
}

/**
 * Occupancy map for the cell picker: "col,row" -> widget id, for every widget
 * except `exceptId` (the one being moved, which should not block itself).
 *
 * @param {Array<any>} widgets
 * @param {string|null} [exceptId]
 * @returns {Map<string, string>}
 */
export function occupancy(widgets, exceptId = null) {
  const map = new Map();
  for (const w of widgets) {
    if (w.id === exceptId) continue;
    for (const key of cellsOf(w)) map.set(key, w.id);
  }
  return map;
}

/** Can `widgetId` sit at this placement without leaving the grid or colliding? */
export function canPlace(widgets, grid, widgetId, placement) {
  if (!inBounds(placement, grid)) return false;
  const taken = occupancy(widgets, widgetId);
  return cellsOf(placement).every((key) => !taken.has(key));
}

/** Pull a placement back inside the grid (used when the grid shrinks). */
export function clampPlacement(placement, grid) {
  const { cols, rows } = { ...DEFAULT_GRID, ...grid };
  const colSpan = Math.max(1, Math.min(placement.colSpan ?? 1, cols));
  const rowSpan = Math.max(1, Math.min(placement.rowSpan ?? 1, rows));
  return {
    col: Math.max(0, Math.min(placement.col ?? 0, cols - colSpan)),
    row: Math.max(0, Math.min(placement.row ?? 0, rows - rowSpan)),
    colSpan,
    rowSpan,
  };
}

/**
 * Re-fit every widget into `grid`, clamping any that fall outside and relocating
 * any that end up colliding to the first free cell. Returns the new widget list
 * plus the ids that had to move, so the UI can flag them. Never drops a widget.
 */
export function refitToGrid(widgets, grid) {
  const { cols, rows } = { ...DEFAULT_GRID, ...grid };
  const taken = new Map();
  const moved = [];
  const out = [];

  for (const w of widgets) {
    const clamped = clampPlacement(w, grid);
    const fits = cellsOf(clamped).every((k) => !taken.has(k));
    let placement = clamped;

    if (!fits) {
      const free = firstFree(taken, cols, rows, clamped.colSpan, clamped.rowSpan) ??
        firstFree(taken, cols, rows, 1, 1);
      // Nowhere left at all: keep the clamped spot rather than losing the widget.
      placement = free ?? clamped;
    }
    if (
      placement.col !== (w.col ?? 0) || placement.row !== (w.row ?? 0) ||
      placement.colSpan !== (w.colSpan ?? 1) || placement.rowSpan !== (w.rowSpan ?? 1)
    ) {
      moved.push(w.id);
    }
    for (const k of cellsOf(placement)) taken.set(k, w.id);
    out.push({ ...w, ...placement });
  }
  return { widgets: out, moved };
}

/** Scan row-major for a free block of the requested span. */
function firstFree(taken, cols, rows, colSpan, rowSpan) {
  for (let row = 0; row + rowSpan <= rows; row++) {
    for (let col = 0; col + colSpan <= cols; col++) {
      const placement = { col, row, colSpan, rowSpan };
      if (cellsOf(placement).every((k) => !taken.has(k))) return placement;
    }
  }
  return null;
}

/**
 * Lay a space out: grid widgets -> a Dashboard of pixel widgets, with the grid
 * fields stripped. This is what the renderer and the device push both consume.
 * Throws on collision/out-of-bounds — call refitToGrid() first if unsure.
 */
export function layoutSpace(space, canvas = CANVAS) {
  const grid = { ...DEFAULT_GRID, ...(space.grid ?? {}) };
  const seen = new Map();
  const widgets = [];

  for (const wdg of space.widgets ?? []) {
    const { col, row, colSpan = 1, rowSpan = 1, ...fields } = wdg;
    const placement = { col, row, colSpan, rowSpan };
    if (!inBounds(placement, grid)) {
      throw new Error(
        `widget ${wdg.id ?? "?"} at (col ${col}, row ${row}, span ${colSpan}x${rowSpan}) ` +
          `runs outside the ${grid.cols}x${grid.rows} grid`,
      );
    }
    for (const key of cellsOf(placement)) {
      if (seen.has(key)) {
        throw new Error(`widget ${wdg.id ?? "?"} overlaps ${seen.get(key)} at cell (${key})`);
      }
      seen.set(key, wdg.id ?? "?");
    }
    widgets.push({ ...fields, ...cellRect(placement, grid, canvas) });
  }
  return { width: canvas.width, height: canvas.height, widgets };
}

// ---- migration: v1 pixel widgets -> v2 grid widgets -------------------------

/** Distinct values within `tol` px of each other, ascending. */
function uniqSorted(values, tol) {
  const out = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  }
  return out;
}

/**
 * Guess the grid an old pixel layout was built on, from its distinct column and
 * row origins. Conservative: at least 1x1, capped so cells stay drawable.
 */
export function inferGrid(widgets, canvas = CANVAS) {
  if (!widgets.length) return { ...DEFAULT_GRID };
  const xs = uniqSorted(widgets.map((w) => w.x ?? 0), 8);
  const ys = uniqSorted(widgets.map((w) => w.y ?? 0), 8);
  const margin = DEFAULT_GRID.margin;
  const gutter = DEFAULT_GRID.gutter;
  const maxCols = Math.max(1, Math.floor((canvas.width - 2 * margin + gutter) / (80 + gutter)));
  const maxRows = Math.max(1, Math.floor((canvas.height - 2 * margin + gutter) / (60 + gutter)));
  return {
    cols: Math.min(Math.max(1, xs.length), maxCols),
    rows: Math.min(Math.max(1, ys.length), maxRows),
    margin,
    gutter,
  };
}

/**
 * Convert one v1 pixel widget to a grid placement by snapping its rect to the
 * nearest cell and deriving spans from its size.
 */
export function snapToGrid(widget, grid, canvas = CANVAS) {
  const { cellW, cellH, margin, gutter, cols, rows } = cellMetrics(grid, canvas);
  const col = Math.round(((widget.x ?? margin) - margin) / (cellW + gutter));
  const row = Math.round(((widget.y ?? margin) - margin) / (cellH + gutter));
  const colSpan = Math.round(((widget.w ?? cellW) + gutter) / (cellW + gutter));
  const rowSpan = Math.round(((widget.h ?? cellH) + gutter) / (cellH + gutter));
  return clampPlacement(
    { col, row, colSpan: Math.max(1, colSpan), rowSpan: Math.max(1, rowSpan) },
    { cols, rows, margin, gutter },
  );
}

/**
 * Migrate a v1 space (pixel widgets, no grid) to v2. Infers a grid, snaps every
 * widget onto it, then refits so nothing overlaps. Display fields and scripts
 * are carried across untouched; x/y/w/h are dropped (they are derived now).
 */
export function migrateSpace(space, canvas = CANVAS) {
  const widgets = space.widgets ?? [];
  const grid = space.grid ? { ...DEFAULT_GRID, ...space.grid } : inferGrid(widgets, canvas);
  const snapped = widgets.map((w) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { x, y, w: _w, h, ...fields } = w;
    return { ...fields, ...snapToGrid(w, grid, canvas) };
  });
  const { widgets: fitted } = refitToGrid(snapped, grid);
  return { ...space, grid, widgets: fitted };
}

/** True when a stored blob still uses pixel rects (or predates `grid`). */
export function needsMigration(state) {
  if (!state || !Array.isArray(state.spaces)) return false;
  if (state.version >= 2) return false;
  return true;
}

/**
 * Bring any persisted builder state up to the current version. Safe to call on
 * already-migrated state (it is a no-op then).
 */
export function migrateSpacesState(state, canvas = CANVAS) {
  if (!needsMigration(state)) return state;
  return {
    ...state,
    version: 2,
    spaces: state.spaces.map((s) => migrateSpace(s, canvas)),
  };
}

// ---- pixel-level safety net -------------------------------------------------

/** Pixel-rect overlaps. Returns [{ a, b }] for every overlapping pair. */
export function findOverlaps(widgets) {
  const pairs = [];
  const id = (w, i) => w.id ?? `#${i}`;
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      const a = widgets[i];
      const b = widgets[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        pairs.push({ a: id(a, i), b: id(b, j) });
      }
    }
  }
  return pairs;
}

/** Widget ids whose rect falls outside the canvas. */
export function findOutOfBounds(widgets, canvas = CANVAS) {
  const bad = [];
  widgets.forEach((w, i) => {
    if (w.x < 0 || w.y < 0 || w.x + w.w > canvas.width || w.y + w.h > canvas.height) {
      bad.push(w.id ?? `#${i}`);
    }
  });
  return bad;
}

/** Combined check on pixel rects. { ok, overlaps, outOfBounds }. */
export function validate(widgets, canvas = CANVAS) {
  const overlaps = findOverlaps(widgets);
  const outOfBounds = findOutOfBounds(widgets, canvas);
  return { ok: overlaps.length === 0 && outOfBounds.length === 0, overlaps, outOfBounds };
}

/**
 * Legacy grid-spec entry point kept for the CLI: a flat spec
 * `{ cols, rows, margin?, gutter?, widgets: [{...,col,row,colSpan?,rowSpan?}] }`
 * -> a Dashboard of pixel widgets.
 */
export function gridToPixels(spec) {
  const { cols, rows, margin, gutter, canvas, widgets } = spec;
  return layoutSpace(
    { grid: { cols, rows, margin: margin ?? DEFAULT_GRID.margin, gutter: gutter ?? DEFAULT_GRID.gutter }, widgets },
    canvas ?? CANVAS,
  );
}
