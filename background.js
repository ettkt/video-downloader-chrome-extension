// background.js — Service worker that intercepts network requests to detect video URLs

const VIDEO_PATTERNS = [
  // HLS
  { regex: /\.m3u8(\?[^#]*)?(#.*)?$/i, type: 'HLS (M3U8)' },
  { regex: /\/manifest\(format=m3u8/i, type: 'HLS (M3U8)' },
  { regex: /\.m3u8/i, type: 'HLS (M3U8)' },
  // DASH
  { regex: /\.mpd(\?[^#]*)?(#.*)?$/i, type: 'DASH (MPD)' },
  // MP4
  { regex: /\.mp4(\?[^#]*)?(#.*)?$/i, type: 'MP4' },
  // WebM
  { regex: /\.webm(\?[^#]*)?(#.*)?$/i, type: 'WebM' },
  // FLV
  { regex: /\.flv(\?[^#]*)?(#.*)?$/i, type: 'FLV' },
];

// URLs to ignore — common false positives
const IGNORE_PATTERNS = [
  /google-analytics\.com/i,
  /doubleclick\.net/i,
  /facebook\.com\/tr/i,
  /\.gif(\?|$)/i,
  /\.png(\?|$)/i,
  /\.jpg(\?|$)/i,
  /\.jpeg(\?|$)/i,
  /\.svg(\?|$)/i,
  /\.woff/i,
  /\.css(\?|$)/i,
  /beacon/i,
  /pixel/i,
  /tracker/i,
];

const detectedVideos = new Map();
const tabPageUrls = new Map();

function shouldIgnore(url) {
  return IGNORE_PATTERNS.some((p) => p.test(url));
}

function classifyUrl(url) {
  if (shouldIgnore(url)) return null;
  for (const pattern of VIDEO_PATTERNS) {
    if (pattern.regex.test(url)) {
      return pattern.type;
    }
  }
  return null;
}

function isStream(type) {
  return type === 'HLS (M3U8)' || type === 'DASH (MPD)';
}

function addDetection(tabId, url, type, source) {
  if (!detectedVideos.has(tabId)) {
    detectedVideos.set(tabId, new Map());
  }

  const tabVideos = detectedVideos.get(tabId);

  // Deduplicate by base URL
  const baseUrl = url.split('?')[0];
  const isDuplicate = [...tabVideos.keys()].some(
    (existing) => existing.split('?')[0] === baseUrl
  );
  if (isDuplicate) return;

  const entry = {
    url,
    type,
    timestamp: Date.now(),
    source,
    thumbnail: null,
    duration: null,
    size: null,
    isStream: isStream(type),
  };

  tabVideos.set(url, entry);
  updateBadge(tabId);

  // For network-detected videos, ask content script for poster + duration
  if (source === 'network') {
    chrome.tabs.sendMessage(tabId, { action: 'getVideoInfo', url }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.poster) entry.thumbnail = response.poster;
      if (response?.duration) entry.duration = response.duration;
    });
  }

  // For direct files, probe file size via HEAD request
  if (!entry.isStream) {
    probeFileSize(url).then((size) => {
      if (size !== null) entry.size = size;
    });
  }
}

// HEAD request to get Content-Length
// NOTE: mode must be 'cors' (default) to read headers. If CORS fails, we just return null.
async function probeFileSize(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD' });
    const cl = resp.headers.get('content-length');
    if (cl) return parseInt(cl, 10);
  } catch {
    // CORS or network error — that's fine, size just stays unknown
  }
  return null;
}

function updateBadge(tabId) {
  const tabVideos = detectedVideos.get(tabId);
  const count = tabVideos ? tabVideos.size : 0;

  chrome.action.setBadgeText({
    text: count > 0 ? String(count) : '',
    tabId,
  });
  chrome.action.setBadgeBackgroundColor({
    color: '#6C5CE7',
    tabId,
  });
}

// --- On install/update: inject content script into all existing http tabs ---
// This fixes the gap when extension reloads and pages already loaded have no content script
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url?.startsWith('http')) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
      } catch {
        // Some tabs can't be injected (e.g. chrome web store) — skip
      }
    }
  }
});

// --- Network request interception ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const type = classifyUrl(details.url);
    if (type) {
      addDetection(details.tabId, details.url, type, 'network');
    }
  },
  { urls: ['<all_urls>'] }
);

// Check response headers for content-type + capture size
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const headers = details.responseHeaders || [];
    const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type');
    if (!contentType?.value) return;

    const ct = contentType.value.toLowerCase();
    let type = null;

    if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) {
      type = 'HLS (M3U8)';
    } else if (ct.includes('dash+xml')) {
      type = 'DASH (MPD)';
    } else if (ct === 'video/mp4') {
      type = 'MP4';
    } else if (ct === 'video/webm') {
      type = 'WebM';
    }

    if (type) {
      addDetection(details.tabId, details.url, type, 'network');

      // Grab Content-Length from this response
      const cl = headers.find((h) => h.name.toLowerCase() === 'content-length');
      if (cl?.value) {
        const tabVideos = detectedVideos.get(details.tabId);
        const entry = tabVideos?.get(details.url);
        if (entry && !entry.size && !entry.isStream) {
          entry.size = parseInt(cl.value, 10);
        }
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// --- Track page URLs for referrer ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    detectedVideos.delete(tabId);
    updateBadge(tabId);
  }
  if (tab.url) {
    tabPageUrls.set(tabId, tab.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedVideos.delete(tabId);
  tabPageUrls.delete(tabId);
});

// --- Messaging ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getVideos') {
    const tabId = message.tabId;
    const tabVideos = detectedVideos.get(tabId);
    const videos = tabVideos ? [...tabVideos.values()] : [];
    sendResponse({ videos });
    return true;
  }

  if (message.action === 'videoFound' && sender.tab) {
    const { url, type, source, thumbnail, duration } = message;
    addDetection(sender.tab.id, url, type, source || 'dom');
    const tabVideos = detectedVideos.get(sender.tab.id);
    const entry = tabVideos?.get(url);
    if (entry) {
      if (thumbnail && !entry.thumbnail) entry.thumbnail = thumbnail;
      if (duration && !entry.duration) entry.duration = duration;
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'downloadStream') {
    handleStreamDownload(message.tabId, message.url).then((resp) => {
      sendResponse(resp);
    });
    return true;
  }

  if (message.action === 'getDownloadProgress') {
    const progress = activeDownloads.get(message.tabId);
    sendResponse(progress || null);
    return true;
  }

  if (message.action === 'downloadVideo') {
    downloadWithFallback(message.url, message.filename, message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.action === 'rescanTab') {
    const tabId = message.tabId;
    handleRescan(tabId).then((result) => sendResponse(result));
    return true;
  }

  if (message.action === 'clearVideos') {
    const tabId = message.tabId;
    detectedVideos.delete(tabId);
    updateBadge(tabId);
    sendResponse({ ok: true });
    return true;
  }
});

// =============================================
// DOWNLOAD — robust multi-strategy for direct files
// =============================================
async function downloadWithFallback(url, filename, tabId) {
  // Strategy 1: chrome.downloads.download — most reliable, uses Chrome's
  // own network stack (handles cookies, redirects, large files natively)
  const dlId = await tryDownload({ url, filename, conflictAction: 'uniquify' });
  if (dlId !== null) {
    // Verify download didn't immediately fail
    const ok = await verifyDownloadStarted(dlId);
    if (ok) return;
  }

  // Strategy 2: Content script fetches with page's cookies/session
  try {
    const alive = await pingContentScript(tabId);
    if (alive) {
      const result = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'fetchAndDownload', url, filename }, (resp) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      });
      if (result?.ok) return;
    }
  } catch {}

  // Strategy 3: Background fetch → blob → chrome.downloads
  try {
    const resp = await fetchWithTimeout(url, 60000);
    const blob = new Blob([resp]);
    const blobUrl = URL.createObjectURL(blob);
    const dlId2 = await tryDownload({ url: blobUrl, filename, conflictAction: 'uniquify' });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    if (dlId2 !== null) return;
  } catch {}

  // Strategy 4: Open in new tab as last resort
  chrome.tabs.create({ url, active: true });
}

function tryDownload(options) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.download(options, (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          resolve(null);
        } else {
          resolve(downloadId);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

// Check that a download didn't fail within the first 2 seconds
function verifyDownloadStarted(dlId) {
  return new Promise((resolve) => {
    setTimeout(() => {
      chrome.downloads.search({ id: dlId }, (results) => {
        if (chrome.runtime.lastError || !results || results.length === 0) {
          resolve(false);
          return;
        }
        const state = results[0].state;
        // 'in_progress' or 'complete' = good; 'interrupted' = bad
        resolve(state !== 'interrupted');
      });
    }, 1500);
  });
}

// =============================================
// RESCAN — ping → message, or inject fresh
// =============================================
async function handleRescan(tabId) {
  let tabUrl;
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab.url || '';
  } catch {
    return { ok: false, error: 'Tab not found' };
  }

  // Can't inject into non-http pages
  if (!tabUrl.startsWith('http://') && !tabUrl.startsWith('https://')) {
    return { ok: false, error: 'Cannot scan this page type' };
  }

  // Try messaging existing content script
  const alive = await pingContentScript(tabId);

  if (alive) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'rescan' }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: 'Message failed' });
        } else {
          resolve({ ok: true, method: 'message' });
        }
      });
    });
  }

  // Content script dead — inject fresh
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    return { ok: true, method: 'injected' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function pingContentScript(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 500);
    try {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError || !response) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch {
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

// =============================================
// STREAM DOWNLOAD — runs entirely in background
// Fetches m3u8 playlist, resolves segments,
// downloads with retry+timeout, stitches, saves
// =============================================

// Active downloads — keyed by tabId so popup can poll progress
const activeDownloads = new Map();

async function handleStreamDownload(tabId, url) {
  // Prevent double-download of same stream
  if (activeDownloads.has(tabId)) {
    const existing = activeDownloads.get(tabId);
    if (existing.url === url && existing.state === 'downloading') {
      return { ok: true, message: 'Already downloading' };
    }
  }

  const progress = { url, state: 'downloading', percent: 0, error: null, segsDone: 0, segsTotal: 0 };
  activeDownloads.set(tabId, progress);

  try {
    // 1. Fetch and resolve the media playlist (handles master → variant)
    const { segments, baseUrl } = await resolveHlsSegments(url);
    if (!segments || segments.length === 0) {
      throw new Error('No segments found in playlist');
    }

    progress.segsTotal = segments.length;

    // 2. Download all segments with concurrency pool + retry
    const CONCURRENCY = 10;
    const RETRIES = 3;
    const TIMEOUT_MS = 30000;
    const chunks = new Array(segments.length);
    let nextIdx = 0;
    let failures = 0;

    async function worker() {
      while (nextIdx < segments.length) {
        const idx = nextIdx++;
        const segUrl = segments[idx];
        let lastErr = null;

        for (let attempt = 0; attempt < RETRIES; attempt++) {
          try {
            const buf = await fetchWithTimeout(segUrl, TIMEOUT_MS);
            chunks[idx] = buf;
            progress.segsDone++;
            progress.percent = Math.round((progress.segsDone / progress.segsTotal) * 100);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            // Exponential backoff: 500ms, 1500ms, 3500ms
            if (attempt < RETRIES - 1) {
              await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
            }
          }
        }

        if (lastErr) {
          failures++;
          // Allow up to 5% segment failures — fill with empty buffer
          if (failures > Math.max(3, segments.length * 0.05)) {
            throw new Error(`Too many failed segments (${failures}/${segments.length})`);
          }
          chunks[idx] = new ArrayBuffer(0);
          progress.segsDone++;
          progress.percent = Math.round((progress.segsDone / progress.segsTotal) * 100);
        }
      }
    }

    // Launch worker pool
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, segments.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // 3. Stitch segments into a single blob and trigger download
    const blob = new Blob(chunks.filter(Boolean), { type: 'video/mp2t' });
    const blobUrl = URL.createObjectURL(blob);

    // Guess filename from URL
    let filename = 'video.ts';
    try {
      const pathname = new URL(url).pathname;
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        const base = parts[parts.length - 1].replace(/\.m3u8.*$/, '');
        if (base) filename = base + '.ts';
      }
    } catch {}

    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url: blobUrl, filename }, (dlId) => {
        if (chrome.runtime.lastError || !dlId) {
          // Fallback: have content script do the <a download> click
          triggerBlobDownloadInTab(tabId, blobUrl, filename)
            .then(resolve)
            .catch(reject);
        } else {
          resolve(dlId);
        }
      });
    });

    progress.state = 'done';
    progress.percent = 100;

    // Clean up after a delay
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      activeDownloads.delete(tabId);
    }, 30000);

    return { ok: true, segments: segments.length, failures };

  } catch (e) {
    progress.state = 'error';
    progress.error = e.message;
    setTimeout(() => activeDownloads.delete(tabId), 10000);
    return { ok: false, error: e.message };
  }
}

