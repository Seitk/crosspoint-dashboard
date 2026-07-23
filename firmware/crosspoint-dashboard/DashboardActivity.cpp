#include "DashboardActivity.h"

#include "activities/ActivityManager.h"  // extern ActivityManager activityManager;
#include "CrossPointSettings.h"     // SETTINGS (clock offset / format) for the System space
#include "WifiCredentialStore.h"    // WIFI_STORE / WifiCredential
#include "fontIds.h"                // UI_12_FONT_ID / UI_10_FONT_ID / NOTOSANS_*

#include <HalClock.h>               // halClock — RTC time for the System space
#include <HalPowerManager.h>        // powerManager.getBatteryPercentage()
#include <HalStorage.h>             // Storage / HalFile — persist spaces to SD
#include <Logging.h>                // LOG_ERR / LOG_INF
#include <Memory.h>                 // makeUniqueNoThrow (never bare `new` — -fno-exceptions)

#include <WiFi.h>
#include <esp_task_wdt.h>

#include <cstdio>
#include <cstring>
#include <ctime>

// Up to this many dashboard "spaces" (pages). Side Up/Down cycle between them.
static constexpr int MAX_SPACES = 8;

// How long the "which space" indicator stays on screen after a switch.
static constexpr unsigned long INDICATOR_MS = 2000;

// Sentinel for the built-in System space (always the last page in the cycle).
static constexpr int SYSTEM_SPACE = MAX_SPACES;

// SD survives sleep + power loss; /.crosspoint already exists (Wi-Fi creds there).
static constexpr const char* STATE_PATH = "/.crosspoint/dash_state.bin";
// Presence of this marker boots the device straight into the dashboard (main.cpp).
static constexpr const char* MODE_MARKER_PATH = "/.crosspoint/dashboard_mode";

static void spacePath(int index, char* out, size_t n) {
  snprintf(out, n, "/.crosspoint/space%d.bin", index);
}

// Bytes in one packed 1-bpp frame for the current panel geometry. Read at runtime
// so the same binary is correct on X3 (792x528, stride 99) and X4 (800x480, 100).
// Valid only after the orientation is set in onEnter().
std::size_t DashboardActivity::frameBytes() const {
  const int w = renderer.getScreenWidth();
  const int h = renderer.getScreenHeight();
  return static_cast<std::size_t>((w + 7) / 8) * static_cast<std::size_t>(h);
}

// --- SD persistence ------------------------------------------------------------

bool DashboardActivity::saveBufferToSpace(int index) {
  if (!frame) return false;
  char path[40];
  spacePath(index, path, sizeof(path));
  HalFile file;
  if (!Storage.openFileForWrite("DASH", path, file)) {
    LOG_ERR("DASH", "save space %d: open for write failed", index);
    return false;
  }
  const size_t n = file.write(frame.get(), frameCap);
  if (n != frameCap) {
    LOG_ERR("DASH", "save space %d: wrote %u/%u", index, static_cast<unsigned>(n),
            static_cast<unsigned>(frameCap));
    return false;
  }
  return true;  // HalFile auto-closes at scope exit (DESTRUCTOR_CLOSES_FILE=1).
}

bool DashboardActivity::loadSpaceFrame(int index) {
  haveFrame = false;
  if (!frame) return false;
  char path[40];
  spacePath(index, path, sizeof(path));
  if (!Storage.exists(path)) return false;
  const size_t n = Storage.readFileToBuffer(
      path, reinterpret_cast<char*>(frame.get()), frameCap, frameCap);
  if (n == frameCap) {
    haveFrame = true;
    return true;
  }
  if (n > 0) LOG_ERR("DASH", "space %d wrong size (%u), ignoring", index, static_cast<unsigned>(n));
  return false;
}

void DashboardActivity::persistState() {
  const int32_t data[2] = {static_cast<int32_t>(spaceCount), static_cast<int32_t>(currentSpace)};
  HalFile file;
  if (!Storage.openFileForWrite("DASH", STATE_PATH, file)) return;
  file.write(data, sizeof(data));
}

