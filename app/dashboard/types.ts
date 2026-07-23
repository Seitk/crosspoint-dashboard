// Declarative dashboard model. The whole point of the design: flexibility lives
// here (and in the renderer), off-device. Adding a new metric never touches the
// firmware — you change this config and push a new frame.

/** X3 e-ink geometry (portrait). Verified against firmware @ 1.4.1. */
export const DASHBOARD_WIDTH = 792;
export const DASHBOARD_HEIGHT = 528;

export type WidgetType = "metric" | "list" | "text";

export type WidgetBase = {
  id: string;
  /** Top-left + size in device pixels on the 792x528 canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Optional data script: the body of an async function `(fetch) => …` that
   * fetches from an API and returns what to display. On refresh its result is
   * coerced into this widget's display fields (see scripts-core.js).
   */
  script?: string;
};

/** A number/KPI tile: label, big value, optional delta line. */
export type MetricWidget = WidgetBase & {
  type: "metric";
  label: string;
  value: string;
  delta?: string;
};

/** A titled list of lines (e.g. a TODO). */
export type ListWidget = WidgetBase & {
  type: "list";
  title: string;
  items: string[];
};

/** Free text block. */
export type TextWidget = WidgetBase & {
  type: "text";
  text: string;
  size?: number;
  align?: "left" | "center";
};

export type Widget = MetricWidget | ListWidget | TextWidget;

export type Dashboard = {
  width: number;
  height: number;
  widgets: Widget[];
};

/** A "space" is one page of the dashboard — its own set of widgets. The X3 cycles
 * between spaces with the side buttons. */
export type Space = {
  id: string;
  name: string;
  widgets: Widget[];
};

/** State persisted by the builder: the spaces and which one is being edited. */
export type SpacesState = {
  spaces: Space[];
  activeIndex: number;
};

let idCounter = 0;
export function nextId(prefix = "w"): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

/** A sensible starter set of spaces (one space with the demo widgets). */
export function defaultSpaces(): Space[] {
  return [{ id: nextId("s"), name: "Space 1", widgets: defaultDashboard().widgets }];
}

/** A sensible starter dashboard so the builder isn't empty on first load. */
export function defaultDashboard(): Dashboard {
  return {
    width: DASHBOARD_WIDTH,
    height: DASHBOARD_HEIGHT,
    widgets: [
      {
        id: nextId(),
        type: "metric",
        x: 16,
        y: 16,
        w: 372,
        h: 200,
        label: "AAPL",
        value: "229.35",
        delta: "+1.24%",
      },
      {
        id: nextId(),
        type: "metric",
        x: 404,
        y: 16,
        w: 372,
        h: 200,
        label: "Claude usage",
        value: "68%",
        delta: "resets 4:00pm",
      },
      {
        id: nextId(),
        type: "list",
        x: 16,
        y: 232,
        w: 372,
        h: 280,
        title: "TODO",
        items: ["Ship the X3 fork", "Wire up live metrics", "Dock + power test"],
      },
      {
        id: nextId(),
        type: "text",
        x: 404,
        y: 232,
        w: 372,
        h: 280,
        text: "CROSSPOINT\nDASHBOARD",
        size: 40,
        align: "center",
      },
    ],
  };
}
