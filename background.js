// background.js — Service worker: network interception, detection, downloads
importScripts('mux.min.js');

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
const detectionHistory = new Map(); // tabId → Map<url, entry> — survives "clear", restored on rescan
const blockedTabs = new Set();

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
  // Save to history (survives "clear all", restored on rescan)
  if (!detectionHistory.has(tabId)) detectionHistory.set(tabId, new Map());
  detectionHistory.get(tabId).set(url, entry);
  updateBadge(tabId);

  if (source === 'network') {
    chrome.tabs.sendMessage(tabId, { action: 'getVideoInfo', url }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp?.poster) entry.thumbnail = resp.poster;
      if (resp?.duration) entry.duration = resp.duration;
    });
  }

  // Size is captured from onHeadersReceived — no speculative HEAD needed
}

function updateBadge(tabId) {
  const tabVideos = detectedVideos.get(tabId);
  const count = tabVideos ? tabVideos.size : 0;
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
    detectionHistory.delete(tabId); // New page = new history
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedVideos.delete(tabId);
  detectionHistory.delete(tabId);
  blockedTabs.delete(tabId);
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
      handleStreamDownload(message.url, message.filename, message.format || 'mp4').then(sendResponse);
      return true;
    }

    case 'getAllDownloads': {
      // Return all downloads from persistent storage
      chrome.storage.local.get('downloads', (data) => {
        sendResponse(data.downloads || {});
      });
      return true;
    }

    case 'cancelDownload': {
      cancelDownload(message.url);
      sendResponse({ ok: true });
      return true;
    }

    case 'removeDownload': {
      removeDownload(message.url);
      sendResponse({ ok: true });
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
  const dlId = await tryDownload({ url, filename, conflictAction: 'uniquify' });
  if (dlId !== null) {
    const ok = await verifyDownloadStarted(dlId);
    if (ok) return;
  }

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

  try {
    const buf = await fetchWithTimeout(url, 60000);
    const blob = new Blob([buf]);
    const blobUrl = URL.createObjectURL(blob);
    const dlId2 = await tryDownload({ url: blobUrl, filename, conflictAction: 'uniquify' });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    if (dlId2 !== null) return;
  } catch {}

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

  // Restore any previously detected videos from history (survives "clear all")
  const history = detectionHistory.get(tabId);
  if (history?.size) {
    if (!detectedVideos.has(tabId)) detectedVideos.set(tabId, new Map());
    const tabVideos = detectedVideos.get(tabId);
    for (const [url, entry] of history) {
      if (!tabVideos.has(url)) tabVideos.set(url, entry);
    }
    updateBadge(tabId);
  }

  // Also scan the DOM via content script
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
// IndexedDB — persistent segment storage
// =============================================

function openSegmentDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('hls-segments', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeSegment(downloadId, index, data) {
  const db = await openSegmentDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    tx.objectStore('chunks').put(data, `${downloadId}:${index}`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadSegment(downloadId, index) {
  const db = await openSegmentDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readonly');
    const req = tx.objectStore('chunks').get(`${downloadId}:${index}`);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function deleteSegments(downloadId) {
  const db = await openSegmentDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        if (cursor.key.startsWith(downloadId + ':')) cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// =============================================
// PERSISTENT DOWNLOAD STATE — chrome.storage.local
// =============================================

// In-memory mirror for fast access (synced to storage)
const activeDownloads = new Map();
// Set of currently running download URLs (prevents double-starts on SW resume)
const runningUrls = new Set();

async function loadDownloads() {
  const data = await chrome.storage.local.get('downloads');
  const downloads = data.downloads || {};
  for (const [url, dl] of Object.entries(downloads)) {
    activeDownloads.set(url, dl);
  }
  return downloads;
}

async function persistDownloads() {
  const obj = {};
  for (const [url, dl] of activeDownloads) {
    obj[url] = dl;
  }
  await chrome.storage.local.set({ downloads: obj });
}

async function updateDownload(url, updates) {
  const dl = activeDownloads.get(url);
  if (!dl) return;
  Object.assign(dl, updates);
  await persistDownloads();
}

async function removeDownload(url) {
  activeDownloads.delete(url);
  await persistDownloads();
  await deleteSegments(url);
}

async function cancelDownload(url) {
  const dl = activeDownloads.get(url);
  if (dl) {
    dl.state = 'cancelled';
    await persistDownloads();
  }
}

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
    refreshKeepalive();
  }
});

// Port-based keepalive
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onDisconnect.addListener(() => {});
  }
});

// =============================================
// HLS DOWNLOAD ENGINE — persistent, resumable
// =============================================