void DashboardActivity::loadState() {
  spaceCount = 1;
  currentSpace = 0;
  char buf[8];
  const size_t n = Storage.readFileToBuffer(STATE_PATH, buf, sizeof(buf), sizeof(buf));
  if (n == sizeof(buf)) {
    int32_t data[2];
    memcpy(data, buf, sizeof(data));  // memcpy: RISC-V unaligned-load safe
    spaceCount = data[0];
    currentSpace = data[1];
  }
  if (spaceCount < 1) spaceCount = 1;
  if (spaceCount > MAX_SPACES) spaceCount = MAX_SPACES;
  if (currentSpace != SYSTEM_SPACE && (currentSpace < 0 || currentSpace >= spaceCount)) {
    currentSpace = 0;
  }
}

// --- lifecycle -----------------------------------------------------------------

void DashboardActivity::onEnter() {
  Activity::onEnter();
  // MANDATORY: drawImage rotates only the origin corner, not the pixel bits, so a
  // full-frame 1:1 blit is correct ONLY in the native LandscapeCounterClockwise
  // orientation. This also makes getScreenWidth()/Height() return 792x528.
  renderer.setOrientation(GfxRenderer::LandscapeCounterClockwise);

  // One persistent frame buffer (the current space), reused for every push/switch.
  frameCap = frameBytes();
  frame = makeUniqueNoThrow<uint8_t[]>(frameCap);
  if (!frame) {
    LOG_ERR("DASH", "OOM frame buffer: %u bytes", static_cast<unsigned>(frameCap));
  }

  // Enter "dashboard mode": the device boots back into the dashboard after
  // sleep/reboot (see main.cpp routing) until the user leaves via Back.
  Storage.ensureDirectoryExists("/.crosspoint");
  Storage.writeFile(MODE_MARKER_PATH, "1");

  // Restore the space we were on so a wake/relaunch shows it immediately (even
  // before Wi-Fi connects) instead of a blank waiting screen.
  loadState();
  loadSpaceFrame(currentSpace);
  requestUpdate();

  connectWifi();
  startServer();
  running = true;
  if (!haveFrame) requestUpdate();  // empty space: repaint the placeholder with the IP
}

void DashboardActivity::onExit() {
  running = false;
  if (server) {
    server->stop();
    server.reset();
  }
  WiFi.disconnect(/*wifioff=*/false);
  frame.reset();
  renderer.setOrientation(GfxRenderer::Portrait);  // restore the launcher's orientation
  // NOTE: unlike CrossPointWebServerActivity::onExit(), we deliberately do NOT
  // call silentRestart() — the dashboard should return to the launcher, not reboot.
  Activity::onExit();
}

// Non-interactive STA connect from the credentials the user already saved via the
// stock File-Transfer / Wi-Fi flow. persistent(false) + disconnect(true,true)
// mirror the firmware's deliberate NVS-suppression sequence.
void DashboardActivity::connectWifi() {
  wifiUp = false;
  WIFI_STORE.loadFromFile();
  const std::string ssid = WIFI_STORE.getLastConnectedSsid();
  if (ssid.empty()) return;  // no saved network
  const WifiCredential* cred = WIFI_STORE.findCredential(ssid);
  if (cred == nullptr) return;

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(100);
  WiFi.setSleep(false);  // reliability while serving

  String mac = WiFi.macAddress();
  mac.replace(":", "");
  WiFi.setHostname(("CrossPoint-Reader-" + mac).c_str());

  if (!cred->password.empty()) {
    WiFi.begin(ssid.c_str(), cred->password.c_str());
  } else {
    WiFi.begin(ssid.c_str());  // open network
  }

  constexpr unsigned long CONNECTION_TIMEOUT_MS = 15000;  // firmware constant
  const unsigned long start = millis();
  while (millis() - start < CONNECTION_TIMEOUT_MS) {
    const wl_status_t s = WiFi.status();
    if (s == WL_CONNECTED) {
      WIFI_STORE.setLastConnectedSsid(ssid);
      wifiUp = true;
      const IPAddress ip = WiFi.localIP();
      snprintf(deviceIp, sizeof(deviceIp), "%d.%d.%d.%d", ip[0], ip[1], ip[2], ip[3]);
      LOG_INF("DASH", "Wi-Fi connected: %s", deviceIp);
      return;
    }
    if (s == WL_CONNECT_FAILED || s == WL_NO_SSID_AVAIL) break;
    delay(50);
    esp_task_wdt_reset();
  }
  WiFi.disconnect();
  LOG_ERR("DASH", "Wi-Fi connect failed for SSID %s", ssid.c_str());
}

