"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import styles from "./dashboard.module.css";
import {
  applyMonochrome,
  drawDashboard,
  exportMonoPng,
  renderDashboardToFrameBytes,
} from "./render";
import { applyScriptResult, proxiedFetch, runScript } from "./scripts";
import TileOverlay, { useCanvasScale } from "./TileOverlay";
import WidgetPopover from "./WidgetPopover";
import {
  canPlace,
  layoutSpace,
  migrateSpacesState,
  occupancy,
  refitToGrid,
} from "./grid.js";
import {
  DASHBOARD_HEIGHT,
  DASHBOARD_WIDTH,
  type Dashboard,
  defaultGrid,
  defaultSpaces,
  emptySpace,
  type GridSpec,
  type ListWidget,
  type MetricWidget,
  nextId,
  type Placement,
  type Space,
  type SpacesState,
  SPACES_SCHEMA_VERSION,
  type TextWidget,
  type Widget,
  type WidgetType,
} from "./types";

const DEFAULT_IP = "192.168.1.238";
const STORAGE_SPACES = "crosspoint-spaces";
const STORAGE_DASH_LEGACY = "crosspoint-dashboard";
const STORAGE_IP = "crosspoint-device-ip";

type SaveState = "idle" | "saved" | "error";

/** A patch that may touch any widget field; callers only pass valid ones. */
type WidgetPatch = Partial<
  Omit<MetricWidget, "type" | "id"> &
    Omit<ListWidget, "type" | "id"> &
    Omit<TextWidget, "type" | "id">
>;

/**
 * Grid widgets -> pixel rects. layoutSpace() throws on a bad layout rather than
 * emitting overlapping tiles; an imported or hand-edited file could be bad, and
 * the editor must never crash on one, so refit and retry before giving up.
 */
function safeLayout(space: Space): Dashboard {
  try {
    return layoutSpace(space) as Dashboard;
  } catch {
    const { widgets } = refitToGrid(space.widgets, space.grid);
    return layoutSpace({ ...space, widgets }) as Dashboard;
  }
}

/** Run every scripted widget in a list; returns updated widgets + per-id errors. */
async function runWidgetScripts(
  widgets: Widget[],
): Promise<{ widgets: Widget[]; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const out = await Promise.all(
    widgets.map(async (w) => {
      if (!w.script || !w.script.trim()) return w;
      try {
        return applyScriptResult(w, await runScript(w.script, proxiedFetch));
      } catch (err) {
        errors[w.id] = err instanceof Error ? err.message : String(err);
        return w;
      }
    }),
  );
  return { widgets: out, errors };
}

