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
    const tabId = message.tabId;
    const url = message.url;

    // Delegate HLS download to content script (has page cookies)
    handleStreamDownload(tabId, url).then((resp) => {
      sendResponse(resp);
    });
    return true;
  }

  if (message.action === 'downloadVideo') {
    const tabId = message.tabId;
    const url = message.url;
    const filename = message.filename || undefined;

    downloadWithFallback(url, filename, tabId)
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
// DOWNLOAD — 3 strategies, no forbidden headers
// =============================================
async function downloadWithFallback(url, filename, tabId) {
  // Strategy 1: chrome.downloads.download — simplest, works for public/CORS-friendly files
  const dlId = await tryDownload({ url, filename });
  if (dlId !== null) return;

  // Strategy 2: Content script fetches with page's cookies/session, triggers <a download>
  // This is the most reliable for auth-gated files (archive.org, CDNs with cookies)
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
  } catch {
    // Content script not available
  }

  // Strategy 3: Open URL in a new tab — user can right-click save
  chrome.tabs.create({ url, active: false });
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
// STREAM DOWNLOAD — fetch m3u8 segments and stitch
// =============================================
async function handleStreamDownload(tabId, url) {
  // Ensure content script is alive
  let alive = await pingContentScript(tabId);
  if (!alive) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      // Wait for script to initialize
      await new Promise((r) => setTimeout(r, 500));
      alive = await pingContentScript(tabId);
    } catch {
      return { ok: false, error: 'Cannot inject content script' };
    }
  }

  if (!alive) return { ok: false, error: 'Content script not responding' };

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'downloadHlsStream', url }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false });
      }
    });
  });
}
