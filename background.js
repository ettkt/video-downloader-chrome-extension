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

    chrome.downloads.download({
      url: message.url,
      filename: message.filename || undefined,
      // Pass the page URL as referrer — many CDNs require this
      headers: pageUrl ? [{ name: 'Referer', value: pageUrl }] : undefined,
    });
    sendResponse({ ok: true });
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
