# RadialDeck

A radial / grid **virtual keyboard overlay** for Windows, built with Electron. Float
customizable shortcut layouts over any app and fire them by mouse, touch, or pen — a
BUGKEY-style on-screen control surface for creators.

![platform](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Features

- **Radial & grid layouts** — a draggable center orb opens a ring of buttons, or a
  grid/numpad-style pad. Switch layouts on the fly.
- **Sends real synthetic input** — keystrokes, clicks, and mouse-wheel scroll injected
  into the focused app (Press / Hold / Toggle / Command action models).
- **Drives elevated (UAC) windows with no per-launch prompt** via a split architecture:
  a normal-integrity Electron renderer talks over a named pipe to a tiny signed C#
  **UIAccess** injector (`RadialDeckInput.exe`).
- **Touch & pen aware** — suppresses Windows' legacy touch→mouse promotion and pan/flick
  gestures so a finger-drag on a button doesn't scroll the app underneath; tracks global
  Raw Input to act where you last touched.
- **Trackpad widget** — relative cursor control with adjustable speed, pointer
  acceleration, scroll speed/acceleration, and multi-finger gestures.
- **Rich buttons** — sub-cell (¼-cell) grid sizing, custom colors, ~70 built-in icons or
  your own images (fit / fill / stretch / padded), and auto-rename from the bound key.
- **Edge-aware** — buttons bend into the work area (half/quarter pie, grid relocate) when
  the orb sits near a screen edge. DPI-correct on HiDPI/4K.
- **Non-activating overlay** — frameless, transparent, always-on-top, never steals focus.

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) (LTS) + npm
- .NET Framework (for `csc.exe`, used to compile the injector during packaging)

## Develop

```bash
npm install
npm start        # runs the overlay via electron .
```

## Package

```bash
npm run dist     # build/pack.js → @electron/packager + csc injector → dist/win-unpacked
```

To control elevated windows without a UAC prompt the packaged `RadialDeckInput.exe` must
be Authenticode-signed by a cert chaining to a trusted root and placed in a secure
location (Program Files). See `build/install-uiaccess.ps1`.

> The UIAccess installer imports a self-signed cert into the machine trust store and must
> be run by **you**, elevated — review it before running.

## Project layout

| Path | What |
|------|------|
| `src/main.js` | Electron main process — window, IPC, image picker |
| `src/overlay.js` / `overlay.html` / `overlay.css` | the floating overlay UI |
| `src/editor.js` / `editor.html` / `editor.css` | layout/button editor |
| `src/keyboard.js` | input dispatch → named-pipe injector |
| `src/touch.js` | Raw Input touch/pen tracking + gesture suppression |
| `src/icons.js` | shared built-in SVG icon set (`window.RDIcons`) |
| `src/store.js` | config load/save/migrate (`config.json` in userData) |
| `build/injector/RadialDeckInput.cs` | C# UIAccess input injector |
| `build/pack.js` | packager + injector build |
| `build/install-uiaccess.ps1` | sign + install to Program Files |

## License

MIT
