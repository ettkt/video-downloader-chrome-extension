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
  function getPageThumbnail() {
    // Try og:image first, then twitter:image, then first large image on page
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage?.content) return ogImage.content;

    const twImage = document.querySelector('meta[name="twitter:image"]');
    if (twImage?.content) return twImage.content;

    return null;
  }

  function getVideoThumbnail(videoEl) {
    // 1. poster attribute
    if (videoEl?.poster) return videoEl.poster;

    // 2. Look for a nearby thumbnail image (sibling or parent container)
    if (videoEl) {
      const container = videoEl.closest('div, figure, article, section');
      if (container) {
        const img = container.querySelector('img[src]');
        if (img?.src && img.naturalWidth > 60) return img.src;
      }
    }

    // 3. Fallback to page-level thumbnail
    return getPageThumbnail();
  }

  function report(url, type, source, thumbnail) {
    const baseUrl = url.split('?')[0];
    if (reported.has(baseUrl)) return;
    reported.add(baseUrl);

    chrome.runtime.sendMessage({
      action: 'videoFound',
      url,
      type,
      source,
      thumbnail: thumbnail || getPageThumbnail(),
    });
  }

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
