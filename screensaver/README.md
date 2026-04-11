# BirdWatchAI Screensaver

A Windows screensaver that displays the BirdWatchAI community gallery feed with beautiful transitions. Supports multi-monitor setups — each display runs its own independent slideshow.

## Features

- **Multi-monitor support** — one fullscreen slideshow per display
- **Transition effects** — Fade, Slide, Ken Burns, Blur, or Random
- **Live feed** — pulls photos from the BirdWatchAI community gallery via Supabase
- **Auto-refresh** — silently picks up new bird detections every 5 minutes
- **Configurable** — photo duration, transition style, sort order, caption visibility
- **Standard `.scr`** — installs like any Windows screensaver via Personalization settings

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (for building)
- Windows 10/11 (for installation)

## Development

```bash
# Install dependencies
cd screensaver
npm install

# Run in screensaver mode (fullscreen on all monitors)
npm start              # or: npm run start:screensaver

# Run in config mode (settings window)
npm run start:config

# Run in preview mode (small window)
npm run start:preview
```

### Command-line flags

| Flag | Mode | Description |
|------|------|-------------|
| `/s` | Screensaver | Run fullscreen slideshow (default) |
| `/c` | Configure | Open settings window |
| `/p` | Preview | Show small preview window |

## Building

```bash
npm run build
```

This produces a portable `.exe` in `dist/`, then automatically renames it to `.scr`.

## Installation

### Option A: Automated

Run `scripts/install.bat` as Administrator. It copies the `.scr` to `System32` and opens Screen Saver Settings.

### Option B: Manual

1. Build the project (`npm run build`)
2. Copy the `.scr` file from `dist/` to `C:\Windows\System32\`
3. Open **Settings > Personalization > Lock screen > Screen saver settings**
4. Select **BirdWatchAI Screensaver** from the dropdown
5. Click **Settings** to configure transition, duration, etc.
6. Click **Preview** to test, **OK** to apply

## Architecture

```
screensaver/
├── main.js           # Electron main process
│                     #   - Parses /s /c /p args
│                     #   - Spawns one BrowserWindow per display (/s mode)
│                     #   - Mouse/keyboard → app.quit()
│                     #   - Settings persistence (JSON in appData)
├── preload.js        # Secure IPC bridge (contextBridge)
├── slideshow.html    # Slideshow renderer page
├── slideshow.js      # Slideshow logic (adapted from community-social.js)
│                     #   - Fetches photos from Supabase REST API
│                     #   - Image preloading, dual-slot crossfade
│                     #   - Periodic refresh for new detections
├── slideshow.css     # Slideshow styles (adapted from community.css)
├── config.html       # Settings window UI
├── config.js         # Settings form logic
├── config.css        # Settings window styles
├── scripts/
│   ├── rename-to-scr.js  # Post-build: .exe → .scr rename
│   └── install.bat        # Admin installer script
└── package.json
```

## Multi-Monitor Behavior

When launched in screensaver mode (`/s`), the app:
1. Queries `screen.getAllDisplays()` to discover all connected monitors
2. Creates one frameless, fullscreen `BrowserWindow` per display
3. Each window runs its own independent slideshow (different random order)
4. Mouse movement beyond 10px or any keyboard input exits all windows

## Settings

Settings are stored in `%APPDATA%/birdwatchai-screensaver/screensaver-settings.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `transition` | `random` | Transition effect (fade/slide/kenburns/blur/random) |
| `interval` | `6000` | Milliseconds per photo |
| `sortMode` | `random` | Photo order (random/recent/count/alpha) |
| `showCaption` | `true` | Show species name and feeder overlay |
| `showProgress` | `true` | Show progress bar at bottom |
