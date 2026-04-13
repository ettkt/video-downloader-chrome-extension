// content.js — Scans the DOM and page source for video URLs without playing anything

(() => {
  'use strict';

  const VIDEO_REGEX =
    /https?:\/\/[^\s"'<>\)}\]]+?\.(m3u8|mpd|mp4|webm|flv)(\?[^\s"'<>\)}\]]*)?/gi;

  const TYPE_MAP = {
    m3u8: 'HLS (M3U8)',
    mpd: 'DASH (MPD)',
    mp4: 'MP4',
    webm: 'WebM',
    flv: 'FLV',
  };

  const reported = new Set();

  // --- Thumbnail helper ---
  function getVideoThumbnail(videoEl) {
    if (videoEl?.poster) return videoEl.poster;
    return null;
  }

  function findPosterForUrl(videoUrl) {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      const src = v.src || v.currentSrc || '';
      if (src && videoUrl.includes(src.split('?')[0])) {
        if (v.poster) return v.poster;
      }
      for (const s of v.querySelectorAll('source')) {
        if (s.src && videoUrl.includes(s.src.split('?')[0])) {
          if (v.poster) return v.poster;
        }
      }
    }
    if (videos.length === 1 && videos[0].poster) {
      return videos[0].poster;
    }
    return null;
  }

  // --- Duration helper ---
  function getVideoDuration(videoEl) {
    if (videoEl && videoEl.duration && isFinite(videoEl.duration) && videoEl.duration > 0) {
      return videoEl.duration;
    }
    return null;
  }

  function findDurationForUrl(videoUrl) {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      const src = v.src || v.currentSrc || '';
      const matches = src && videoUrl.includes(src.split('?')[0]);
      if (matches) {
        const dur = getVideoDuration(v);
        if (dur) return dur;
      }
      for (const s of v.querySelectorAll('source')) {
        if (s.src && videoUrl.includes(s.src.split('?')[0])) {
          const dur = getVideoDuration(v);
          if (dur) return dur;
        }
      }
    }
    // If only one video on page
    if (videos.length === 1) {
      return getVideoDuration(videos[0]);
    }
    return null;
  }

  function report(url, type, source, thumbnail, duration) {
    if (!url || url.length < 10 || url.startsWith('blob:') || url.startsWith('data:')) return;

    // Resolve relative URLs to absolute
    try {
      url = new URL(url, document.baseURI).href;
    } catch {
      return;
    }

    const baseUrl = url.split('?')[0];
    if (reported.has(baseUrl)) return;
    reported.add(baseUrl);

    try {
      chrome.runtime.sendMessage({
        action: 'videoFound',
        url,
        type,
        source,
        thumbnail: thumbnail || null,
        duration: duration || null,
      });
    } catch {
      // Extension context invalidated
    }
  }

  // --- Message handler ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fetchAndDownload') {
      fetchAndDownload(message.url, message.filename)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    try {
      if (message.action === 'ping') {
        sendResponse({ alive: true });
      } else if (message.action === 'getPoster') {
        sendResponse({ poster: findPosterForUrl(message.url) });
      } else if (message.action === 'getDuration') {
        sendResponse({ duration: findDurationForUrl(message.url) });
      } else if (message.action === 'getVideoInfo') {
        sendResponse({
          poster: findPosterForUrl(message.url),
          duration: findDurationForUrl(message.url),
        });
      } else if (message.action === 'rescan') {
        reported.clear();
        scanAll();
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ error: e.message });
    }
  });

  function getExtension(url) {
    const match = url.match(/\.(m3u8|mpd|mp4|webm|flv)/i);
    return match ? match[1].toLowerCase() : null;
  }

  function tryReport(url, source, videoEl) {
    if (!url) return;
    const ext = getExtension(url);
    if (!ext) return;
    const thumb = videoEl ? getVideoThumbnail(videoEl) : null;
    const duration = videoEl ? getVideoDuration(videoEl) : null;
    report(url, TYPE_MAP[ext], source, thumb, duration);
  }

  // ======================
  // 1. Scan DOM elements
  // ======================
  function scanDomElements() {
    // <video> and <audio> elements + their <source> children
    document.querySelectorAll('video, audio').forEach((el) => {
      const src = el.src || el.currentSrc;
      if (src) tryReport(src, 'dom', el);

      el.querySelectorAll('source').forEach((s) => {
        if (s.src) tryReport(s.src, 'dom', el);
      });
    });

    // Standalone <source> elements
    document.querySelectorAll('source[src]').forEach((el) => {
      const videoParent = el.closest('video');
      tryReport(el.src, 'dom', videoParent);
    });

    // <embed> and <object>
    document.querySelectorAll('embed[src], object[data]').forEach((el) => {
      tryReport(el.src || el.getAttribute('data'), 'dom', null);
    });

    // <a> tags that link directly to video files
    document.querySelectorAll('a[href]').forEach((el) => {
      const href = el.href;
      if (href) tryReport(href, 'dom', null);
    });

    // <iframe> src that might be a direct video
    document.querySelectorAll('iframe[src]').forEach((el) => {
      tryReport(el.src, 'dom', null);
    });
  }

  // ======================
  // 2. Scan page source — inline scripts, JSON-LD, meta tags, all attributes
  // ======================
  function scanPageSource() {
    // Inline <script> content
    document.querySelectorAll('script:not([src])').forEach((script) => {
      const text = script.textContent;
      if (!text) return;
      const matches = text.match(VIDEO_REGEX);
      if (matches) {
        matches.forEach((url) => tryReport(url, 'source', null));
      }
    });

    // JSON-LD structured data (common on news sites, archive.org, etc.)
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const text = script.textContent;
        const matches = text.match(VIDEO_REGEX);
        if (matches) {
          matches.forEach((url) => tryReport(url, 'source', null));
        }
      } catch {}
    });

    // Meta tags with video URLs
    document.querySelectorAll('meta[content]').forEach((meta) => {
      const content = meta.getAttribute('content');
      if (content) {
        const ext = getExtension(content);
        if (ext) tryReport(content, 'meta', null);
      }
    });

    // All data-* attributes across the entire page
    const dataAttrs = [
      'data-src', 'data-url', 'data-video', 'data-stream',
      'data-video-src', 'data-file', 'data-mp4', 'data-webm',
      'data-hls', 'data-source', 'data-media',
    ];
    const selector = dataAttrs.map((a) => `[${a}]`).join(',');
    document.querySelectorAll(selector).forEach((el) => {
      for (const attr of dataAttrs) {
        const val = el.getAttribute(attr);
        if (val) tryReport(val, 'dom', null);
      }
    });

    // Scan the full HTML as a last resort for URLs buried in comments, noscript, etc.
    try {
      const html = document.documentElement.outerHTML;
      const matches = html.match(VIDEO_REGEX);
      if (matches) {
        // Deduplicate before reporting
        const unique = [...new Set(matches)];
        unique.forEach((url) => tryReport(url, 'source', null));
      }
    } catch {}
  }

  // ======================
  // 3. Observe DOM mutations
  // ======================
  function observeDom() {
    let scanTimeout = null;
    const observer = new MutationObserver(() => {
      // Debounce — don't scan on every single mutation
      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(() => {
        scanDomElements();
      }, 300);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // ======================
  // Combined scan
  // ======================
  function scanAll() {
    scanDomElements();
    scanPageSource();
  }

  // --- Download helper ---
  async function fetchAndDownload(url, filename) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'video.mp4';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }

  // --- Run ---
  scanAll();
  observeDom();
})();
