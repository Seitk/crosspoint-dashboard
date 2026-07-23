#pragma once
//
// DashboardActivity — a multi-"space" push dashboard for the Xteink X3. Each space
// is a full-screen 1-bit frame pushed from the web builder and saved to SD; the
// side Up/Down buttons cycle between spaces. Part of the CrossPoint "push
// dashboard" project (see crosspoint-web).
//
// Design: RAW-BLIT. The pushed HTTP body is the exact packed framebuffer
// (1 bpp, MSB-first, bit 1 = white, stride = ceil(width/8); X3 792x528 => 52,272
// bytes). No PNG decode, no heap decode guard.
//
// Drop this file into  src/activities/network/  of a crosspoint-reader @1.4.1
// fork, apply menu-patch.md, then build+flash. See README.md.

#include "activities/Activity.h"  // src/ is on the include path (not src/activities/)

#include <WebServer.h>   // Arduino-ESP32 core (bundled; no lib_deps entry needed)

#include <cstddef>
#include <cstdint>
#include <memory>

class DashboardActivity : public Activity {
 public:
  explicit DashboardActivity(GfxRenderer& renderer, MappedInputManager& mappedInput)
      : Activity("Dashboard", renderer, mappedInput) {}

  void onEnter() override;
  void onExit() override;
  void loop() override;
  void render(RenderLock&&) override;

  // Keep the pump hot and prevent auto-sleep while we're serving.
  bool skipLoopDelay() override { return running; }
  bool preventAutoSleep() override { return running; }

 private:
  void connectWifi();        // STA from saved credentials, non-interactive
  void startServer();
  void handleFrameUpload();  // streams the multipart /frame body into `frame`
  void handleFrameDone();    // saves the frame to its space, displays if current
  void drawStatusBar();      // top bar (device IP + battery) on the idle screen
  void drawSpaceIndicator(); // transient "which space" dots shown on a switch
  void drawSystemInfo();     // built-in System space: Wi-Fi / IP / battery / time / date
  void drawWaitingScreen();  // placeholder for an empty pushed space
  bool saveBufferToSpace(int index);  // write `frame` to space<index>.bin
  bool loadSpaceFrame(int index);     // read space<index> into `frame` (sets haveFrame)
  void switchSpace(int delta);        // side-button space navigation (wraps)
  void persistState();                // save spaceCount + currentSpace to SD
  void loadState();                   // restore spaceCount + currentSpace from SD
  std::size_t frameBytes() const;     // ceil(w/8) * h for the current panel

  std::unique_ptr<WebServer> server;
  std::unique_ptr<uint8_t[]> frame;  // holds the CURRENT space's packed 1-bpp frame
  std::size_t frameCap = 0;
  std::size_t frameWritten = 0;  // bytes streamed in the current upload
  int spaceCount = 1;            // number of dashboard spaces (pages)
  int currentSpace = 0;          // which space is currently displayed
  unsigned long indicatorUntil = 0;  // millis() deadline for the space indicator (0 = off)
  char deviceIp[16] = {0};       // "255.255.255.255" + NUL, set on Wi-Fi connect
  bool haveFrame = false;
  bool wifiUp = false;
  volatile bool running = false;
};
