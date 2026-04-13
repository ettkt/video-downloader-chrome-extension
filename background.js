// background.js — Service worker: network interception, detection, downloads

const VIDEO_PATTERNS = [
  { regex: /\.m3u8(\?[^#]*)?(#.*)?$/i, type: 'HLS (M3U8)' },
  { regex: /\/manifest\(format=m3u8/i, type: 'HLS (M3U8)' },
  { regex: /\.m3u8/i, type: 'HLS (M3U8)' },
  { regex: /\.mpd(\?[^#]*)?(#.*)?$/i, type: 'DASH (MPD)' },
  { regex: /\.mp4(\?[^#]*)?(#.*)?$/i, type: 'MP4' },
  { regex: /\.webm(\?[^#]*)?(#.*)?$/i, type: 'WebM' },
  { regex: /\.flv(\?[^#]*)?(#.*)?$/i, type: 'FLV' },
];

const IGNORE_PATTERNS = [
  /google-analytics\.com/i, /doubleclick\.net/i, /facebook\.com\/tr/i,
  /\.gif(\?|$)/i, /\.png(\?|$)/i, /\.jpg(\?|$)/i, /\.jpeg(\?|$)/i,
  /\.svg(\?|$)/i, /\.woff/i, /\.css(\?|$)/i, /beacon/i, /pixel/i, /tracker/i,
];

const detectedVideos = new Map();  // tabId → Map<url, entry>

function shouldIgnore(url) {
  return IGNORE_PATTERNS.some((p) => p.test(url));
}

function classifyUrl(url) {
  if (shouldIgnore(url)) return null;
  for (const p of VIDEO_PATTERNS) {
    if (p.regex.test(url)) return p.type;
  }
  return null;
}

function isStream(type) {
  return type === 'HLS (M3U8)' || type === 'DASH (MPD)';
}

function addDetection(tabId, url, type, source) {
  if (!detectedVideos.has(tabId)) detectedVideos.set(tabId, new Map());
  const tabVideos = detectedVideos.get(tabId);

  const baseUrl = url.split('?')[0];
  const isDup = [...tabVideos.keys()].some((k) => k.split('?')[0] === baseUrl);
  if (isDup) return;

  const entry = {
    url, type, timestamp: Date.now(), source,
    thumbnail: null, duration: null, size: null,
    isStream: isStream(type),
  };
  tabVideos.set(url, entry);
  updateBadge(tabId);

  if (source === 'network') {
    chrome.tabs.sendMessage(tabId, { action: 'getVideoInfo', url }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp?.poster) entry.thumbnail = resp.poster;
      if (resp?.duration) entry.duration = resp.duration;
    });
  }

  if (!entry.isStream) {
    fetch(url, { method: 'HEAD' }).then((r) => {
      const cl = r.headers.get('content-length');
      if (cl) entry.size = parseInt(cl, 10);
    }).catch(() => {});
  }
}

function updateBadge(tabId) {
  const tabVideos = detectedVideos.get(tabId);
  const count = tabVideos ? tabVideos.size : 0;
  // Don't overwrite a download-in-progress badge
  const dl = [...activeDownloads.values()].find((d) => d.tabId === tabId && d.state === 'downloading');
  if (dl) return;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#6C5CE7', tabId });
}

// --- Inject content script on install/reload ---
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.url?.startsWith('http')) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch {}
    }
  }
});

// --- Network interception ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const type = classifyUrl(details.url);
    if (type) addDetection(details.tabId, details.url, type, 'network');
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = details.responseHeaders || [];
    const ct = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value?.toLowerCase();
    if (!ct) return;

    let type = null;
    if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) type = 'HLS (M3U8)';
    else if (ct.includes('dash+xml')) type = 'DASH (MPD)';
    else if (ct === 'video/mp4') type = 'MP4';
    else if (ct === 'video/webm') type = 'WebM';

    if (type) {
      addDetection(details.tabId, details.url, type, 'network');
      const cl = headers.find((h) => h.name.toLowerCase() === 'content-length');
      if (cl?.value) {
        const tabVideos = detectedVideos.get(details.tabId);
        const entry = tabVideos?.get(details.url);
        if (entry && !entry.size && !entry.isStream) entry.size = parseInt(cl.value, 10);
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// --- Tab lifecycle ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedVideos.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedVideos.delete(tabId);
  // Clean up downloads for this tab
  for (const [url, dl] of activeDownloads) {
    if (dl.tabId === tabId && dl.state !== 'downloading') {
      activeDownloads.delete(url);
    }
  }
});

// =============================================
// MESSAGING
// =============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'getVideos': {
      const tabVideos = detectedVideos.get(message.tabId);
      sendResponse({ videos: tabVideos ? [...tabVideos.values()] : [] });
      return true;
    }

    case 'videoFound': {
      if (!sender.tab) break;
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

    case 'downloadStream': {
      handleStreamDownload(message.tabId, message.url).then(sendResponse);
      return true;
    }

    case 'getDownloadProgress': {
      // Return progress for a specific URL
      if (message.url) {
        sendResponse(activeDownloads.get(message.url) || null);
      } else {
        // Return all active downloads (for popup to match against cards)
        const all = {};
        for (const [url, dl] of activeDownloads) {
          all[url] = dl;
        }
        sendResponse(all);
      }
      return true;
    }

    case 'downloadVideo': {
      downloadWithFallback(message.url, message.filename, message.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    case 'rescanTab': {
      handleRescan(message.tabId).then(sendResponse);
      return true;
    }

    case 'clearVideos': {
      detectedVideos.delete(message.tabId);
      updateBadge(message.tabId);
      sendResponse({ ok: true });
      return true;
    }
  }
});

// =============================================
// DIRECT FILE DOWNLOAD — 4-strategy fallback
// =============================================
async function downloadWithFallback(url, filename, tabId) {
  // Strategy 1: chrome.downloads (Chrome's native downloader)
  const dlId = await tryDownload({ url, filename, conflictAction: 'uniquify' });
  if (dlId !== null) {
    const ok = await verifyDownloadStarted(dlId);
    if (ok) return;
  }

  // Strategy 2: Content script fetch + blob download
  try {
    const alive = await pingContentScript(tabId);
    if (alive) {
      const result = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'fetchAndDownload', url, filename }, (resp) => {
          resolve(chrome.runtime.lastError ? null : resp);
        });
      });
      if (result?.ok) return;
    }
  } catch {}

  // Strategy 3: Background fetch → blob → chrome.downloads
  try {
    const buf = await fetchWithTimeout(url, 60000);
    const blob = new Blob([buf]);
    const blobUrl = URL.createObjectURL(blob);
    const dlId2 = await tryDownload({ url: blobUrl, filename, conflictAction: 'uniquify' });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    if (dlId2 !== null) return;
  } catch {}

  // Strategy 4: Open in new tab
  chrome.tabs.create({ url, active: true });
}

function tryDownload(options) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.download(options, (id) => {
        resolve(chrome.runtime.lastError || !id ? null : id);
      });
    } catch { resolve(null); }
  });
}

