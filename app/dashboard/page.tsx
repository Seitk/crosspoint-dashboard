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
import {
  DASHBOARD_HEIGHT,
  DASHBOARD_WIDTH,
  type Dashboard,
  defaultSpaces,
  type ListWidget,
  type MetricWidget,
  nextId,
  type Space,
  type SpacesState,
  type TextWidget,
  type Widget,
  type WidgetType,
} from "./types";

const DEFAULT_IP = "192.168.1.238";
const STORAGE_SPACES = "crosspoint-spaces";
const STORAGE_DASH_LEGACY = "crosspoint-dashboard";
const STORAGE_IP = "crosspoint-device-ip";

/** A patch that may touch any widget field; callers only pass valid ones. */
type WidgetPatch = Partial<
  Omit<MetricWidget, "type" | "id"> &
    Omit<ListWidget, "type" | "id"> &
    Omit<TextWidget, "type" | "id">
>;

function asDashboard(widgets: Widget[]): Dashboard {
  return { width: DASHBOARD_WIDTH, height: DASHBOARD_HEIGHT, widgets };
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

  const active = spaces[activeIndex] ?? spaces[0];

  // Restore saved spaces (or migrate an old single-dashboard config) + device IP.
  useEffect(() => {
    try {
      const savedSpaces = window.localStorage.getItem(STORAGE_SPACES);
      if (savedSpaces) {
        const parsed = JSON.parse(savedSpaces) as SpacesState;
        if (parsed.spaces?.length) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSpaces(parsed.spaces);
          setActiveIndex(Math.min(parsed.activeIndex ?? 0, parsed.spaces.length - 1));
        }
      } else {
        const legacy = window.localStorage.getItem(STORAGE_DASH_LEGACY);
        if (legacy) {
          const dash = JSON.parse(legacy) as Dashboard;
          setSpaces([{ id: nextId("s"), name: "Space 1", widgets: dash.widgets }]);
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
    drawDashboard(ctx, asDashboard(active.widgets));
    if (oneBit) applyMonochrome(canvas);
    try {
      window.localStorage.setItem(STORAGE_SPACES, JSON.stringify({ spaces, activeIndex }));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [spaces, activeIndex, active, oneBit]);

  // --- space management --------------------------------------------------------

  const addSpace = useCallback(() => {
    setSpaces((sp) => [...sp, { id: nextId("s"), name: `Space ${sp.length + 1}`, widgets: [] }]);
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
    (type: WidgetType) => updateActiveWidgets((ws) => [...ws, makeWidget(type, ws.length)]),
    [updateActiveWidgets],
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
    async (index: number, widgets: Widget[], count: number, show: boolean, target: string) => {
      const bytes = renderDashboardToFrameBytes(asDashboard(widgets));
      const form = new FormData();
      form.append("frame", new File([bytes], "frame.bin", { type: "application/octet-stream" }));
      const res = await fetch(
        `/x3/frame?space=${index}&count=${count}&show=${show ? 1 : 0}`,
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
      const kb = (await postSpace(activeIndex, active.widgets, spaces.length, true, target)) / 1024;
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
        await postSpace(i, spaces[i].widgets, spaces.length, false, target);
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

  // Auto-refresh: run every space's scripts, then (optionally) push them all.
  const tickRef = useRef<() => void>(() => {});
  useEffect(() => {
    tickRef.current = () => {
      void (async () => {
        const fresh = await refreshAll();
        if (autoPush) {
          const target = ip.trim();
          for (let i = 0; i < fresh.length; i++) {
            await postSpace(i, fresh[i].widgets, fresh.length, false, target);
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
        <canvas
          ref={canvasRef}
          width={DASHBOARD_WIDTH}
          height={DASHBOARD_HEIGHT}
          className={styles.canvas}
        />
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
            {active?.name} · {active?.widgets.length ?? 0} widgets
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
          <p className={styles.status}>{status}</p>
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
          <div style={{ marginTop: 12 }}>
            {active?.widgets.map((w) => (
              <WidgetEditor
                key={w.id}
                widget={w}
                error={scriptErrors[w.id]}
                onChange={(patch) => patchWidget(w.id, patch)}
                onRemove={() => removeWidget(w.id)}
              />
            ))}
          </div>
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

function WidgetEditor({
  widget,
  error,
  onChange,
  onRemove,
}: {
  widget: Widget;
  error?: string;
  onChange: (patch: WidgetPatch) => void;
  onRemove: () => void;
}) {
  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <div className={styles.widget}>
      <div className={styles.widgetHead}>
        <span className={styles.tag}>{widget.type}</span>
        <button className={styles.remove} onClick={onRemove}>
          remove
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
                  onChange={(e) => onChange({ size: num(e.target.value) })}
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

        <div className={styles.geo}>
          {(["x", "y", "w", "h"] as const).map((k) => (
            <label key={k}>
              {k.toUpperCase()}
              <input
                type="number"
                value={widget[k]}
                onChange={(e) => onChange({ [k]: num(e.target.value) })}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function makeWidget(type: WidgetType, index: number): Widget {
  const y = 16 + (index % 3) * 172;
  const base = { id: nextId(), x: 16, y, w: 372, h: 160 };
  if (type === "metric") {
    return { ...base, type, label: "Label", value: "0", delta: "" };
  }
  if (type === "list") {
    return { ...base, type, h: 220, title: "List", items: ["Item one", "Item two"] };
  }
  return { ...base, type, h: 120, text: "Text", size: 28, align: "left" };
}
