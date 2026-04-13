// content.js — Scans the DOM and page source for video URLs without playing anything

(() => {
  'use strict';

  const VIDEO_REGEX =
    /https?:\/\/[^\s"'<>]+?\.(m3u8|mpd|mp4|webm|flv)(\?[^\s"'<>]*)?/gi;

  const TYPE_MAP = {
    m3u8: 'HLS (M3U8)',
    mpd: 'DASH (MPD)',
    mp4: 'MP4',
    webm: 'WebM',
    flv: 'FLV',
  };

  const reported = new Set();

  // --- Thumbnail helpers ---
  function getVideoThumbnail(videoEl) {
    // Only use the actual <video> element's poster — never og:image or random page images
    if (videoEl?.poster) return videoEl.poster;
    return null;
  }

  // Find poster for a video URL by matching it to a <video> element on the page
  function findPosterForUrl(videoUrl) {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      // Check if this video element uses the given URL
      const src = v.src || v.currentSrc || '';
      if (src && videoUrl.includes(src.split('?')[0])) {
        if (v.poster) return v.poster;
      }
      // Check <source> children
      for (const s of v.querySelectorAll('source')) {
        if (s.src && videoUrl.includes(s.src.split('?')[0])) {
          if (v.poster) return v.poster;
        }
      }
    }
    // If only one video on page, use its poster
    if (videos.length === 1 && videos[0].poster) {
      return videos[0].poster;
    }
    return null;
  }

  function report(url, type, source, thumbnail) {
    // Skip obviously bad URLs
    if (!url || url.length < 10 || url.startsWith('blob:') || url.startsWith('data:')) return;

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
      });
    } catch {
      // Extension context invalidated (e.g. extension reloaded)
    }
  }

  // Respond to messages from background/popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message.action === 'getPoster') {
        const poster = findPosterForUrl(message.url);
        sendResponse({ poster });
      }
      if (message.action === 'rescan') {
        // Clear reported set so we can re-detect everything
        reported.clear();
        scanDomElements();
        scanPageSource();
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

  // --- 1. Scan <video>, <source>, <embed>, <object>, <iframe> elements ---
  function scanDomElements() {
    // Video and source elements
    document.querySelectorAll('video, audio').forEach((el) => {
      const thumb = getVideoThumbnail(el);
      const src = el.src || el.currentSrc;
      if (src) {
        const ext = getExtension(src);
        if (ext) report(src, TYPE_MAP[ext], 'dom', thumb);
      }

      el.querySelectorAll('source').forEach((source) => {
        if (source.src) {
          const ext = getExtension(source.src);
          if (ext) report(source.src, TYPE_MAP[ext], 'dom', thumb);
        }
      });
    });

    // Standalone source elements
    document.querySelectorAll('source[src]').forEach((el) => {
      const videoParent = el.closest('video');
      const thumb = getVideoThumbnail(videoParent);
      const ext = getExtension(el.src);
      if (ext) report(el.src, TYPE_MAP[ext], 'dom', thumb);
    });

    // Embed and object
    document.querySelectorAll('embed[src], object[data]').forEach((el) => {
      const url = el.src || el.getAttribute('data');
      if (url) {
        const ext = getExtension(url);
        if (ext) report(url, TYPE_MAP[ext], 'dom', null);
      }
    });
  }

  // --- 2. Scan inline scripts and page source for video URLs ---
  function scanPageSource() {
    const scripts = document.querySelectorAll('script:not([src])');
    scripts.forEach((script) => {
      const matches = script.textContent.match(VIDEO_REGEX);
      if (matches) {
        matches.forEach((url) => {
          const ext = getExtension(url);
          if (ext) report(url, TYPE_MAP[ext], 'source', null);
        });
      }
    });

    // Also scan data attributes across the page
    document.querySelectorAll('[data-src], [data-url], [data-video], [data-stream]').forEach((el) => {
      for (const attr of ['data-src', 'data-url', 'data-video', 'data-stream']) {
        const val = el.getAttribute(attr);
        if (val) {
          const ext = getExtension(val);
          if (ext) report(val, TYPE_MAP[ext], 'dom', null);
        }
      }
    });
  }

  // --- 3. Observe DOM mutations for dynamically added elements ---
  function observeDom() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        scanDomElements();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // --- Run scans ---
  scanDomElements();
  scanPageSource();
  observeDom();
})();
