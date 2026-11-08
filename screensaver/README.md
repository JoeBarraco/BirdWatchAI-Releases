# BirdWatchAI Community Feed

A Windows screensaver that displays the BirdWatchAI community gallery feed with
beautiful transitions. Supports multi-monitor setups — each display runs its own
independent slideshow.

(Formerly "BirdWatchAI Screensaver". The installer removes the old install when
it finds one, and your existing settings carry over.)

## Features

- **Multi-monitor support** — one fullscreen slideshow per display
- **Transition effects** — Fade, Slide, Ken Burns, Blur, or Random
- **Live feed** — pulls photos from the BirdWatchAI community gallery via Supabase
- **Private communities** — sign in and the slideshow includes every feeder your
  community account can see, not just the public ones
- **Never blank** — if the chosen photo age has nothing in it, the feed falls back
  to the most recent day/week/month that does, and says which
- **Offline-tolerant** — photos are cached on disk, so a dropped connection or a
  cold boot still has something to show
- **Auto-refresh** — silently picks up new bird detections (every 5 minutes by default)
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

# Run the real slideshow in an ordinary window — the best way to check a change
# without blacking out every monitor and quitting on the first mouse twitch
npm run start:preview
```

### Command-line flags

| Flag | Mode | Description |
|------|------|-------------|
| `/s` | Screensaver | Run fullscreen slideshow |
| `/c` | Configure | Open settings window (default when double-clicked) |
| `/p` | Preview | Windows' settings-dialog thumbnail; exits immediately (see below) |
| `--preview` | Dev preview | The slideshow in a normal 1100×700 window |

Windows passes `/p:<hwnd>` to draw a live preview inside the tiny monitor graphic
in Screen Saver Settings. Embedding there needs Win32 `SetParent`, which Electron
does not expose, so that mode exits cleanly rather than opening a stray window.
`--preview` is the developer equivalent and is never passed by Windows.

## Building

```bash
npm run build
```

This produces an unpacked Electron build in `dist/win-unpacked/`, then renames the
`.exe` to `.scr`.

```bash
scripts\package.bat
```

Wraps that build plus the installer scripts into
`dist\BirdWatchAI_Community_Feed_<version>.zip`, ready to upload to GitHub Releases.
Keep the version in `package.json`, `scripts\package.bat` and `scripts\Launcher.cs`
in step.

## Installation

### Install

Run `scripts\install.bat` as Administrator. It will:
1. Clean up any old `.scr` entries from System32, and any pre-1.1 install
2. Copy the build to `%ProgramFiles%\BirdWatchAI Community Feed\`
3. Compile and install a small launcher stub so the screensaver appears in the dropdown
4. Register the real path in the registry
5. Open Screen Saver Settings so you can set your wait time

### Uninstall

Run `scripts\uninstall.bat` to remove the screensaver, registry entries, and installed files.

## Architecture

The feed lives in the **main process**. It used to live in the renderer, which
meant an N-monitor setup ran N independent copies of everything: N REST queries
on launch, N more on every refresh, and N downloads of each photo. One fetch,
broadcast to every window, is lighter on the community backend — and it gives the
access token and the image cache exactly one home.

```
screensaver/
├── main.js           # Electron main process
│                     #   - Parses /s /c /p --preview args
│                     #   - Spawns one BrowserWindow per display (/s mode)
│                     #   - Loads the feed once, broadcasts to every window
│                     #   - Mouse/keyboard → app.quit()
│                     #   - Settings persistence (JSON in appData)
├── preload.js        # Secure IPC bridge (contextBridge). Deliberately exposes
│                     # no access token to the renderer.
├── lib/
│   ├── supabase.js   # URL + publishable anon key
│   ├── auth.js       # Community account sign-in (email one-time code),
│   │                 # token refresh, credential storage
│   ├── feed.js       # Query building, photo-age fallback, private-media
│   │                 # signing, feed disk cache
│   └── imagecache.js # LRU on-disk photo cache
├── slideshow.html    # Slideshow renderer page
├── slideshow.js      # Ordering and transitions only — no network access
├── slideshow.css     # Slideshow styles (adapted from community.css)
├── config.html       # Settings window UI
├── config.js         # Settings form logic
├── config.css        # Settings window styles
├── scripts/
│   ├── rename-to-scr.js   # Post-build: .exe → .scr rename
│   ├── install.bat        # Installer (from a source build)
│   ├── install-dist.bat   # Installer (shipped inside the ZIP as install.bat)
│   ├── uninstall.bat      # Uninstaller
│   ├── package.bat        # Builds the distributable ZIP
│   └── Launcher.cs        # System32 stub that forwards args to the real .scr
└── package.json
```

> **Note:** the package `name` is still `birdwatchai-screensaver` even though the
> product is now "BirdWatchAI Community Feed". `name` is what Electron derives
> `app.getPath('userData')` from, so changing it would strand every existing
> install's settings. The display name comes from `build.productName`.

## Multi-Monitor Behavior

When launched in screensaver mode (`/s`), the app:
1. Queries `screen.getAllDisplays()` to discover all connected monitors
2. Creates one frameless, fullscreen `BrowserWindow` per display
3. Loads the feed once and sends it to every window; each window shuffles its own
   copy, so a video wall isn't showing the same bird four times
4. Mouse movement beyond 15px or any keyboard input exits all windows

## Private communities

Detections are gated server-side by row-level security:

```sql
community_feeder_is_public(feeder_id) or community_user_sees_feeder(feeder_id, auth.uid())
```

So the screensaver does not filter private feeders in or out itself. It sends the
signed-in member's access token with the same query, and the server widens the
result to every feeder that member can see. Signed out, it sees exactly what an
anonymous visitor to the community site sees.

Community accounts are magic-link only — there is no password. A settings dialog
cannot receive a browser redirect, so sign-in here uses the one-time-code half of
the same flow: Settings emails you a code, you type it in. If your Supabase email
template only renders a button and no code, paste the whole link instead — both
are accepted.

Photos belonging to a private feeder live in a non-public bucket and arrive as
`private://bucket/path` markers, which are exchanged for short-lived signed URLs.
Signing out clears the photo cache, so private photos don't stay readable on a
shared machine.

