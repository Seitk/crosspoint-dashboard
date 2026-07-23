# Menu patch — make DashboardActivity launchable

Adding a home-menu entry in CrossPoint is a coordinated **code** change across 4 files
(there is no data/config registry). Verified against `crosspoint-reader@1.4.1` source
(pass `w46l814vw`). Insert `DASHBOARD` **between `FILE_TRANSFER` and `SETTINGS_MENU`**, and
keep the enum / both mappers / the two parallel vectors / the `loop()` switch in lockstep.

## 1. `src/activities/ActivityManager.h`
```cpp
enum class HomeMenuItem { NONE, FILE_BROWSER, RECENTS, OPDS_BROWSER, FILE_TRANSFER, DASHBOARD, SETTINGS_MENU };
// ...
void goToDashboard();          // declare after goToFileTransfer();
```

## 2. `src/activities/ActivityManager.cpp`
```cpp
#include "network/DashboardActivity.h"   // matches drop location src/activities/network/
// ...
void ActivityManager::goToDashboard() {
  replaceActivity(std::make_unique<DashboardActivity>(renderer, mappedInput));
}
// optional, in goHome():
//   } else if (activityName == "Dashboard") { initialMenuItem = HomeMenuItem::DASHBOARD;
```

## 3. `src/activities/home/HomeActivity.h`
Add one step to **both** index mappers (after the `FILE_TRANSFER` step) and declare the handler:
```cpp
// in menuItemToIndex(...): after the FILE_TRANSFER step
if (item == HomeMenuItem::DASHBOARD) return i;  ++i;
// in indexToMenuItem(...): after the FILE_TRANSFER line
if (idx == i++) return HomeMenuItem::DASHBOARD;

void onDashboardOpen();
```

## 4. `src/activities/home/HomeActivity.cpp`
```cpp
int count = 5;   // was 4  (File Browser, Recents, File transfer, Dashboard, Settings)

std::vector<const char*> menuItems = {tr(STR_BROWSE_FILES), tr(STR_MENU_RECENT_BOOKS),
                                      tr(STR_FILE_TRANSFER), "Dashboard", tr(STR_SETTINGS_TITLE)};
std::vector<UIIcon>      menuIcons = {Folder, Recent, Transfer, Wifi, Settings};

// loop() switch, before SETTINGS_MENU:
case HomeMenuItem::DASHBOARD: onDashboardOpen(); break;

void HomeActivity::onDashboardOpen() { activityManager.goToDashboard(); }
```

### Notes
- **Icon:** use `UIIcon::Wifi` — `enum UIIcon { None=0, Folder, Text, Image, Book, File, Recent,
  Settings, Transfer, Library, Wifi, Hotspot, Bookmark };` (`src/components/themes/BaseTheme.h`,
  plain unscoped enum → unqualified `Wifi`). It's unused elsewhere in Home and fits an
  HTTP-fetched frame. Do **not** reuse `Transfer` — that's the File-Transfer row's icon.
- **Label:** `STR_DASHBOARD` does not exist in the i18n table; use the literal `"Dashboard"`
  (above) or add a new i18n key. The literal avoids a compile break.
- The pre-existing conditional OPDS row inserts at `.begin()+2`, which is unaffected because
  Dashboard sits after File Transfer.

## 5. Auto-launch the dashboard on boot/wake (`src/main.cpp`)

Makes the device boot straight into the dashboard whenever it was active before
sleep/reboot (an always-on info display). `DashboardActivity` writes a marker file
on entry and removes it when you press **Back**; the boot router checks it.

In `setup()`'s boot-routing `if/else` chain, add a branch **after** the panic check
and **before** the silent-reboot/reader routing:

```cpp
} else if (HalSystem::isRebootFromPanic()) {
  activityManager.goToCrashReport();
} else if (Storage.exists("/.crosspoint/dashboard_mode")) {           // <-- add this branch
  // Hold Back at boot to leave dashboard mode; otherwise relaunch it.
  if (mappedInputManager.isPressed(MappedInputManager::Button::Back)) {
    Storage.remove("/.crosspoint/dashboard_mode");
    activityManager.goHome();
  } else {
    activityManager.goToDashboard();
  }
} else if (resume == BootResume::Silent && /* …existing reader/home routing… */) {
```

`Storage` (`<HalStorage.h>`) and `activityManager` are already included in `main.cpp`.

**Behavior / escape hatches:** press **Back** inside the dashboard to return to
normal reader use (marker removed → normal boot). If the marker ever gets stuck,
hold **Back** at boot (removes it), or delete `/.crosspoint/dashboard_mode` from the
SD card. Recovery mode (**UP + POWER** at boot) always overrides.