function verifyDownloadStarted(dlId) {
  return new Promise((resolve) => {
    setTimeout(() => {
      chrome.downloads.search({ id: dlId }, (results) => {
        if (chrome.runtime.lastError || !results?.length) { resolve(false); return; }
        resolve(results[0].state !== 'interrupted');
      });
    }, 1500);
  });
}

// =============================================
// RESCAN
// =============================================
async function handleRescan(tabId) {
  let tabUrl;
  try { tabUrl = (await chrome.tabs.get(tabId)).url || ''; }
  catch { return { ok: false, error: 'Tab not found' }; }

  if (!tabUrl.startsWith('http')) return { ok: false, error: 'Cannot scan this page type' };

  if (await pingContentScript(tabId)) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'rescan' }, (resp) => {
        resolve(chrome.runtime.lastError ? { ok: false } : { ok: true, method: 'message' });
      });
    });
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return { ok: true, method: 'injected' };
  } catch (e) { return { ok: false, error: e.message }; }
}

function pingContentScript(tabId) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 500);
    try {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (resp) => {
        clearTimeout(t);
        resolve(!chrome.runtime.lastError && !!resp);
      });
    } catch { clearTimeout(t); resolve(false); }
  });
}

// =============================================
// STREAM DOWNLOAD — keyed by URL, supports
// multiple concurrent downloads across any tabs
// =============================================

// Keyed by stream URL (not tabId!) — each download is independent
const activeDownloads = new Map(); // url → { tabId, url, state, percent, segsDone, segsTotal, error }