async function handleStreamDownload(url, filename, format = 'mp4') {
  const existing = activeDownloads.get(url);
  if (existing && existing.state === 'downloading' && runningUrls.has(url)) {
    return { ok: true, message: 'Already downloading' };
  }

  // Generate a short ID for IndexedDB keys
  const downloadId = url;

  // Resolve playlist
  console.log('[hls] Resolving playlist:', url);
  let segments;
  try {
    const result = await resolveHlsSegments(url);
    segments = result.segments;
    if (!segments?.length) throw new Error('No segments found');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  console.log('[hls] Found', segments.length, 'segments');

  if (!filename) {
    try {
      const base = new URL(url).pathname.split('/').filter(Boolean).pop()?.replace(/\.m3u8.*$/, '');
      if (base) filename = base + '.ts';
    } catch {}
    if (!filename) filename = 'video.ts';
  }

  // Create persistent download entry
  const dl = {
    url,
    filename,
    state: 'downloading',
    percent: 0,
    segsDone: 0,
    segsTotal: segments.length,
    segments,
    completedSegs: existing?.completedSegs || [],
    format: format || 'mp4',
    error: null,
    startedAt: Date.now(),
  };
  activeDownloads.set(url, dl);
  await persistDownloads();
  refreshKeepalive();

  // Run the download
  runDownload(dl);

  return { ok: true, segments: segments.length };
}

async function runDownload(dl) {
  const { url, segments } = dl;
  if (runningUrls.has(url)) return;
  runningUrls.add(url);

  const CONCURRENCY = 3;
  const RETRIES = 4;
  const TIMEOUT_MS = 60000;

  // Build set of already-completed segment indices
  const done = new Set(dl.completedSegs || []);
  dl.segsDone = done.size;
  dl.percent = segments.length > 0 ? Math.round((dl.segsDone / dl.segsTotal) * 100) : 0;

  let nextIdx = 0;
  let failures = 0;
  let cancelled = false;
  let lastPersist = Date.now();

  async function worker() {
    while (nextIdx < segments.length && !cancelled) {
      // Find next segment that isn't already done
      let idx;
      do { idx = nextIdx++; } while (idx < segments.length && done.has(idx));
      if (idx >= segments.length) break;

      const current = activeDownloads.get(url);
      if (!current || current.state === 'cancelled') { cancelled = true; return; }

      let lastErr = null;
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          const buf = await fetchWithTimeout(segments[idx], TIMEOUT_MS);
          await storeSegment(url, idx, buf);
          done.add(idx);
          dl.segsDone = done.size;
          dl.completedSegs = [...done];
          dl.percent = Math.round((dl.segsDone / dl.segsTotal) * 100);
          // Persist every 10 seconds (not every segment — too slow)
          if (Date.now() - lastPersist > 10000) {
            lastPersist = Date.now();
            persistDownloads();
          }
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < RETRIES - 1) {
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          }
        }
      }

      if (lastErr) {
        failures++;
        if (failures > Math.max(5, segments.length * 0.1)) {
          throw new Error(`Too many failed segments (${failures}/${segments.length})`);
        }
        // Store empty buffer so stitching doesn't break
        await storeSegment(url, idx, new ArrayBuffer(0));
        done.add(idx);
        dl.segsDone = done.size;
        dl.completedSegs = [...done];
        dl.percent = Math.round((dl.segsDone / dl.segsTotal) * 100);
      }
    }
  }

  try {
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, segments.length); i++) workers.push(worker());
    await Promise.all(workers);

    if (cancelled) {
      dl.state = 'cancelled';
      await persistDownloads();
      runningUrls.delete(url);
      refreshKeepalive();
      return;
    }

    // All segments downloaded — stitch and save
    console.log('[hls] All segments done, stitching', dl.filename);
    dl.state = 'saving';
    await persistDownloads();

    await stitchAndSave(url, segments.length, dl.filename, dl.format);

    dl.state = 'done';
    dl.percent = 100;
    await persistDownloads();
    runningUrls.delete(url);
    refreshKeepalive();
    console.log('[hls] Download complete:', dl.filename);

    // Clean up segments from IndexedDB after successful save
    deleteSegments(url);

    // Auto-remove from queue after 5 minutes
    setTimeout(() => removeDownload(url), 300000);

  } catch (e) {
    console.error('[hls] Download failed:', e.message);
    dl.state = 'error';
    dl.error = e.message;
    await persistDownloads();
    runningUrls.delete(url);
    refreshKeepalive();
  }
}

// =============================================
// STITCH & SAVE — read from IndexedDB, save via save.html
// =============================================