// Fetch with AbortController timeout
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

// Resolve m3u8 → list of absolute segment URLs
// Handles master playlists (picks highest bandwidth variant)
async function resolveHlsSegments(m3u8Url, depth = 0) {
  if (depth > 5) throw new Error('Too many playlist redirects');

  const resp = await fetchWithTimeout(m3u8Url, 15000);
  const text = new TextDecoder().decode(resp);
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Check if this is a master playlist
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      // Find next non-comment line
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) {
          variants.push({ url: lines[j], bandwidth: bw });
          break;
        }
      }
    }
  }

  if (variants.length > 0) {
    // Pick highest bandwidth
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const bestUrl = hlsResolveUrl(variants[0].url, baseUrl, m3u8Url);
    return resolveHlsSegments(bestUrl, depth + 1);
  }

  // Media playlist — extract segment URLs
  const segments = [];
  for (const line of lines) {
    if (!line.startsWith('#')) {
      segments.push(hlsResolveUrl(line, baseUrl, m3u8Url));
    }
  }

  return { segments, baseUrl };
}

function hlsResolveUrl(url, baseUrl, originalUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) {
    try { return new URL(originalUrl).origin + url; } catch {}
  }
  return baseUrl + url;
}

// Ask content script to trigger a blob download via <a> click
async function triggerBlobDownloadInTab(tabId, blobUrl, filename) {
  const alive = await pingContentScript(tabId);
  if (!alive) return;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'triggerDownload', blobUrl, filename }, () => {
      resolve();
    });
  });
}
