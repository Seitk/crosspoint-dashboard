// Declarative dashboard model. The whole point of the design: flexibility lives
// here (and in the renderer), off-device. Adding a new metric never touches the
// firmware — you change this config and push a new frame.
//
// Positions are stored as *grid* coordinates, never pixels. Pixel rects are
// derived by `grid.js` at draw/push time, which makes overlapping tiles
// impossible to express (grid cells are disjoint). See grid.js for the math.

/** X3 e-ink geometry (portrait). Verified against firmware @ 1.4.1. */
export const DASHBOARD_WIDTH = 792;
export const DASHBOARD_HEIGHT = 528;

/** Current schema version of the persisted builder state (see grid.js migration). */
export const SPACES_SCHEMA_VERSION = 2;

export type WidgetType = "metric" | "list" | "text";

/** How a space is divided up. Shared by every widget in that space. */
export type GridSpec = {
  cols: number;
  rows: number;
  /** Empty pixels around the canvas edge. */
  margin: number;
  /** Empty pixels between adjacent cells. */
  gutter: number;
};

/** Where a widget sits on its space's grid. */
export type Placement = {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
};

/** A computed pixel rect on the 792x528 canvas. Derived, never stored. */
export type Rect = { x: number; y: number; w: number; h: number };

type WidgetCommon = {
  id: string;
  /**
   * Optional data script: the body of an async function `(fetch) => …` that
   * fetches from an API and returns what to display. On refresh its result is
   * coerced into this widget's display fields (see scripts-core.js).
   */
  script?: string;
};

/** A number/KPI tile: label, big value, optional delta line. */
export type MetricFields = { type: "metric"; label: string; value: string; delta?: string };
/** A titled list of lines (e.g. a TODO). */
export type ListFields = { type: "list"; title: string; items: string[] };
/** Free text block. */
export type TextFields = {
  type: "text";
  text: string;
  size?: number;
  align?: "left" | "center";
};

export type WidgetFields = MetricFields | ListFields | TextFields;

/** A widget as stored and edited: display fields + grid placement. */
export type Widget = WidgetCommon & Placement & WidgetFields;

export type MetricWidget = WidgetCommon & Placement & MetricFields;
export type ListWidget = WidgetCommon & Placement & ListFields;
export type TextWidget = WidgetCommon & Placement & TextFields;

/** A widget as handed to the renderer: display fields + a pixel rect. */
export type PlacedWidget = WidgetCommon & Rect & WidgetFields;

export type PlacedMetricWidget = WidgetCommon & Rect & MetricFields;
export type PlacedListWidget = WidgetCommon & Rect & ListFields;
export type PlacedTextWidget = WidgetCommon & Rect & TextFields;

/** One laid-out page, ready to rasterize. */
export type Dashboard = {
  width: number;
  height: number;
  widgets: PlacedWidget[];
};

/** A "space" is one page of the dashboard — its own grid and set of widgets. The
 * X3 cycles between spaces with the side buttons. */
export type Space = {
  id: string;
  name: string;
  grid: GridSpec;
  widgets: Widget[];
};

/** State persisted by the builder: the spaces and which one is being edited. */
export type SpacesState = {
  version: number;
  spaces: Space[];
  activeIndex: number;
};

let idCounter = 0;
export function nextId(prefix = "w"): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

/** Grid a brand-new space starts on. */
export function defaultGrid(): GridSpec {
  return { cols: 12, rows: 6, margin: 16, gutter: 12 };
}

/** An empty space, ready for widgets. */
export function emptySpace(name: string): Space {
  return { id: nextId("s"), name, grid: defaultGrid(), widgets: [] };
}

/** A sensible starter set of spaces (one space with the demo widgets). */
export function defaultSpaces(): Space[] {
  return [{ id: nextId("s"), name: "Space 1", grid: defaultGrid(), widgets: defaultWidgets() }];
}

/**
 * Starter widgets so the builder isn't empty on first load. Four 6x3 quadrants of
 * the 12x6 grid — the same four panes as before, now expressed on the finer grid.
 */
export function defaultWidgets(): Widget[] {
  return [
    {
      id: nextId(),
      type: "metric",
      col: 0,
      row: 0,
      colSpan: 6,
      rowSpan: 3,
      label: "AAPL",
      value: "229.35",
      delta: "+1.24%",
    },
    {
      id: nextId(),
      type: "metric",
      col: 6,
      row: 0,
      colSpan: 6,
      rowSpan: 3,
      label: "Claude usage",
      value: "68%",
      delta: "resets 4:00pm",
    },
    {
      id: nextId(),
      type: "list",
      col: 0,
      row: 3,
      colSpan: 6,
      rowSpan: 3,
      title: "TODO",
      items: ["Ship the X3 fork", "Wire up live metrics", "Dock + power test"],
    },
    {
      id: nextId(),
      type: "text",
      col: 6,
      row: 3,
      colSpan: 6,
      rowSpan: 3,
      text: "CROSSPOINT\nDASHBOARD",
      size: 40,
      align: "center",
    },
  ];
}
