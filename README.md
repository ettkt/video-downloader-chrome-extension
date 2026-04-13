# Video & M3U8 Detector — Chrome Extension

A free, lightweight Chrome extension that **automatically detects video streams** (M3U8/HLS, DASH/MPD, MP4, WebM, FLV) on any website — **without needing to play the video**.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-6C5CE7?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-Extension-blue?style=flat-square)

## Features

- **Passive detection** — finds video URLs without clicking play or interacting with the page
- **Network interception** — monitors HTTP requests for video content types and file extensions
- **DOM scanning** — inspects `<video>`, `<source>`, `<embed>`, `<object>` elements and inline scripts
- **Live mutation observer** — catches dynamically injected video elements in SPAs
- **Content-type analysis** — detects streams from response headers (e.g. `application/x-mpegURL`)
- **One-click copy** — copy any detected URL to clipboard instantly
- **Clean, modern UI** — color-coded badges per format, sorted by priority (HLS > DASH > MP4 > ...)
- **Zero dependencies** — pure vanilla JS, no frameworks, no build step
- **Manifest V3** — uses the latest Chrome extension platform
- **Completely free** — no accounts, no limits, no tracking

## Supported Formats

| Format | Extensions / Signatures |
|--------|------------------------|
| HLS    | `.m3u8`, `application/x-mpegURL` |
| DASH   | `.mpd`, `application/dash+xml` |
| MP4    | `.mp4`, `video/mp4` |
| WebM   | `.webm`, `video/webm` |
| FLV    | `.flv` |
| TS     | `.ts` (HLS segments) |

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon appears in your toolbar — browse any site and it auto-detects videos

## How It Works

```
┌─────────────────────────────────────────────┐
│  Background Service Worker                  │
│  ├─ webRequest.onBeforeRequest  (URL match) │
│  └─ webRequest.onHeadersReceived (MIME)     │
├─────────────────────────────────────────────┤
│  Content Script                             │
│  ├─ DOM scan (video/source/embed/object)    │
│  ├─ Inline script regex scan                │
│  ├─ Data-attribute scan                     │
│  └─ MutationObserver (live updates)         │
├─────────────────────────────────────────────┤
│  Popup UI                                   │
│  ├─ Sorted video list with type badges      │
│  ├─ Copy URL / Open in new tab              │
│  └─ Clear detections                        │
└─────────────────────────────────────────────┘
```

## Project Structure

```
├── manifest.json      # Extension manifest (V3)
├── background.js      # Service worker — network interception
├── content.js         # Content script — DOM scanning
├── popup.html         # Popup markup
├── popup.css          # Popup styles
├── popup.js           # Popup logic
└── icons/             # Extension icons (16/32/48/128px)
```

## License

MIT — free to use, modify, and distribute.