void DashboardActivity::startServer() {
  server = makeUniqueNoThrow<WebServer>(80);
  if (!server) {
    LOG_ERR("DASH", "OOM WebServer");
    return;
  }
  // Two-lambda upload form: the second lambda streams the body chunk-by-chunk,
  // the first runs once the upload completes (like the stock /upload endpoint).
  server->on(
      "/frame", HTTP_POST, [this] { handleFrameDone(); }, [this] { handleFrameUpload(); });
  server->on("/", HTTP_GET, [this] {
    server->send(200, "text/plain",
                 "CrossPoint dashboard. POST a packed 1-bit frame to "
                 "/frame?space=<i>&count=<n>&show=<0|1>.\n");
  });
  server->onNotFound([this] { server->send(404, "text/plain", "Not found\n"); });
  server->begin();
}

// The frame arrives as a multipart/form-data file upload (like the stock /upload
// endpoint). The ESP32 WebServer's raw arg("plain") path is unreliable for a 52 KB
// body, so we stream the chunks into the frame buffer instead.
void DashboardActivity::handleFrameUpload() {
  HTTPUpload& up = server->upload();
  if (up.status == UPLOAD_FILE_START) {
    frameWritten = 0;
  } else if (up.status == UPLOAD_FILE_WRITE) {
    esp_task_wdt_reset();
    if (frame && frameWritten + up.currentSize <= frameCap) {
      std::memcpy(frame.get() + frameWritten, up.buf, up.currentSize);
    }
    frameWritten += up.currentSize;  // keep counting to detect an oversized body
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    frameWritten = 0;
  }
}

// Runs once the upload completes: save the frame to its space, prune removed
// spaces, and display it if it's the space currently shown.
void DashboardActivity::handleFrameDone() {
  const std::size_t expected = frameBytes();
  if (!frame) {
    server->send(500, "text/plain", "No frame buffer\n");
    return;
  }
  if (frameWritten != expected) {
    server->send(400, "text/plain",
                 String("Bad frame size; expected ") + static_cast<int>(expected) +
                     " got " + static_cast<int>(frameWritten) + "\n");
    frameWritten = 0;
    return;
  }
  frameWritten = 0;

  // Query params: which space, how many spaces total, and whether to switch to it.
  int space = server->hasArg("space") ? static_cast<int>(server->arg("space").toInt()) : 0;
  int count = server->hasArg("count") ? static_cast<int>(server->arg("count").toInt()) : 1;
  const bool show = server->hasArg("show") && server->arg("show").toInt() != 0;
  if (space < 0) space = 0;
  if (space >= MAX_SPACES) space = MAX_SPACES - 1;
  if (count < 1) count = 1;
  if (count > MAX_SPACES) count = MAX_SPACES;

  // `frame` holds the just-uploaded bytes — save them as this space.
  saveBufferToSpace(space);

  // The editor is authoritative on the space count: drop files for removed spaces.
  for (int i = count; i < MAX_SPACES; i++) {
    char path[40];
    spacePath(i, path, sizeof(path));
    if (Storage.exists(path)) Storage.remove(path);
  }
  spaceCount = count;
  if (show) currentSpace = space;
  if (currentSpace != SYSTEM_SPACE && currentSpace >= spaceCount) currentSpace = 0;
  persistState();

  server->send(200, "text/plain", "OK\n");

  if (space == currentSpace) {
    haveFrame = true;             // buffer already holds this space -> display it
    requestUpdateAndWait();
  } else if (currentSpace != SYSTEM_SPACE) {
    loadSpaceFrame(currentSpace);  // we clobbered the buffer; restore the shown space
  }
  // If we're on the System space, its screen is drawn live — nothing to restore.
  LOG_INF("DASH", "Saved space %d (of %d)%s", space, count, show ? ", showing" : "");
}

// Side-button navigation. The cycle is: pushed spaces 0..spaceCount-1, then the
// built-in System space, wrapping around.
void DashboardActivity::switchSpace(int delta) {
  const int total = spaceCount + 1;  // + System space
  int pos = (currentSpace == SYSTEM_SPACE) ? spaceCount : currentSpace;
  pos = ((pos + delta) % total + total) % total;
  currentSpace = (pos == spaceCount) ? SYSTEM_SPACE : pos;
  persistState();
  if (currentSpace != SYSTEM_SPACE) {
    loadSpaceFrame(currentSpace);  // into the buffer (sets haveFrame)
  } else {
    haveFrame = false;  // System space is drawn live, not from a frame
  }
  indicatorUntil = millis() + INDICATOR_MS;  // flash the "which space" indicator
  requestUpdate();
  LOG_INF("DASH", "Switched (currentSpace=%d, %d pushed + system)", currentSpace, spaceCount);
}

