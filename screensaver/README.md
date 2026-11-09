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
- **Video clips** — mixes the detection clips in with the stills, always silent
- **Clock** — current time and date, in the one corner the burned-in overlays
  leave free, with the feeder's logo above it when it has one
- **Update check** — notices when a newer release exists instead of going stale
- **Auto-refresh** — silently picks up new bird detections (every 5 minutes by default)
- **Configurable** — photo duration, transition style, sort order, caption visibility
- **Standard `.scr`** — installs like any Windows screensaver via Personalization settings,
  with a live preview in the settings dialog's monitor thumbnail

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
| `/p:<hwnd>` | Preview | Live thumbnail inside Screen Saver Settings |
| `--preview` | Dev preview | The slideshow in a normal 1100×700 window |

Windows passes `/p:<hwnd>` to draw a live preview inside the tiny monitor graphic
in Screen Saver Settings. Rendering there means making our window a Win32 *child*
of a HWND we did not create, which Electron has no API for — `setParentWindow()`
only accepts another `BrowserWindow`. `lib/winpreview.js` does it through koffi:
`SetParent`, then swapping `WS_POPUP` for `WS_CHILD` so the window clips to and
moves with the host, then `MoveWindow` to fill it.

If any step fails — koffi missing, a bad handle, a refused reparent — the app
quits cleanly instead of showing the window. A dead thumbnail is a cosmetic
disappointment; a stray fullscreen window pinned over the settings dialog is a
bug. The preview also polls `IsWindow` on the host, because the dialog never says
"stop", it just destroys the window.

`--preview` is the developer equivalent, never passed by Windows, and it forwards
the renderer's console to the terminal.

## Building

```bash
npm run build
```

This produces an unpacked Electron build in `dist/win-unpacked/`, then renames the
`.exe` to `.scr`. Build settings live in `electron-builder.config.js` rather than
package.json's `build` field, because signing has to be conditional — see below.

> **Never edit `scripts/*.bat` with MSYS/Git-Bash `sed -i`.** It rewrites the file
> with LF-only line endings, and `cmd.exe` then mis-parses it in a way that looks
> like anything but a line-ending problem: the first few `set` statements take, the
> rest come back **empty**, and you get `Invalid drive specification`, `Access is
> denied`, and finally `Compress-Archive -Path '' -DestinationPath '\'`. The script
> appears to run — it prints `[1/5] … Done.` — while writing nothing.
>
> It is doubly confusing to diagnose, because Git-Bash's own `od`, `grep` and `file`
> translate line endings as they read, so they will happily tell you a CRLF file is
> LF and vice versa. Check and repair from PowerShell, which sees the real bytes:
>
> ```powershell
> # inspect
> (Get-Content -Raw -Encoding Byte scripts\package.bat)[0..9]
> # repair: add CR before any bare LF
> $p='scripts\package.bat'; $i=[IO.File]::ReadAllBytes($p); $o=[Collections.Generic.List[byte]]::new()
> for($n=0;$n -lt $i.Length;$n++){ if($i[$n] -eq 10 -and ($n -eq 0 -or $i[$n-1] -ne 13)){$o.Add(13)}; $o.Add($i[$n]) }
> [IO.File]::WriteAllBytes($p,$o.ToArray())
> ```
>
> `.gitattributes` pins `eol=crlf` for `.bat`/`.cmd`/`.ps1`/`.cs`, which fixes what a
> *checkout* produces — it cannot stop a local tool from rewriting the file in place.

```bash
scripts\package.bat
```

Wraps that build plus the installer scripts into
`dist\BirdWatchAI_Community_Feed_<version>.zip`, ready to upload to GitHub Releases.
Keep the version in `package.json`, `scripts\package.bat` and `scripts\Launcher.cs`
in step.

Packaging also compiles the System32 launcher stub from `Launcher.cs` and ships the
binary. It used to be compiled on the user's machine at install time, which meant it
could never carry a signature; `install.bat` still compiles one as a fallback if the
package does not contain it.

## Code signing

Neither the `.scr` nor the launcher is signed by default, so Windows SmartScreen
will warn on first run. Signing is opt-in through the environment — set one of
these and both `npm run build` and `scripts\package.bat` will sign:

