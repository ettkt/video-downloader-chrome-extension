# Privacy Policy — Video & M3U8 Detector

**Last updated:** April 2026

## Data Collection

This extension collects **no personal data whatsoever**.

- No analytics or tracking scripts
- No telemetry or usage metrics
- No user accounts or authentication
- No cookies set by the extension
- No data sent to any external server

## How It Works

The extension operates entirely locally on your device:

1. **Video detection** — Monitors network requests within your browser to identify video stream URLs (M3U8, MP4, etc.). This data stays in your browser's memory and is never transmitted anywhere.

2. **Downloads** — When you choose to download a stream, the extension fetches video segments directly from the source server (the same server your browser was already streaming from). No proxy, no intermediary.

3. **Storage** — Download progress is saved to your browser's local storage (IndexedDB) so downloads can resume if interrupted. This data is only accessible to the extension and is automatically cleaned up.

## Permissions Explained

- **webRequest** — To detect video URLs in network traffic (read-only, does not modify requests)
- **activeTab** — To interact with the current tab for video scanning
- **storage** — To persist download state locally
- **downloads** — To save downloaded video files to your computer
- **scripting** — To inject the video scanner into web pages
- **alarms** — To keep downloads alive in the background
- **host_permissions (<all_urls>)** — Required to detect videos on any website and fetch video segments from any CDN

## Third-Party Libraries

- **mux.js** (Apache-2.0) — Used locally for TS-to-MP4 remuxing. No network requests are made by this library.

## Contact

For questions about this policy, open an issue on the GitHub repository.