// A pill of dots at the bottom (current space filled, others hollow), drawn over
// the frame right after a switch and cleared by loop() a couple seconds later, so
// it never permanently covers the pushed content.
void DashboardActivity::drawSpaceIndicator() {
  const int n = spaceCount + 1;  // pushed spaces + the built-in System space
  if (n <= 1) return;
  const int pos = (currentSpace == SYSTEM_SPACE) ? spaceCount : currentSpace;
  const int w = renderer.getScreenWidth();
  const int h = renderer.getScreenHeight();
  constexpr int dot = 12;
  constexpr int gap = 10;
  constexpr int pad = 12;
  const int pillW = n * dot + (n - 1) * gap + 2 * pad;
  const int pillH = dot + 2 * pad;
  const int px = (w - pillW) / 2;
  const int py = h - pillH - 16;

  renderer.fillRoundedRect(px, py, pillW, pillH, pillH / 2, Color::White);
  renderer.drawRoundedRect(px, py, pillW, pillH, 2, pillH / 2, true);
  for (int i = 0; i < n; i++) {
    const int dx = px + pad + i * (dot + gap);
    const int dy = py + pad;
    if (i == pos) {
      renderer.fillRoundedRect(dx, dy, dot, dot, dot / 2, Color::Black);  // filled = current
    } else {
      renderer.drawRoundedRect(dx, dy, dot, dot, 2, dot / 2, true);       // hollow = other
    }
  }
}

void DashboardActivity::render(RenderLock&&) {
  if (currentSpace == SYSTEM_SPACE) {
    drawSystemInfo();
  } else if (haveFrame && frame) {
    // Verified packing (w46l814vw): MSB-first, bit 1 = white, stride ceil(w/8) —
    // exactly what the web side emits. drawImage writes every pixel and lands 1:1
    // because onEnter() set the orientation. If the panel shows an INVERTED image,
    // flip polarity on the web side in packMonoToBits — do not patch firmware.
    renderer.drawImage(frame.get(), 0, 0, renderer.getScreenWidth(),
                       renderer.getScreenHeight());
  } else {
    drawWaitingScreen();
  }
  if (indicatorUntil != 0) drawSpaceIndicator();  // transient overlay after a switch
  renderer.displayBuffer(HalDisplay::FAST_REFRESH);
}

// Placeholder shown for a pushed space that has no frame yet.
void DashboardActivity::drawWaitingScreen() {
  renderer.clearScreen(0xFF);  // 0xFF = white
  drawStatusBar();
  char line[64];
  if (wifiUp) {
    snprintf(line, sizeof(line), "Space %d/%d - waiting for a frame...", currentSpace + 1,
             spaceCount);
  } else {
    snprintf(line, sizeof(line), "Space %d/%d - Wi-Fi not connected", currentSpace + 1,
             spaceCount);
  }
  renderer.drawCenteredText(UI_12_FONT_ID, renderer.getScreenHeight() / 2, line);
}

