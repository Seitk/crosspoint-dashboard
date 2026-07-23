"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type DeviceStatus = {
  version: string;
  ip: string;
  mode: string;
  rssi: number;
  freeHeap: number;
  uptime: number;
  device: string;
};

type ConnectionState = "checking" | "connected" | "offline";

const DEFAULT_IP = "192.168.1.238";

function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatHeap(bytes: number) {
  return `${Math.round(bytes / 1024)} KB`;
}

export default function Home() {
  const [ip, setIp] = useState(DEFAULT_IP);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");

  const checkDevice = useCallback(async (targetIp: string) => {
    setConnection("checking");
    setMessage("");
    try {
      const response = await fetch(
        "/x3/api/status",
        {
          cache: "no-store",
          headers: { "x-crosspoint-ip": targetIp },
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Device not found");
      setStatus(payload);
      setConnection("connected");
      window.localStorage.setItem("crosspoint-device-ip", targetIp);
    } catch {
      setStatus(null);
      setConnection("offline");
    }
  }, []);

  useEffect(() => {
    const savedIp = window.localStorage.getItem("crosspoint-device-ip") || DEFAULT_IP;
    // SSR-safe restore from localStorage on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIp(savedIp);
    void checkDevice(savedIp);
  }, [checkDevice]);

  function handleConnect(event: FormEvent) {
    event.preventDefault();
    void checkDevice(ip.trim());
  }

  async function sendDemo() {
    setSending(true);
    setMessage("");
    try {
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 13);
      const filename = `crosspoint-web-demo-${stamp}.txt`;
      const content = [
        "HELLO X3",
        "========",
        "",
        "This file was created by CrossPoint Web.",
        `Device: XTEINK X3 at ${ip.trim()}`,
        `Created: ${now.toISOString()}`,
        "",
        "If you can read this on your X3, custom content works.",
        "",
        "NEXT: build a real CrossPoint plugin.",
      ].join("\n");
      const form = new FormData();
      form.append("file", new Blob([content], { type: "text/plain;charset=utf-8" }), filename);

      const response = await fetch("/x3/upload?path=%2F", {
        method: "POST",
        headers: { "x-crosspoint-ip": ip.trim() },
        body: form,
      });
      if (!response.ok) throw new Error(`X3 上載失敗 (${response.status})`);
      setMessage(`已傳送 ${filename} — 而家可以喺 X3 打開佢。`);
      void checkDevice(ip.trim());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "傳送失敗，請再試一次。");
    } finally {
      setSending(false);
    }
  }

  const deviceBase = `http://${ip.trim()}`;

  return (
    <main className="shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="CrossPoint Web home">
          <span className="wordmark-mark">CP</span>
          <span>CROSSPOINT / WEB</span>
        </a>
        <div className={`connection-pill ${connection}`}>
          <span className="status-dot" />
          {connection === "connected"
            ? "X3 CONNECTED"
            : connection === "checking"
              ? "CHECKING"
              : "OFFLINE"}
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">LOCAL COMPANION / ALPHA 01</p>
          <h1>你部 X3，<br />而家有個網頁控制台。</h1>
        </div>
        <p className="hero-copy">
          呢個係第一個連線 proof：讀取 CrossPoint Reader 狀態，再將一份自訂文字檔直接送入 SD 卡。
        </p>
      </section>

      <section className="connect-panel" aria-label="Device connection">
        <form onSubmit={handleConnect} className="ip-form">
          <label htmlFor="device-ip">DEVICE IP</label>
          <div className="input-row">
            <input
              id="device-ip"
              value={ip}
              onChange={(event) => setIp(event.target.value)}
              inputMode="decimal"
              spellCheck={false}
              aria-describedby="ip-hint"
            />
            <button type="submit" className="secondary-button">
              {connection === "checking" ? "CHECKING…" : "CONNECT"}
            </button>
          </div>
          <p id="ip-hint">同一個 Wi-Fi 先可以連線。</p>
        </form>

        <div className="device-summary">
          <p className="micro-label">CURRENT DEVICE</p>
          <strong>{status ? `${status.device} / CROSSPOINT` : "— / NOT FOUND"}</strong>
          <span>{status ? status.ip : "檢查 IP 或 Wi-Fi 連線"}</span>
        </div>
      </section>

      <section className="metrics" aria-label="Live device status">
        <article>
          <span>FIRMWARE</span>
          <strong>{status?.version ?? "—"}</strong>
          <small>CrossPoint Reader</small>
        </article>
        <article>
          <span>WI-FI SIGNAL</span>
          <strong>{status ? `${status.rssi} dBm` : "—"}</strong>
          <small>{status?.mode === "STA" ? "Home network" : "Not available"}</small>
        </article>
        <article>
          <span>FREE MEMORY</span>
          <strong>{status ? formatHeap(status.freeHeap) : "—"}</strong>
          <small>Live reading</small>
        </article>
        <article>
          <span>UPTIME</span>
          <strong>{status ? formatUptime(status.uptime) : "—"}</strong>
          <small>Since last boot</small>
        </article>
      </section>

      <section className="proof-grid">
        <article className="proof-card">
          <div className="proof-heading">
            <div>
              <p className="eyebrow">CUSTOM CONTENT TEST</p>
              <h2>Send a hello to X3.</h2>
            </div>
            <span className="step-number">01</span>
          </div>
          <p className="proof-copy">
            按一下，我哋會建立一份有獨有時間標記嘅文字檔，直接傳去 X3 SD 卡根目錄。
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={sendDemo}
            disabled={connection !== "connected" || sending}
          >
            {sending ? "SENDING TO X3…" : "SEND DEMO TO X3"}
            <span aria-hidden="true">→</span>
          </button>
          {message && <p className="result-message" role="status">{message}</p>}
        </article>

        <aside className="next-card">
          <span className="step-number">02</span>
          <div>
            <p className="micro-label">ON YOUR X3</p>
            <h3>開啟新檔案</h3>
            <p>返去書庫，打開「crosspoint-web-demo…txt」。見到 HELLO X3 就代表 custom content 成功。</p>
          </div>
        </aside>
      </section>

      <nav className="device-links" aria-label="CrossPoint device links">
        <span>DEVICE SHORTCUTS</span>
        <a href={`${deviceBase}/files`} target="_blank" rel="noreferrer">FILE MANAGER ↗</a>
        <a href={`${deviceBase}/settings`} target="_blank" rel="noreferrer">SETTINGS ↗</a>
        <a href={`${deviceBase}/fonts`} target="_blank" rel="noreferrer">FONTS ↗</a>
      </nav>

      <footer>
        <span>BUILT FOR XTEINK X3</span>
        <span>LOCAL ONLY · NO CLOUD</span>
      </footer>
    </main>
  );
}