// --- Service worker keepalive ---
const KEEPALIVE_ALARM = 'download-keepalive';

function refreshKeepalive() {
  const hasActive = [...activeDownloads.values()].some((d) => d.state === 'downloading');
  if (hasActive) {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } else {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    refreshKeepalive(); // stop alarm if no active downloads remain
  }
});

async function handleStreamDownload(tabId, url) {
  // Prevent double-download of the exact same URL
  const existing = activeDownloads.get(url);
  if (existing) {
    if (existing.state === 'downloading') {
      return { ok: true, message: 'Already downloading' };
    }
    // Previous attempt done/errored — allow retry
  }

  const progress = { tabId, url, state: 'downloading', percent: 0, error: null, segsDone: 0, segsTotal: 0 };
  activeDownloads.set(url, progress);
  refreshKeepalive();

  try {
    const { segments } = await resolveHlsSegments(url);
    if (!segments?.length) throw new Error('No segments found in playlist');

    progress.segsTotal = segments.length;

    // Download segments with concurrency pool + retry
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
            chunks[idx] = await fetchWithTimeout(segUrl, TIMEOUT_MS);
            progress.segsDone++;
            progress.percent = Math.round((progress.segsDone / progress.segsTotal) * 100);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (attempt < RETRIES - 1) {
              await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
            }
          }
        }

        if (lastErr) {
          failures++;
          if (failures > Math.max(3, segments.length * 0.05)) {
            throw new Error(`Too many failed segments (${failures}/${segments.length})`);
          }
          chunks[idx] = new ArrayBuffer(0);
          progress.segsDone++;
          progress.percent = Math.round((progress.segsDone / progress.segsTotal) * 100);
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, segments.length); i++) workers.push(worker());
    await Promise.all(workers);

    // Stitch and save
    const blob = new Blob(chunks.filter(Boolean), { type: 'video/mp2t' });
    const blobUrl = URL.createObjectURL(blob);

    let filename = 'video.ts';
    try {
      const base = new URL(url).pathname.split('/').filter(Boolean).pop()?.replace(/\.m3u8.*$/, '');
      if (base) filename = base + '.ts';
    } catch {}

    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify' }, (dlId) => {
        if (chrome.runtime.lastError || !dlId) {
          triggerBlobDownloadInTab(tabId, blobUrl, filename).then(resolve).catch(reject);
        } else {
          resolve(dlId);
        }
      });
    });

    progress.state = 'done';
    progress.percent = 100;
    refreshKeepalive();

    // Badge: green checkmark
    chrome.action.setBadgeText({ text: '✓', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#00B894', tabId });
    setTimeout(() => updateBadge(tabId), 10000);

    // Keep the "done" state visible for 60s, then clean up
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      activeDownloads.delete(url);
    }, 60000);

    return { ok: true, segments: segments.length, failures };

  } catch (e) {
    progress.state = 'error';
    progress.error = e.message;
    refreshKeepalive();
    setTimeout(() => activeDownloads.delete(url), 30000);
    return { ok: false, error: e.message };
  }
}

// =============================================
// HLS HELPERS
// =============================================
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

async function resolveHlsSegments(m3u8Url, depth = 0) {
  if (depth > 5) throw new Error('Too many playlist redirects');

  const buf = await fetchWithTimeout(m3u8Url, 15000);
  const text = new TextDecoder().decode(buf);
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Master playlist?
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bw = parseInt(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10);
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) { variants.push({ url: lines[j], bw }); break; }
      }
    }
  }

  if (variants.length > 0) {
    variants.sort((a, b) => b.bw - a.bw);
    return resolveHlsSegments(hlsResolve(variants[0].url, baseUrl, m3u8Url), depth + 1);
  }

  // Media playlist
  const segments = [];
  for (const line of lines) {
    if (!line.startsWith('#')) segments.push(hlsResolve(line, baseUrl, m3u8Url));
  }
  return { segments, baseUrl };
}

function hlsResolve(url, baseUrl, originalUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) {
    try { return new URL(originalUrl).origin + url; } catch {}
  }
  return baseUrl + url;
}

async function triggerBlobDownloadInTab(tabId, blobUrl, filename) {
  if (!(await pingContentScript(tabId))) return;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'triggerDownload', blobUrl, filename }, () => resolve());
  });
}