## Settings

Settings are stored in `%APPDATA%/birdwatchai-screensaver/screensaver-settings.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `transition` | `random` | Transition effect (fade/slide/kenburns/blur/random) |
| `interval` | `6000` | Milliseconds per photo |
| `sortMode` | `random` | Photo order (random/recent/count/alpha) |
| `photoAge` | `all` | Age of photos to show (all/today/week/month/year) |
| `feeders` | `[]` | Feeders to show photos from (empty array = all feeders) |
| `showCaption` | `true` | Show species name and feeder overlay |
| `showProgress` | `true` | Show progress bar at bottom |
| `refreshMinutes` | `5` | How often to look for new detections |
| `cacheMB` | `512` | On-disk photo cache budget |

The session for a signed-in community account is kept separately in `auth.json`
in the same folder, and the photo cache in `image-cache/`. The refresh token is
long-lived, so `auth.json` is encrypted with Electron's `safeStorage` — DPAPI on
Windows, tied to the logged-in account. (Node's `mode: 0600` is essentially
ignored on Windows, so file permissions alone would protect nothing.)

The **Feeders** list in the settings window is populated live from the community
gallery, so it always reflects the feeders that currently have photos — including
private ones once you are signed in. Leaving every feeder checked stores an empty
list, which means "all feeders", so any feeders added later are included
automatically.

### Photo-age fallback

Picking "Today" used to mean a blank screen on a quiet morning. Now, when the
selected window turns up nothing, the feed backs up to the most recent window of
the same size that does have photos, and the caption bar says so:

> *No photos today — showing Saturday, November 7*

Weeks start on Monday, matching "This Week" on the community site.