async function stitchAndSave(downloadId, segmentCount, filename, format) {
  // Read all segments from IndexedDB
  const chunks = [];
  for (let i = 0; i < segmentCount; i++) {
    const data = await loadSegment(downloadId, i);
    chunks.push(data || new ArrayBuffer(0));
  }

  let blob;
  let mimeType;

  if (format === 'mp4') {
    // Remux TS → MP4 using mux.js transmuxer
    console.log(`[save] Remuxing ${segmentCount} segments to MP4...`);
    try {
      const mp4Buffer = await remuxTsToMp4(chunks);
      blob = new Blob([mp4Buffer], { type: 'video/mp4' });
      mimeType = 'video/mp4';
      filename = filename.replace(/\.ts$/, '.mp4');
      console.log(`[save] Remuxed → ${(blob.size / 1024 / 1024).toFixed(1)}MB MP4`);
    } catch (e) {
      console.warn('[save] MP4 remux failed, falling back to TS:', e.message);
      blob = new Blob(chunks, { type: 'video/mp2t' });
      mimeType = 'video/mp2t';
    }
  } else {
    blob = new Blob(chunks, { type: 'video/mp2t' });
    mimeType = 'video/mp2t';
    console.log(`[save] Stitched ${segmentCount} segments → ${(blob.size / 1024 / 1024).toFixed(1)}MB TS`);
  }

  // Strategy 1: blob URL + chrome.downloads
  try {
    const blobUrl = URL.createObjectURL(blob);
    const dlId = await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: blobUrl, filename, conflictAction: 'uniquify' },
        (id) => {
          if (chrome.runtime.lastError || !id) reject(new Error(chrome.runtime.lastError?.message || 'no ID'));
          else resolve(id);
        }
      );
    });
    await new Promise((r) => setTimeout(r, 2000));
    const [item] = await chrome.downloads.search({ id: dlId });
    if (item?.state === 'interrupted') throw new Error('interrupted: ' + item.error);
    console.log('[save] Blob URL download OK, state:', item?.state);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    return;
  } catch (e) {
    console.warn('[save] Blob URL failed:', e.message);
  }

  // Strategy 2: save page (background tab, auto-closes)
  console.log('[save] Using save page fallback');
  const cacheUrl = 'https://hls-save.local/' + Date.now();
  const cache = await caches.open('hls-downloads');
  await cache.put(cacheUrl, new Response(blob, {
    headers: { 'Content-Type': mimeType },
  }));
  const saveUrl = chrome.runtime.getURL('save.html') + '?cache=' + encodeURIComponent(cacheUrl) + '&name=' + encodeURIComponent(filename);
  const saveTab = await chrome.tabs.create({ url: saveUrl, active: false });
  setTimeout(async () => { try { await chrome.tabs.remove(saveTab.id); } catch {} }, 15000);
}

// =============================================
// TS → MP4 REMUXER (mux.js transmuxer)
// =============================================

function remuxTsToMp4(tsChunks) {
  return new Promise((resolve, reject) => {
    const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
    const outputChunks = [];
    let initSegment = null;

    transmuxer.on('data', (segment) => {
      if (segment.initSegment && segment.initSegment.byteLength > 0 && !initSegment) {
        initSegment = new Uint8Array(segment.initSegment);
      }
      const data = new Uint8Array(segment.data);
      if (initSegment && outputChunks.length === 0) {
        // First output: prepend init segment (ftyp + moov)
        const combined = new Uint8Array(initSegment.byteLength + data.byteLength);
        combined.set(initSegment, 0);
        combined.set(data, initSegment.byteLength);
        outputChunks.push(combined);
      } else {
        outputChunks.push(data);
      }
    });

    transmuxer.on('done', () => {
      const totalLength = outputChunks.reduce((sum, c) => sum + c.byteLength, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of outputChunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(result.buffer);
    });

    transmuxer.on('error', (err) => reject(err));

    // Feed all TS chunks
    for (const chunk of tsChunks) {
      if (chunk && chunk.byteLength > 0) {
        transmuxer.push(new Uint8Array(chunk));
      }
    }
    transmuxer.flush();
  });
}

// =============================================
// SW STARTUP — resume incomplete downloads
// =============================================

async function resumeDownloads() {
  try {
    const downloads = await loadDownloads();
    for (const [url, dl] of Object.entries(downloads)) {
      // Clean up stale terminal states
      if (dl.state === 'done' || dl.state === 'cancelled') {
        activeDownloads.set(url, dl);
        continue;
      }
      if (dl.state === 'downloading' && dl.segments?.length) {
        console.log('[resume] Resuming download:', dl.filename, `(${dl.segsDone}/${dl.segsTotal})`);
        activeDownloads.set(url, dl);
        runDownload(dl);
      } else if (dl.state === 'saving') {
        console.log('[resume] Retrying save:', dl.filename);
        activeDownloads.set(url, dl);
        stitchAndSave(url, dl.segsTotal, dl.filename, dl.format).then(() => {
          dl.state = 'done';
          dl.percent = 100;
          persistDownloads();
          deleteSegments(url);
          setTimeout(() => removeDownload(url), 300000);
        }).catch((e) => {
          dl.state = 'error';
          dl.error = e.message;
          persistDownloads();
        });
      }
    }
    refreshKeepalive();
  } catch (e) {
    console.error('[resume] Error resuming downloads:', e);
  }
}

// Run on SW startup
resumeDownloads();

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