export default function DashboardBuilder() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [spaces, setSpaces] = useState<Space[]>(() => defaultSpaces());
  const [activeIndex, setActiveIndex] = useState(0);
  const [ip, setIp] = useState(DEFAULT_IP);
  const [oneBit, setOneBit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [autoOn, setAutoOn] = useState(false);
  const [autoSec, setAutoSec] = useState(60);
  const [autoPush, setAutoPush] = useState(false);
  const [scriptErrors, setScriptErrors] = useState<Record<string, string>>({});
  const [fwFile, setFwFile] = useState<File | null>(null);
  const [fwBusy, setFwBusy] = useState(false);
  const [fwStatus, setFwStatus] = useState("");
  /** Whether the last persist attempt succeeded, shown as a badge by the canvas. */
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveRef = useRef<SaveState>("idle");
  /** Transient note when a grid change had to relocate widgets. */
  const [gridNote, setGridNote] = useState("");
  const importRef = useRef<HTMLInputElement | null>(null);
  /** Widget whose edit popover is open (clicked on the canvas). */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const active = spaces[activeIndex] ?? spaces[0];
  const scale = useCanvasScale(canvasRef);
  const selected = active?.widgets.find((w) => w.id === selectedId) ?? null;

  // Restore saved spaces (migrating older schemas) + device IP.
  useEffect(() => {
    try {
      const savedSpaces = window.localStorage.getItem(STORAGE_SPACES);
      if (savedSpaces) {
        // v1 stored pixel rects; migrateSpacesState snaps them onto a grid.
        const parsed = migrateSpacesState(JSON.parse(savedSpaces)) as SpacesState;
        if (parsed.spaces?.length) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSpaces(parsed.spaces);
          setActiveIndex(Math.min(parsed.activeIndex ?? 0, parsed.spaces.length - 1));
        }
      } else {
        const legacy = window.localStorage.getItem(STORAGE_DASH_LEGACY);
        if (legacy) {
          const dash = JSON.parse(legacy) as { widgets: unknown[] };
          const migrated = migrateSpacesState({
            spaces: [{ id: nextId("s"), name: "Space 1", widgets: dash.widgets }],
            activeIndex: 0,
          }) as SpacesState;
          setSpaces(migrated.spaces);
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
    setIp(window.localStorage.getItem(STORAGE_IP) || DEFAULT_IP);
  }, []);

  // Redraw the active space + persist all spaces whenever anything changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    drawDashboard(ctx, safeLayout(active));
    if (oneBit) applyMonochrome(canvas);
    let outcome: SaveState;
    try {
      window.localStorage.setItem(
        STORAGE_SPACES,
        JSON.stringify({ version: SPACES_SCHEMA_VERSION, spaces, activeIndex }),
      );
      outcome = "saved";
    } catch {
      outcome = "error"; // storage full / unavailable — non-fatal, but say so
    }
    // Persisting is external-system sync, which belongs in an effect; the badge
    // just reports its outcome. Only re-render when that outcome actually flips,
    // so this can't cascade.
    if (saveRef.current !== outcome) {
      saveRef.current = outcome;
      setSaveState(outcome);
    }
  }, [spaces, activeIndex, active, oneBit]);

  // --- space management --------------------------------------------------------

  const addSpace = useCallback(() => {
    setSpaces((sp) => [...sp, emptySpace(`Space ${sp.length + 1}`)]);
    setActiveIndex(spaces.length); // new space is appended at the old length
  }, [spaces.length]);

  const removeSpace = useCallback(() => {
    setSpaces((sp) => (sp.length <= 1 ? sp : sp.filter((_, i) => i !== activeIndex)));
    setActiveIndex((prev) => Math.max(0, Math.min(prev, spaces.length - 2)));
  }, [activeIndex, spaces.length]);

  const renameSpace = useCallback(
    (name: string) => {
      setSpaces((sp) => sp.map((s, i) => (i === activeIndex ? { ...s, name } : s)));
    },
    [activeIndex],
  );

  // --- widget management (on the active space) ---------------------------------

  const updateActiveWidgets = useCallback(
    (fn: (widgets: Widget[]) => Widget[]) => {
      setSpaces((sp) => sp.map((s, i) => (i === activeIndex ? { ...s, widgets: fn(s.widgets) } : s)));
    },
    [activeIndex],
  );

  const patchWidget = useCallback(
    (id: string, patch: WidgetPatch) => {
      updateActiveWidgets((ws) => ws.map((w) => (w.id === id ? ({ ...w, ...patch } as Widget) : w)));
    },
    [updateActiveWidgets],
  );

  const removeWidget = useCallback(
    (id: string) => updateActiveWidgets((ws) => ws.filter((w) => w.id !== id)),
    [updateActiveWidgets],
  );

  const addWidget = useCallback(
    (type: WidgetType) =>
      updateActiveWidgets((ws) => [...ws, makeWidget(type, ws, active?.grid ?? defaultGrid())]),
    [updateActiveWidgets, active],
  );

  // --- grid ---------------------------------------------------------------------

  /** Resize the active space's grid, refitting any widget that no longer fits. */
  const changeGrid = useCallback(
    (patch: Partial<GridSpec>) => {
      setSpaces((sp) =>
        sp.map((s, i) => {
          if (i !== activeIndex) return s;
          const grid = { ...s.grid, ...patch };
          // Guard against a grid so dense that a cell has no pixels left.
          if (grid.cols < 1 || grid.rows < 1 || grid.margin < 0 || grid.gutter < 0) return s;
          const { widgets, moved } = refitToGrid(s.widgets, grid);
          setGridNote(
            moved.length
              ? `Grid changed — ${moved.length} widget${moved.length === 1 ? "" : "s"} moved to fit.`
              : "",
          );
          return { ...s, grid, widgets };
        }),
      );
    },
    [activeIndex],
  );

  /** Move/resize one widget, but only to a placement that stays legal. */
  const placeWidget = useCallback(
    (id: string, placement: Placement) => {
      updateActiveWidgets((ws) => {
        const grid = active?.grid ?? defaultGrid();
        if (!canPlace(ws, grid, id, placement)) return ws;
        return ws.map((w) => (w.id === id ? { ...w, ...placement } : w));
      });
    },
    [updateActiveWidgets, active],
  );

  // --- data scripts ------------------------------------------------------------

  // Refresh the active space (for editing feedback).
  const refreshActive = useCallback(async () => {
    if (!active) return;
    setRefreshing(true);
    const { widgets, errors } = await runWidgetScripts(active.widgets);
    updateActiveWidgets(() => widgets);
    setScriptErrors(errors);
    setRefreshing(false);
  }, [active, updateActiveWidgets]);

  // Refresh every space's scripts; returns the fresh spaces (for auto-push).
  const refreshAll = useCallback(async (): Promise<Space[]> => {
    setRefreshing(true);
    const errors: Record<string, string> = {};
    const fresh = await Promise.all(
      spaces.map(async (s) => {
        const r = await runWidgetScripts(s.widgets);
        Object.assign(errors, r.errors);
        return { ...s, widgets: r.widgets };
      }),
    );
    setSpaces(fresh);
    setScriptErrors(errors);
    setRefreshing(false);
    return fresh;
  }, [spaces]);

  // --- pushing to the device ---------------------------------------------------

  const postSpace = useCallback(
    async (index: number, space: Space, count: number, show: boolean, target: string) => {
      const bytes = renderDashboardToFrameBytes(safeLayout(space));
      const form = new FormData();
      form.append("frame", new File([bytes], "frame.bin", { type: "application/octet-stream" }));
      const res = await fetch(
        `/x3/api/frame?space=${index}&count=${count}&show=${show ? 1 : 0}`,
        { method: "POST", headers: { "x-crosspoint-ip": target }, body: form },
      );
      if (!res.ok) throw new Error(`X3 rejected space ${index + 1} (HTTP ${res.status})`);
      return bytes.length;
    },
    [],
  );

  const pushActive = useCallback(async () => {
    setBusy(true);
    setStatus("");
    try {
      const target = ip.trim();
      const kb = (await postSpace(activeIndex, active, spaces.length, true, target)) / 1024;
      window.localStorage.setItem(STORAGE_IP, target);
      setStatus(`Pushed "${active.name}" (${kb.toFixed(1)} KB) to ${target}.`);
    } catch (err) {
      setStatus(pushError(err));
    } finally {
      setBusy(false);
    }
  }, [ip, activeIndex, active, spaces.length, postSpace]);

  const pushAll = useCallback(async () => {
    setBusy(true);
    setStatus("");
    try {
      const target = ip.trim();
      for (let i = 0; i < spaces.length; i++) {
        await postSpace(i, spaces[i], spaces.length, false, target);
      }
      window.localStorage.setItem(STORAGE_IP, target);
      setStatus(`Pushed all ${spaces.length} space(s) to ${target}.`);
    } catch (err) {
      setStatus(pushError(err));
    } finally {
      setBusy(false);
    }
  }, [ip, spaces, postSpace]);

  const download = useCallback(async () => {
    try {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("canvas not ready");
      const blob = await exportMonoPng(canvas);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${active?.name ?? "space"}.png`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`Saved ${active?.name}.png (1-bit, 792×528).`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Export failed.");
    }
  }, [active]);

  // --- config export / import ---------------------------------------------------

  /** Save every space to a .json file — survives a cleared browser, diffable in git. */
  const exportConfig = useCallback(() => {
    const state: SpacesState = { version: SPACES_SCHEMA_VERSION, spaces, activeIndex };
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "crosspoint-dashboard.json";
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${spaces.length} space(s) to crosspoint-dashboard.json.`);
  }, [spaces, activeIndex]);

  /**
   * Load a config file. Accepts current builder state, an older pixel-based
   * export, or the output of `layout.mjs --spaces` — everything goes through the
   * same migration, so a CLI-generated layout lands editable in the picker.
   */
  const importConfig = useCallback(async (file: File) => {
    try {
      const raw = JSON.parse(await file.text());
      // A bare Dashboard ({widgets:[...]}) counts as a single space.
      const state = Array.isArray(raw?.spaces)
        ? raw
        : { spaces: [{ id: nextId("s"), name: file.name.replace(/\.json$/i, ""), widgets: raw?.widgets ?? [] }], activeIndex: 0 };
      const migrated = migrateSpacesState(state) as SpacesState;
      if (!migrated.spaces?.length) throw new Error("no spaces in that file");

      // Refit on the way in so an out-of-spec file can't produce overlapping tiles.
      const clean = migrated.spaces.map((s) => ({
        ...s,
        ...(() => {
          const { widgets } = refitToGrid(s.widgets, s.grid);
          return { widgets };
        })(),
      }));
      setSpaces(clean);
      setActiveIndex(Math.min(migrated.activeIndex ?? 0, clean.length - 1));
      setStatus(`Imported ${clean.length} space(s) from ${file.name}.`);
    } catch (err) {
      setStatus(`Import failed: ${err instanceof Error ? err.message : "unreadable file"}`);
    }
  }, []);

  // Upload a firmware .bin to the device's SD card (as /update.bin). Flashing is
  // done separately on the X3 with the stock recovery flow (hold POWER + UP).
  const uploadFirmware = useCallback(async () => {
    if (!fwFile) return;
    setFwBusy(true);
    setFwStatus("");
    try {
      const target = ip.trim();
      const form = new FormData();
      form.append("firmware", fwFile, "update.bin");
      const res = await fetch("/x3/api/firmware", {
        method: "POST",
        headers: { "x-crosspoint-ip": target },
        body: form,
      });
      if (!res.ok) throw new Error(`X3 rejected the upload (HTTP ${res.status})`);
      window.localStorage.setItem(STORAGE_IP, target);
      setFwStatus(
        `Uploaded ${(fwFile.size / 1024 / 1024).toFixed(2)} MB → update.bin. On the X3, hold POWER + UP at boot to flash.`,
      );
    } catch (err) {
      setFwStatus(pushError(err));
    } finally {
      setFwBusy(false);
    }
  }, [fwFile, ip]);

  // Auto-refresh: run every space's scripts, then (optionally) push them all.
  const tickRef = useRef<() => void>(() => {});
  useEffect(() => {
    tickRef.current = () => {
      void (async () => {
        const fresh = await refreshAll();
        if (autoPush) {
          const target = ip.trim();
          for (let i = 0; i < fresh.length; i++) {
            await postSpace(i, fresh[i], fresh.length, false, target);
          }
        }
      })();
    };
  }, [refreshAll, autoPush, ip, postSpace]);

  useEffect(() => {
    if (!autoOn) return;
    const id = setInterval(() => tickRef.current(), Math.max(5, autoSec) * 1000);
    return () => clearInterval(id);
  }, [autoOn, autoSec]);

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.wordmark}>CROSSPOINT / DASHBOARD BUILDER</span>
        <span className={styles.sub}>
          {DASHBOARD_WIDTH}×{DASHBOARD_HEIGHT} · 1-bit · {spaces.length} space
          {spaces.length === 1 ? "" : "s"}
        </span>
      </header>

      <section className={styles.canvasWrap}>
        <div className={styles.stage}>
          <canvas
            ref={canvasRef}
            width={DASHBOARD_WIDTH}
            height={DASHBOARD_HEIGHT}
            className={styles.canvas}
          />
          {active && (
            <TileOverlay
              widgets={active.widgets}
              grid={active.grid}
              scale={scale}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onPlace={placeWidget}
            />
          )}
          {active && selected && (
            <WidgetPopover
              widget={selected}
              grid={active.grid}
              siblings={active.widgets}
              scale={scale}
              error={scriptErrors[selected.id]}
              onChange={(patch) => patchWidget(selected.id, patch as WidgetPatch)}
              onPlace={(placement) => placeWidget(selected.id, placement)}
              onRemove={() => {
                removeWidget(selected.id);
                setSelectedId(null);
              }}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
        <div className={styles.canvasBar}>
          <label className={styles.row} style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={oneBit}
              onChange={(e) => setOneBit(e.target.checked)}
              style={{ width: "auto" }}
            />
            1-bit preview (what the X3 receives)
          </label>
          <span>
            {active?.name} · {active?.widgets.length ?? 0} widgets ·{" "}
            {active?.grid?.cols}×{active?.grid?.rows} grid
            <span className={styles.saveState} data-state={saveState}>
              {saveState === "saved" && "saved ✓"}
              
              {saveState === "error" && "not saved ⚠"}
            </span>
          </span>
        </div>
      </section>

      <div className={styles.panel}>
        <section className={styles.card}>
          <p className={styles.cardTitle}>Spaces</p>
          <div className={styles.spaceTabs}>
            {spaces.map((s, i) => (
              <button
                key={s.id}
                className={i === activeIndex ? styles.spaceTabActive : styles.spaceTab}
                onClick={() => setActiveIndex(i)}
              >
                {s.name}
              </button>
            ))}
            <button className="ghost" onClick={addSpace}>
              + Space
            </button>
          </div>
          <div className={styles.row} style={{ marginTop: 10, gap: 8 }}>
            <input
              aria-label="space name"
              className={styles.grow}
              value={active?.name ?? ""}
              onChange={(e) => renameSpace(e.target.value)}
            />
            <button className={styles.remove} onClick={removeSpace} disabled={spaces.length <= 1}>
              remove
            </button>
          </div>
          <p className={styles.status} style={{ marginTop: 8 }}>
            On the X3, the side ▲/▼ buttons switch spaces. A built-in{" "}
            <strong>System</strong> page (Wi-Fi/IP/battery/time) is always the last one.
          </p>
        </section>

        <section className={styles.card}>
          <p className={styles.cardTitle}>Grid · {active?.name}</p>
          <div className={styles.gridControls}>
            {(
              [
                ["cols", "Cols", 1, 8],
                ["rows", "Rows", 1, 6],
                ["margin", "Margin", 0, 64],
                ["gutter", "Gutter", 0, 48],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  value={active?.grid?.[key] ?? 0}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) changeGrid({ [key]: Math.max(min, Math.min(max, n)) });
                  }}
                />
              </label>
            ))}
          </div>
          {gridNote && <p className={styles.scriptError}>{gridNote}</p>}
          <p className={styles.status} style={{ color: "#888" }}>
            Tiles are placed on this grid, so they can never overlap. Drag a tile on the
            preview to move it.
          </p>
        </section>

        <section className={styles.card}>
          <p className={styles.cardTitle}>Push</p>
          <label className="field">
            Device IP
            <input value={ip} onChange={(e) => setIp(e.target.value)} spellCheck={false} />
          </label>
          <div className={styles.row} style={{ marginTop: 10 }}>
            <button className={styles.grow} onClick={pushActive} disabled={busy}>
              {busy ? "PUSHING…" : "PUSH THIS SPACE"}
            </button>
            <button className="ghost" onClick={pushAll} disabled={busy}>
              PUSH ALL
            </button>
          </div>
          <div className={styles.row} style={{ marginTop: 8 }}>
            <button className="ghost" onClick={download} disabled={busy}>
              DOWNLOAD PNG
            </button>
          </div>
          <div className={styles.row} style={{ marginTop: 8 }}>
            <button className="ghost" onClick={exportConfig}>
              EXPORT JSON
            </button>
            <button className="ghost" onClick={() => importRef.current?.click()}>
              IMPORT JSON
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importConfig(f);
                e.target.value = ""; // let the same file be picked again
              }}
            />
          </div>
          <p className={styles.status}>{status}</p>
        </section>

        <section className={styles.card}>
          <p className={styles.cardTitle}>Firmware</p>
          <input
            type="file"
            accept=".bin"
            onChange={(e) => setFwFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 13 }}
          />
          <button
            className={styles.grow}
            style={{ marginTop: 10 }}
            onClick={uploadFirmware}
            disabled={fwBusy || !fwFile}
          >
            {fwBusy ? "UPLOADING…" : "UPLOAD FIRMWARE TO X3"}
          </button>
          <p className={styles.status}>{fwStatus}</p>
          <p className={styles.status} style={{ color: "#888" }}>
            Sends a .bin to the SD card as <strong>update.bin</strong>. Then on the X3, hold{" "}
            <strong>POWER + UP</strong> at boot to flash it.
          </p>
        </section>

        <section className={styles.card}>
          <p className={styles.cardTitle}>Data</p>
          <button className={styles.grow} onClick={refreshActive} disabled={refreshing}>
            {refreshing ? "REFRESHING…" : "REFRESH THIS SPACE"}
          </button>
          <label className={styles.row} style={{ gap: 6, marginTop: 12 }}>
            <input
              type="checkbox"
              checked={autoOn}
              onChange={(e) => setAutoOn(e.target.checked)}
              style={{ width: "auto" }}
            />
            Auto-refresh all spaces every
            <input
              type="number"
              min={5}
              value={autoSec}
              onChange={(e) => setAutoSec(Math.max(5, Number(e.target.value) || 60))}
              style={{ width: 64 }}
            />
            s
          </label>
          <label className={styles.row} style={{ gap: 6, marginTop: 8 }}>
            <input
              type="checkbox"
              checked={autoPush}
              onChange={(e) => setAutoPush(e.target.checked)}
              style={{ width: "auto" }}
            />
            …then push all to X3
          </label>
        </section>

        <section className={styles.card}>
          <p className={styles.cardTitle}>Widgets · {active?.name}</p>
          <div className={styles.addRow}>
            <button className="ghost" onClick={() => addWidget("metric")}>
              + Metric
            </button>
            <button className="ghost" onClick={() => addWidget("list")}>
              + List
            </button>
            <button className="ghost" onClick={() => addWidget("text")}>
              + Text
            </button>
          </div>
          <p className={styles.status} style={{ color: "#888" }}>
            Drag a tile on the preview to move it, drag its corner to resize, or click
            it to edit. Arrow keys nudge a focused tile by one cell.
          </p>
          {Object.keys(scriptErrors).length > 0 && (
            <p className={styles.scriptError}>
              ⚠ {Object.keys(scriptErrors).length} widget script(s) failed — click the
              tile to see the error.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function pushError(err: unknown): string {
  return err instanceof Error
    ? `${err.message}. Check: "npm run dev" is running, the Device IP matches the X3's screen, and both are on the same Wi-Fi.`
    : "Push failed.";
}

/** Place a new widget in the first free cell, so adding never causes an overlap. */
function makeWidget(type: WidgetType, existing: Widget[], grid: GridSpec): Widget {
  const taken = occupancy(existing) as Map<string, string>;
  let spot = { col: 0, row: 0, colSpan: 1, rowSpan: 1 };
  outer: for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (!taken.has(`${col},${row}`)) {
        spot = { col, row, colSpan: 1, rowSpan: 1 };
        break outer;
      }
    }
  }
  const base = { id: nextId(), ...spot };
  if (type === "metric") {
    return { ...base, type, label: "Label", value: "0", delta: "" };
  }
  if (type === "list") {
    return { ...base, type, title: "List", items: ["Item one", "Item two"] };
  }
  return { ...base, type, text: "Text", size: 28, align: "left" };
}
