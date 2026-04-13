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

// Store detected videos per tab: { tabId: Map<url, {url, type, timestamp, source, thumbnail, size, isStream}> }
const detectedVideos = new Map();
// Store the page URL for each tab (used as referrer for downloads)
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
    size: null,       // file size in bytes (null = unknown)
    isStream: isStream(type),
  };

  tabVideos.set(url, entry);
  updateBadge(tabId);

  // For network-detected videos, ask content script for poster
  if (source === 'network') {
    chrome.tabs.sendMessage(tabId, { action: 'getPoster', url }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.poster) entry.thumbnail = response.poster;
    });
  }

  // For direct files, probe file size via HEAD request
  if (!entry.isStream) {
    probeFileSize(url).then((size) => {
      if (size !== null) entry.size = size;
    });
  }
}

// HEAD request to get Content-Length without downloading the file
async function probeFileSize(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD', mode: 'no-cors' });
    const cl = resp.headers.get('content-length');
    if (cl) return parseInt(cl, 10);

    // Some servers don't support HEAD, try range request for size
    const cr = resp.headers.get('content-range');
    if (cr) {
      const match = cr.match(/\/(\d+)$/);
      if (match) return parseInt(match[1], 10);
    }
  } catch {}
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

// Also check response headers for content-type + capture size
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

      // Try to grab Content-Length from this response
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
    const { url, type, source, thumbnail } = message;
    addDetection(sender.tab.id, url, type, source || 'dom');
    if (thumbnail) {
      const tabVideos = detectedVideos.get(sender.tab.id);
      const entry = tabVideos?.get(url);
      if (entry && !entry.thumbnail) entry.thumbnail = thumbnail;
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'downloadVideo') {
    const tabId = message.tabId;
    const pageUrl = tabPageUrls.get(tabId) || '';
    const url = message.url;
    const filename = message.filename || undefined;

    downloadWithFallback(url, filename, tabId, pageUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async sendResponse
  }

  if (message.action === 'rescanTab') {
    const tabId = message.tabId;
    handleRescan(tabId).then((result) => sendResponse(result));
    return true; // async sendResponse
  }

  if (message.action === 'clearVideos') {
    const tabId = message.tabId;
    detectedVideos.delete(tabId);
    updateBadge(tabId);
    sendResponse({ ok: true });
    return true;
  }
});

// --- Rescan logic with fallback injection ---
async function handleRescan(tabId) {
  // First check if we can even access this tab
  let tabUrl;
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab.url || '';
  } catch {
    return { ok: false, error: 'Tab not found' };
  }

  // Can't inject into chrome://, edge://, about:, extension pages, etc.
  if (
    !tabUrl.startsWith('http://') &&
    !tabUrl.startsWith('https://')
  ) {
    return { ok: false, error: 'Cannot scan this page type' };
  }

  // Step 1: Try to message the existing content script
  const alive = await pingContentScript(tabId);

  if (alive) {
    // Content script is running — tell it to rescan
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

  // Step 2: Content script not responding — inject it fresh
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

// --- Robust download with multiple fallback strategies ---
async function downloadWithFallback(url, filename, tabId, pageUrl) {
  // Strategy 1: Simple chrome.downloads (works for most direct files)
  const downloadId = await tryDownload({ url, filename });
  if (downloadId !== null) return;

  // Strategy 2: Fetch the file in background with proper referrer, then download the blob
  // This handles CDNs that need referrer/cookies
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: pageUrl ? { 'Referer': pageUrl } : {},
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    await tryDownload({ url: blobUrl, filename });
    // Clean up blob URL after a delay to allow download to start
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    return;
  } catch {}

  // Strategy 3: Use content script to fetch with page's cookies/session
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'fetchAndDownload',
      url,
      filename,
    });
    if (result?.ok) return;
  } catch {}

  // Strategy 4: Just open the URL in a new tab as last resort
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
