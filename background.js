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
  // TS segments (HLS chunks)
  { regex: /\.ts(\?[^#]*)?(#.*)?$/i, type: 'TS Segment' },
];

// Store detected videos per tab: { tabId: Map<url, {url, type, timestamp, source}> }
const detectedVideos = new Map();

function classifyUrl(url) {
  for (const pattern of VIDEO_PATTERNS) {
    if (pattern.regex.test(url)) {
      return pattern.type;
    }
  }
  return null;
}

function addDetection(tabId, url, type, source) {
  if (!detectedVideos.has(tabId)) {
    detectedVideos.set(tabId, new Map());
  }

  const tabVideos = detectedVideos.get(tabId);

  // Skip tiny TS segments if we already have the parent M3U8
  if (type === 'TS Segment') {
    const hasParentStream = [...tabVideos.values()].some(
      (v) => v.type === 'HLS (M3U8)'
    );
    if (hasParentStream) return;
  }

  // Deduplicate by URL (strip trivial query param differences)
  const baseUrl = url.split('?')[0];
  const isDuplicate = [...tabVideos.keys()].some(
    (existing) => existing.split('?')[0] === baseUrl
  );
  if (isDuplicate) return;

  tabVideos.set(url, {
    url,
    type,
    timestamp: Date.now(),
    source,
    thumbnail: null,
  });

  updateBadge(tabId);
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
    if (details.tabId < 0) return; // ignore service worker requests

    const type = classifyUrl(details.url);
    if (type) {
      addDetection(details.tabId, details.url, type, 'network');
    }
  },
  { urls: ['<all_urls>'] }
);

// Also check response headers for content-type
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const contentType = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === 'content-type'
    );
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
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// --- Clean up when tab is closed or navigated ---
chrome.tabs.onRemoved.addListener((tabId) => {
  detectedVideos.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedVideos.delete(tabId);
    updateBadge(tabId);
  }
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
    // Store thumbnail if provided
    if (thumbnail) {
      const tabVideos = detectedVideos.get(sender.tab.id);
      const entry = tabVideos?.get(url);
      if (entry && !entry.thumbnail) {
        entry.thumbnail = thumbnail;
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'downloadVideo') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename || undefined,
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