| Variable | Use |
|----------|-----|
| `CSC_LINK` + `CSC_KEY_PASSWORD` | Path to a `.pfx` and its password |
| `BWAI_CERT_SHA1` | Thumbprint of a certificate in the Windows store |
| `BWAI_CERT_SUBJECT` | Subject name of a certificate in the Windows store |
| `BWAI_TIMESTAMP_URL` | Timestamp server (defaults to DigiCert's) |

The two store options exist for an EV certificate on a hardware token, whose
private key cannot be exported to a `.pfx` file.

```bash
set CSC_LINK=C:\certs\birdwatchai.pfx
set CSC_KEY_PASSWORD=...
npm run build && scripts\package.bat
```

With none of them set the build prints `no certificate configured` and produces
exactly what it produced before — this is wiring, not a certificate. An OV
certificate needs a few days of vetting; an EV one builds SmartScreen reputation
immediately but needs a hardware token. `signAndEditExecutable` is tied to the
same switch, because with no certificate there is nothing to sign and rcedit's
resource editing needs a toolchain not worth requiring locally.

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
│   ├── imagecache.js # LRU on-disk photo cache
│   ├── update.js     # Once-a-day check for a newer *-screensaver release
│   └── winpreview.js # Win32 reparenting for the settings-dialog thumbnail
├── electron-builder.config.js  # Build + conditional code signing
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
│   ├── sign.ps1           # Authenticode signing for the launcher stub
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
| `showClock` | `true` | Clock and date panel (lower right) |
| `playClips` | `true` | Mix video clips in with the stills |
| `clipEvery` | `5` | Play a clip after every N photos; `0` = clips only, no stills |
| `clipSeconds` | `12` | Give up on a clip after this long |
| `checkUpdates` | `true` | Check once a day for a newer release |

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

## Clips

Detections carry a `video_url` as well as a still, and most of them have one. A
clip plays after every `clipEvery` photos — the next upcoming detection that
actually has one, since the list is shuffled and most positions will not.

`clipEvery = 0` is not "never" but **clips only**: every item is a clip and the
stills are skipped entirely. Switching clips off is the `playClips` box, so the
value was free to mean something more useful. Clips-only still falls back to
stills when the chosen photo age contains no video at all — a day nobody
recorded on should look like a slideshow, not a blank screen.

Clips are **streamed, not cached**. A few seconds of 1080p dwarfs a still, and
caching them would evict every photo in the budget; it also means clips are the
one thing that does not work offline. They are always muted, in markup and again
in code: a screensaver that starts making noise at 2am is a bug, not a feature.

Every failure path — a dead signed URL, an undecodable file, a truncated upload,
a clip that simply runs long — lands on the same handler, which returns to the
stills. The maximum length is a cap, not a target.

There is one extra guard for clips-only. Normally a failed clip is followed by a
still, and the slide timer puts a gap in; with stills skipped there is no such
gap, so a feed whose only clip is broken would retry as fast as the network
could fail. A clip that ends in under 1.2 s never rendered a frame, so three of
those in a row forces one still through and the timer paces it. A clip that
actually plays resets the count.

## Clock

Lower right, and not subject to the idle fade that hides the caption bar: a clock
you cannot see is not a clock. That corner is the only one free — the server
burns a timestamp into the top left of every photo, a watermark into the top
right, and the species caption into the bottom left.

It is labelled "Current Time" because the photo underneath carries its own
timestamp, and two unlabelled clocks on one screen invites reading the wrong one.

A feeder that has uploaded a logo gets it at the top of this panel, above the
label. It is bounded in both directions (150×52 px) because feeders upload
whatever they have and the clock underneath has to stay the same size whether
the logo is a wide wordmark or a tall crest. A logo that fails to load is
hidden rather than left as a broken image — this runs unattended for months,
and a feeder can replace or delete its logo at any time.

Nothing else about the detection goes in this panel. The temperature recorded with
the photo used to, which placed a reading from hours or days earlier directly
under the words "Current Time" — exactly the confusion the label is there to
prevent. It is gone rather than moved: the server already burns it into the
photo, bottom left, next to the confidence, the detection time and the rarity.
Drawing it again added nothing and only created a number that could be read as
the current conditions.

## Updates

`lib/update.js` asks GitHub once a day for the newest release whose tag ends in
`-screensaver`, which is how the server app and the Finder releases in the same
repository are ignored. When one is newer than the running build, the slideshow
says so in the corner panel and Settings offers a download link.

The answer is cached for 24 hours because the unauthenticated GitHub API allows
60 requests an hour per IP and a screensaver can start many times a day. A failed
check keeps the previous answer rather than claiming "up to date".
