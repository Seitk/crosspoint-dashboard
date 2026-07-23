# CrossPoint X3 — Dashboard Activity (firmware drop-in)

On-device piece of the CrossPoint **push dashboard**. An `Activity` that runs an HTTP
server on the X3, receives full-screen 1-bit frames from the web builder (`/dashboard` in
this repo), saves them to SD, and blits them to the e-ink panel — the X3 is a pure display.

Features:
- **Multiple spaces** (pages) navigated with the side ▲/▼ buttons, with a transient dot
  indicator on switch.
- A built-in **System** page (Wi-Fi / IP / battery bar / time / date), rendered live on-device.
- **Persistence** — the last frame per space survives sleep/reboot.
- **Auto-launch** into the dashboard on boot after sleep (see `menu-patch.md` §5).

> **These files compile inside a `crosspoint-reader` fork, not in this web repo.** Your
> editor will show "Activity.h not found" errors here — that's expected; the firmware
> headers live in the fork. (`.clangd` suppresses them.)

## Design: raw 1-bit blit
The pushed body **is** the packed framebuffer — no PNG decode, no SD spool, no heap
decode guard. This removes the three biggest firmware risks and keeps the fork tiny.

## Wire contract (must match the web push)
- `POST /frame?space=<i>&count=<n>&show=<0|1>` on port 80, as **`multipart/form-data`** with
  the frame as a file field. (The ESP32 `WebServer` streams a large body via its upload
  handler; the raw `arg("plain")` path is unreliable at 52 KB and just closes the socket.)
  - `space` — which space, 0-based; `count` — total pushed spaces (extras are pruned from SD);
    `show=1` switches the device to that space.
- Body (the file): packed 1-bpp frame, **MSB-first, bit 1 = white**, row stride `ceil(width/8)`.
  - **X3: 792×528 → stride 99 → 52,272 bytes.** Read geometry at runtime; never hardcode.
- `200 OK` after the frame is saved (and displayed if it's the space currently shown).
- Wrong body size → `400` with the expected/received byte counts.

## Files
| File | Purpose |
|---|---|
| `DashboardActivity.h` / `.cpp` | the Activity (copy into `src/activities/network/`) |
| `menu-patch.md` | exact edits to 4 files to make it launchable from Home |

## Apply, build, flash
```sh
git clone --recursive https://github.com/crosspoint-reader/crosspoint-reader
cd crosspoint-reader && git checkout 1.4.1
cp -r <this-folder>/DashboardActivity.{h,cpp} src/activities/network/
# apply menu-patch.md by hand
pio run                     # clean baseline first is recommended
pio run --target upload     # app-only flash @ 0x10000
```
**X3 detection:** the single binary detects X3 at runtime from NVS (`cphw/dev_det`). An
app-only `upload` does **not** touch NVS, so a device that has booted official firmware
stays detected. **Do not `esptool erase_flash`** (wipes NVS); if you must, set NVS
`cphw/dev_ovr=2`. Build is `-fno-exceptions` → no `try/catch`.

## Flashing without USB — SD-card `firmware.bin` (the "drop-in" way)

CrossPoint can flash from an SD-card image (`SdFirmwareUpdateActivity` + `FirmwareFlasher`),
so you never need USB or a local toolchain:

1. **Fork** `crosspoint-reader/crosspoint-reader`, branch from `1.4.1`, add these files + apply
   `menu-patch.md`, and **push**.
2. **Let CI build it.** The fork's existing `.github/workflows/ci.yml` runs `pio run` and
   uploads **`firmware.bin`** as a build artifact on every push (`.pio/build/default/firmware.bin`).
   Download it from the Actions run. (Enable Actions on your fork if prompted.)
   - Local alternative if you prefer: `pio run` → `.pio/build/default/firmware.bin`.
3. **Apply it:** copy `firmware.bin` to the SD card, then on the device go **Settings → Check
   for updates** and pick the `.bin` (the picker shows only `.bin` files). CrossPoint validates
   the image (header magic + OTA-partition fit via `Update.begin`), asks to confirm, flashes over
   the OTA partition, and reboots — no USB.

**Notes**
- The SD updater flashes the OTA **app** partition and reboots; **NVS is untouched, so X3
  detection is preserved** (same as an app-only USB flash). No `erase_flash` involved.
- The filename isn't critical — you pick the file in the browser — but `firmware.bin` is the
  documented convention.

## End-to-end test
1. Ensure the X3 has joined your Wi-Fi once (saved creds) and is on the same LAN.
2. On the X3, open **Dashboard** from the home menu → it connects Wi-Fi and shows a
   "waiting for frame" screen. Note its IP.
3. In the web builder (`npm run dev` → `/dashboard`), set **Device IP** and **Push to X3**.
4. The frame should appear on the panel within a refresh.

Treat this as a **docked / plugged-in** dashboard — always-on Wi-Fi serving is what the
platform normally avoids for battery reasons.

## Verification status (source-review pass `w46l814vw`, vs `crosspoint-reader@1.4.1`)

**Verified & applied in this code:**
- Packing **MSB-first / bit 1 = white / stride ceil(w/8)** — matches the web encoder exactly, so
  no inversion is needed.
- `drawImage(buf, 0, 0, w, h)` blits a full frame in **one call** — but only in
  `LandscapeCounterClockwise` (it rotates the origin, not the bits). `onEnter()` sets that
  orientation; `onExit()` restores Portrait. **This was the one blocker in the first draft.**
- STA connect sequence: `persistent(false)` / `disconnect(true,true)` / hostname / `begin` /
  poll `WL_CONNECTED` with a 15 s timeout.
- `requestUpdateAndWait()` from the `/frame` handler is legal (Main Task, holds no `RenderLock`).
- `MappedInputManager::Button::Back`, the Activity ctor/virtuals, and the menu edits
  (see `menu-patch.md`, incl. `UIIcon::Wifi`).
- Per-frame refresh is `FAST_REFRESH` (not FULL) to avoid a full flash on every push.

**Remaining — do at first on-device run:**
1. **One polarity smoke test.** The vendored `EInkDisplay` copy loop wasn't read directly; polarity
   is inferred (strongly) from `DirectPixelWriter` + the ditherer + the `Logo120` asset. If the
   first pushed frame is **inverted**, flip on the web side in `packMonoToBits` — do not patch firmware.
2. **Status-screen text** is commented out — confirm `drawCenteredText`'s signature + a valid
   `fontId` in `GfxRenderer.h`, then enable it. (`clearScreen(0xFF)` draws the white waiting screen.)