// Built-in System space: live device status (not pushed from the editor). The RTC
// gives local time; the full date needs the system clock set (Settings -> Clock sync).
void DashboardActivity::drawSystemInfo() {
  const int w = renderer.getScreenWidth();
  renderer.clearScreen(0xFF);
  renderer.drawCenteredText(NOTOSANS_18_FONT_ID, 34, "SYSTEM");
  renderer.drawLine(60, 78, w - 60, 78);

  constexpr int labelX = 60;
  constexpr int valueX = 250;
  constexpr int rowH = 62;
  int y = 108;
  char value[96];

  renderer.drawText(NOTOSANS_16_FONT_ID, labelX, y, "Wi-Fi");
  renderer.drawText(NOTOSANS_16_FONT_ID, valueX, y, wifiUp ? WiFi.SSID().c_str() : "not connected");
  y += rowH;

  renderer.drawText(NOTOSANS_16_FONT_ID, labelX, y, "IP");
  renderer.drawText(NOTOSANS_16_FONT_ID, valueX, y, wifiUp ? deviceIp : "-");
  y += rowH;

  const unsigned pct = static_cast<unsigned>(powerManager.getBatteryPercentage());
  const unsigned pctClamped = pct > 100 ? 100 : pct;
  renderer.drawText(NOTOSANS_16_FONT_ID, labelX, y, "Battery");
  {
    // Battery-shaped bar: outline + terminal nub + proportional fill.
    const int barX = valueX;
    const int barY = y + 2;
    const int barW = 150;
    const int barH = 26;
    const int nubW = 5;
    const int nubH = 12;
    renderer.drawRect(barX, barY, barW, barH, 2, true);
    renderer.fillRect(barX + barW, barY + (barH - nubH) / 2, nubW, nubH, true);
    const int fillW = (barW - 8) * static_cast<int>(pctClamped) / 100;
    if (fillW > 0) renderer.fillRect(barX + 4, barY + 4, fillW, barH - 8, true);
    snprintf(value, sizeof(value), "%u%%", pct);
    renderer.drawText(NOTOSANS_16_FONT_ID, barX + barW + nubW + 16, y, value);
  }
  y += rowH;

  char timeBuf[12];
  const bool haveTime =
      halClock.isAvailable() &&
      halClock.formatTime(timeBuf, sizeof(timeBuf), SETTINGS.clockUtcOffsetQ, SETTINGS.clockFormat == 1);
  renderer.drawText(NOTOSANS_16_FONT_ID, labelX, y, "Time");
  renderer.drawText(NOTOSANS_16_FONT_ID, valueX, y, haveTime ? timeBuf : "--");
  y += rowH;

  renderer.drawText(NOTOSANS_16_FONT_ID, labelX, y, "Date");
  const time_t nowUtc = time(nullptr);
  if (nowUtc > 1700000000) {  // system clock is set (e.g. after an NTP sync)
    const long offsetSec = (static_cast<long>(SETTINGS.clockUtcOffsetQ) - 48) * 15 * 60;
    const time_t local = nowUtc + offsetSec;
    struct tm tmv;
    gmtime_r(&local, &tmv);
    snprintf(value, sizeof(value), "%04d-%02d-%02d", tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday);
    renderer.drawText(NOTOSANS_16_FONT_ID, valueX, y, value);
  } else {
    renderer.drawText(NOTOSANS_16_FONT_ID, valueX, y, "sync clock in Settings");
  }

  renderer.drawCenteredText(UI_10_FONT_ID, renderer.getScreenHeight() - 28,
                            "System space - side buttons switch pages");
}

// Top status bar on the idle screen: device IP (left), battery (right), separator.
void DashboardActivity::drawStatusBar() {
  const int w = renderer.getScreenWidth();
  constexpr int margin = 14;
  constexpr int textY = 18;
  constexpr int lineY = 42;

  char left[40];
  if (wifiUp) {
    snprintf(left, sizeof(left), "IP  %s", deviceIp);
  } else {
    snprintf(left, sizeof(left), "Wi-Fi  offline");
  }
  renderer.drawText(UI_10_FONT_ID, margin, textY, left);

  char right[16];
  snprintf(right, sizeof(right), "BAT  %u%%",
           static_cast<unsigned>(powerManager.getBatteryPercentage()));
  const int rw = renderer.getTextWidth(UI_10_FONT_ID, right);
  renderer.drawText(UI_10_FONT_ID, w - rw - margin, textY, right);

  renderer.drawLine(0, lineY, w, lineY);
}

void DashboardActivity::loop() {
  if (!server || !running) return;
  esp_task_wdt_reset();
  // Once the indicator's window elapses, repaint the frame cleanly (drops the dots).
  if (indicatorUntil != 0 && millis() >= indicatorUntil) {
    indicatorUntil = 0;
    requestUpdate();
  }
  constexpr int MAX_ITERATIONS = 500;
  for (int i = 0; i < MAX_ITERATIONS && running; i++) {
    server->handleClient();
    if ((i & 0x1F) == 0x1F) esp_task_wdt_reset();   // feed WDT every 32
    if ((i & 0x3F) == 0x3F) {                        // check input every 64
      yield();
      mappedInput.update();
      if (mappedInput.wasPressed(MappedInputManager::Button::Back)) {
        Storage.remove(MODE_MARKER_PATH);  // leave dashboard mode: normal boot next time
        activityManager.goHome();
        return;
      }
      // Side buttons cycle spaces (Down = next, Up = previous, wraps).
      if (mappedInput.wasPressed(MappedInputManager::Button::Down)) {
        switchSpace(+1);
      } else if (mappedInput.wasPressed(MappedInputManager::Button::Up)) {
        switchSpace(-1);
      }
    }
  }
}
