// popup.js — Renders detected videos and global download queue

document.addEventListener('DOMContentLoaded', async () => {
  const videoListEl = document.getElementById('videoList');
  const emptyStateEl = document.getElementById('emptyState');
  const videoCountEl = document.getElementById('videoCount');
  const pageUrlEl = document.getElementById('pageUrl');
  const clearBtn = document.getElementById('clearBtn');
  const rescanBtn = document.getElementById('rescanBtn');
  const downloadsEl = document.getElementById('downloadQueue');
  const blockedStateEl = document.getElementById('blockedState');
  const emptyTitleEl = document.getElementById('emptyTitle');
  const emptySubtitleEl = document.getElementById('emptySubtitle');
  const emptyIconEl = document.getElementById('emptyIcon');

  const dlIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const checkIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const cancelIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const ffmpegIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 6.5h6M4 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  const copyIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M9.5 4.5V2.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" stroke="currentColor" stroke-width="1.2"/></svg>`;

  // Keep service worker alive
  const keepalivePort = chrome.runtime.connect({ name: 'keepalive' });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  try {
    const url = new URL(tab.url);
    pageUrlEl.textContent = url.hostname + url.pathname;
    pageUrlEl.title = tab.url;
  } catch {
    pageUrlEl.textContent = tab.url || '';
  }

  // =============================================
  // GLOBAL DOWNLOAD QUEUE
  // =============================================

  let downloadPollId = null;

  function startDownloadPolling() {
    renderDownloadQueue();
    if (downloadPollId) clearInterval(downloadPollId);
    downloadPollId = setInterval(renderDownloadQueue, 1000);
  }

  // Clean up polling on popup close
  window.addEventListener('unload', () => {
    if (downloadPollId) clearInterval(downloadPollId);
  });

  function getFileExt(filename) {
    const ext = (filename || '').split('.').pop()?.toUpperCase();
    return ext || 'TS';
  }

  function renderDownloadQueue() {
    chrome.runtime.sendMessage({ action: 'getAllDownloads' }, (downloads) => {
      if (chrome.runtime.lastError || !downloads) return;

      const entries = Object.entries(downloads);
      if (entries.length === 0) {
        downloadsEl.style.display = 'none';
        return;
      }

      downloadsEl.style.display = 'block';

      // Ensure header exists
      if (!downloadsEl.querySelector('.dl-header')) {
        const header = document.createElement('div');
        header.className = 'dl-header';
        downloadsEl.prepend(header);
      }
      const activeCount = entries.filter(([, d]) => d.state === 'downloading' || d.state === 'saving').length;
      downloadsEl.querySelector('.dl-header').textContent = `Downloads${activeCount > 0 ? '  \u00b7  ' + activeCount + ' active' : ''}`;

      const existing = new Set();

      for (const [url, dl] of entries) {
        existing.add(url);
        let item = downloadsEl.querySelector(`[data-dl-url="${CSS.escape(url)}"]`);

        if (!item) {
          item = document.createElement('div');
          item.className = 'dl-item';
          item.dataset.dlUrl = url;
          item.innerHTML = `
            <div class="dl-hero">
              <div class="dl-row">
                <div class="dl-icon"></div>
                <div class="dl-body">
                  <div class="dl-top">
                    <div class="dl-filename"></div>
                    <div class="dl-status-pill"></div>
                  </div>
                </div>
              </div>
              <div class="dl-progress-bar"><div class="dl-progress-fill"></div></div>
            </div>
            <div class="dl-footer">
              <div class="dl-meta"></div>
              <div class="dl-actions"></div>
            </div>
          `;
          downloadsEl.appendChild(item);
        }

        const iconEl = item.querySelector('.dl-icon');
        const filenameEl = item.querySelector('.dl-filename');
        const pillEl = item.querySelector('.dl-status-pill');
        const metaEl = item.querySelector('.dl-meta');
        const fillEl = item.querySelector('.dl-progress-fill');
        const actionsEl = item.querySelector('.dl-actions');

        const ext = getFileExt(dl.filename);
        iconEl.textContent = ext;
        iconEl.className = 'dl-icon' + (ext === 'MP4' ? ' mp4' : ext === 'WEBM' ? ' webm' : '');
        filenameEl.textContent = dl.filename || 'video.ts';
        fillEl.style.width = dl.percent + '%';

        // State class on item for left-border color
        item.className = 'dl-item state-' + dl.state;

        if (dl.state === 'downloading') {
          pillEl.textContent = dl.percent + '%';
          fillEl.className = 'dl-progress-fill downloading';
          metaEl.innerHTML =
            `<span class="dl-tag type">HLS</span>` +
            (dl.segsTotal ? `<span class="dl-tag segs">${dl.segsDone}/${dl.segsTotal} segments</span>` : '');
          actionsEl.innerHTML = `<button class="dl-btn dl-cancel">${cancelIcon} Cancel</button>`;
          actionsEl.querySelector('.dl-cancel').onclick = () => {
            chrome.runtime.sendMessage({ action: 'cancelDownload', url });
          };
        } else if (dl.state === 'saving') {
          pillEl.innerHTML = '<span class="dl-spinner"></span> Saving';
          fillEl.className = 'dl-progress-fill saving';
          fillEl.style.width = '100%';
          metaEl.innerHTML = `<span class="dl-tag type">HLS</span><span class="dl-tag">${dl.segsTotal} segments</span>`;
          actionsEl.innerHTML = '';
        } else if (dl.state === 'done') {
          pillEl.textContent = 'Done';
          fillEl.className = 'dl-progress-fill done';
          fillEl.style.width = '100%';
          metaEl.innerHTML = `<span class="dl-tag type">HLS</span><span class="dl-tag segs">${dl.segsTotal} segments</span>`;
          actionsEl.innerHTML = `<button class="dl-btn dl-remove">${cancelIcon} Dismiss</button>`;
          actionsEl.querySelector('.dl-remove').onclick = () => {
            chrome.runtime.sendMessage({ action: 'removeDownload', url });
            item.remove();
          };
        } else if (dl.state === 'error') {
          pillEl.textContent = 'Failed';
          fillEl.className = 'dl-progress-fill error';
          metaEl.innerHTML = `<span class="dl-tag error-msg">${dl.error || 'Unknown error'}</span>`;
          actionsEl.innerHTML = `
            <button class="dl-btn dl-retry">${dlIcon} Retry</button>
            <button class="dl-btn dl-remove">${cancelIcon} Dismiss</button>
          `;
          const retryBtn = actionsEl.querySelector('.dl-retry');
          if (retryBtn) retryBtn.onclick = () => {
            chrome.runtime.sendMessage({ action: 'removeDownload', url }, () => {
              chrome.runtime.sendMessage({ action: 'downloadStream', url, filename: dl.filename });
            });
          };
          actionsEl.querySelector('.dl-remove').onclick = () => {
            chrome.runtime.sendMessage({ action: 'removeDownload', url });
            item.remove();
          };
        } else if (dl.state === 'cancelled') {
          pillEl.textContent = 'Cancelled';
          fillEl.className = 'dl-progress-fill error';
          metaEl.innerHTML = '';
          actionsEl.innerHTML = `<button class="dl-btn dl-remove">${cancelIcon} Dismiss</button>`;
          actionsEl.querySelector('.dl-remove').onclick = () => {
            chrome.runtime.sendMessage({ action: 'removeDownload', url });
            item.remove();
          };
        }
      }

      // Remove items no longer in downloads
      for (const item of downloadsEl.querySelectorAll('.dl-item')) {
        if (!existing.has(item.dataset.dlUrl)) item.remove();
      }
    });
  }

  // =============================================
  // VIDEO LIST (current tab)
  // =============================================

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return null;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0 || !isFinite(seconds)) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function guessFilename(url, type) {
    try {
      const last = new URL(url).pathname.split('/').filter(Boolean).pop();
      if (last?.includes('.')) return decodeURIComponent(last);
    } catch {}
    const ext = { 'HLS (M3U8)': 'm3u8', 'DASH (MPD)': 'mpd', MP4: 'mp4', WebM: 'webm', FLV: 'flv' };
    return `video.${ext[type] || 'mp4'}`;
  }

  function getBadgeClass(type) {
    if (type.includes('M3U8') || type.includes('HLS')) return 'hls';
    if (type.includes('DASH') || type.includes('MPD')) return 'dash';
    if (type.includes('MP4')) return 'mp4';
    if (type.includes('WebM')) return 'webm';
    if (type.includes('FLV')) return 'flv';
    return 'other';
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function loadVideos(callback) {
    chrome.runtime.sendMessage({ action: 'getVideos', tabId: tab.id }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      renderVideos(response.videos);
      if (callback) callback();
    });
  }

  function showEmptyState(title, subtitle) {
    emptyTitleEl.textContent = title;
    emptySubtitleEl.textContent = subtitle || '';
    emptyIconEl.innerHTML = `<svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="23" stroke="#DDD" stroke-width="2" stroke-dasharray="4 4"/>
      <path d="M20 16L32 24L20 32V16Z" fill="#CCC"/></svg>`;
    emptyStateEl.classList.add('visible');
  }

  function renderVideos(videos) {
    videoListEl.innerHTML = '';

    if (!videos?.length) {
      showEmptyState('No videos detected', 'Browse a page with video content — detection is automatic.');
      videoListEl.style.display = 'none';
      videoCountEl.textContent = '0 videos';
      return;
    }

    emptyStateEl.classList.remove('visible');
    videoListEl.style.display = 'block';
    videoCountEl.textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''}`;

    videos.sort((a, b) => {
      const priority = { 'HLS (M3U8)': 0, 'DASH (MPD)': 1, MP4: 2, WebM: 3, FLV: 4 };
      return (priority[a.type] ?? 5) - (priority[b.type] ?? 5) || (b.size || 0) - (a.size || 0) || b.timestamp - a.timestamp;
    });

    videos.forEach((v) => {
      try { videoListEl.appendChild(createVideoCard(v)); } catch (e) { console.warn('Card error:', e); }
    });
  }

  function createVideoCard(video) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.url = video.url;

    const badgeClass = getBadgeClass(video.type);
    const sizeStr = formatSize(video.size);
    const durationStr = formatDuration(video.duration);
    const isStreamType = video.isStream;

    const thumbHtml = video.thumbnail
      ? `<img src="${escapeAttr(video.thumbnail)}" alt="" loading="lazy">`
      : `<div class="thumb-placeholder"><svg width="40" height="40" viewBox="0 0 40 40" fill="none"><path d="M15 10L30 20L15 30V10Z" fill="white"/></svg></div>`;

    let thumbOverlays = '';
    if (durationStr) thumbOverlays += `<span class="thumb-duration">${escapeHtml(durationStr)}</span>`;

    let metaHtml = `<span class="source-tag">${escapeHtml(video.source)}</span>`;
    if (durationStr) metaHtml += `<span class="source-tag duration-tag">${escapeHtml(durationStr)}</span>`;
    if (sizeStr) metaHtml += `<span class="source-tag size-tag">${escapeHtml(sizeStr)}</span>`;
    if (isStreamType) metaHtml += `<span class="source-tag stream-tag">STREAM</span>`;

    let actionsHtml;
    if (isStreamType) {
      actionsHtml = `
        <button class="btn-action btn-download-stream" title="Download full stream">${dlIcon} MP4</button>
        <button class="btn-action btn-download-stream-ts" title="Download as .ts">${dlIcon} TS</button>
        <button class="btn-action btn-ffmpeg" title="Copy FFmpeg command">${ffmpegIcon}</button>
        <button class="btn-action btn-copy" title="Copy URL">${copyIcon}</button>
        <button class="btn-action btn-open" title="Open in new tab"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M6 2H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8M8 2h4v4M7 7l5-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      `;
    } else {
      actionsHtml = `
        <button class="btn-action btn-download" title="Download file">${dlIcon} Download${sizeStr ? ' (' + sizeStr + ')' : ''}</button>
        <button class="btn-action btn-open" title="Open in new tab"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M6 2H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8M8 2h4v4M7 7l5-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="btn-action btn-copy" title="Copy URL">${copyIcon}</button>
      `;
    }

    card.innerHTML = `
      <div class="card-thumbnail">${thumbHtml}<span class="thumb-badge type-badge ${badgeClass}">${escapeHtml(video.type)}</span>${thumbOverlays}</div>
      <div class="card-info">
        <div class="video-url" title="${escapeAttr(video.url)}">${escapeHtml(video.url)}</div>
        <div class="card-meta">${metaHtml}</div>
      </div>
      <div class="card-actions">${actionsHtml}</div>
    `;

    // Probe metadata for direct videos
    if (!isStreamType && (!video.thumbnail || !durationStr)) {
      probeVideoMetadata(video.url, !video.thumbnail).then((meta) => {
        if (meta.thumbnail && !video.thumbnail) {
          const ph = card.querySelector('.thumb-placeholder');
          if (ph) { const img = document.createElement('img'); img.src = meta.thumbnail; img.alt = ''; ph.parentNode.replaceChild(img, ph); }
        }
        if (meta.duration) {
          const dur = formatDuration(meta.duration);
          if (dur) {
            let overlay = card.querySelector('.thumb-duration');
            if (!overlay) { overlay = document.createElement('span'); overlay.className = 'thumb-duration'; card.querySelector('.card-thumbnail')?.appendChild(overlay); }
            overlay.textContent = dur;
          }
        }
      });
    }

    // Stream download — adds to global queue
    function startDl(btn, format) {
      btn.disabled = true;
      btn.innerHTML = checkIcon + ' Queued';
      let fn;
      try { const base = new URL(video.url).pathname.split('/').filter(Boolean).pop()?.replace(/\.m3u8.*$/, ''); fn = base ? base + (format === 'mp4' ? '.mp4' : '.ts') : 'video.' + format; } catch { fn = 'video.' + format; }
      chrome.runtime.sendMessage({ action: 'downloadStream', url: video.url, filename: fn, format });
    }
    const streamBtn = card.querySelector('.btn-download-stream');
    if (streamBtn) {
      streamBtn.addEventListener('click', (e) => { e.stopPropagation(); startDl(streamBtn, 'mp4'); });
    }
    const streamTsBtn = card.querySelector('.btn-download-stream-ts');
    if (streamTsBtn) {
      streamTsBtn.addEventListener('click', (e) => { e.stopPropagation(); startDl(streamTsBtn, 'ts'); });
    }

    // Direct download
    const dlBtn = card.querySelector('.btn-download');
    if (dlBtn) {
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dlBtn.disabled = true;
        dlBtn.innerHTML = dlIcon + ' Starting...';
        chrome.runtime.sendMessage({
          action: 'downloadVideo', url: video.url,
          filename: guessFilename(video.url, video.type), tabId: tab.id,
        }, (resp) => {
          dlBtn.innerHTML = resp?.ok ? (checkIcon + ' Done') : (dlIcon + ' Opened');
          setTimeout(() => { dlBtn.disabled = false; dlBtn.innerHTML = dlIcon + ` Download${sizeStr ? ' (' + sizeStr + ')' : ''}`; }, 3000);
        });
      });
    }

    // FFmpeg, Copy, Open
    const ffBtn = card.querySelector('.btn-ffmpeg');
    if (ffBtn) {
      ffBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(`ffmpeg -i "${video.url}" -c copy output.mp4`);
        ffBtn.classList.add('copied'); ffBtn.innerHTML = checkIcon;
        setTimeout(() => { ffBtn.classList.remove('copied'); ffBtn.innerHTML = ffmpegIcon; }, 2000);
      });
    }
    const copyBtn = card.querySelector('.btn-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(video.url);
        copyBtn.classList.add('copied'); copyBtn.innerHTML = checkIcon;
        setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.innerHTML = copyIcon; }, 1500);
      });
    }
    const openBtn = card.querySelector('.btn-open');
    if (openBtn) {
      openBtn.addEventListener('click', (e) => { e.stopPropagation(); chrome.tabs.create({ url: video.url }); });
    }

    return card;
  }

  // Metadata probe
  function probeVideoMetadata(url, captureFrame) {
    return new Promise((resolve) => {
      const result = { duration: null, thumbnail: null };
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous'; video.muted = true; video.preload = 'metadata';
      const timeout = setTimeout(() => { video.src = ''; resolve(result); }, 6000);
      video.addEventListener('loadedmetadata', () => {
        if (video.duration && isFinite(video.duration) && video.duration > 0) result.duration = video.duration;
        if (captureFrame) { video.currentTime = Math.min(1, video.duration * 0.1); }
        else { clearTimeout(timeout); video.src = ''; resolve(result); }
      });
      video.addEventListener('seeked', () => {
        clearTimeout(timeout);
        try { const c = document.createElement('canvas'); c.width = 320; c.height = 180; c.getContext('2d').drawImage(video, 0, 0, 320, 180); result.thumbnail = c.toDataURL('image/jpeg', 0.7); } catch {}
        video.src = ''; resolve(result);
      });
      video.addEventListener('error', () => { clearTimeout(timeout); resolve(result); });
      video.src = url;
    });
  }

  // Header buttons
  rescanBtn.addEventListener('click', () => {
    rescanBtn.classList.add('spinning');
    chrome.runtime.sendMessage({ action: 'rescanTab', tabId: tab.id }, (result) => {
      if (chrome.runtime.lastError) { rescanBtn.classList.remove('spinning'); return; }
      const delay = result?.method === 'injected' ? 1500 : 600;
      setTimeout(() => { loadVideos(); rescanBtn.classList.remove('spinning'); }, delay);
    });
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all detected videos? You can rescan to find them again.')) return;
    chrome.runtime.sendMessage({ action: 'clearVideos', tabId: tab.id }, () => renderVideos([]));
  });

  // Check if current tab is on a blocked domain
  const BLOCKED_DOMAINS = [
    'youtube.com', 'youtu.be', 'youtube-nocookie.com',
    'netflix.com', 'disneyplus.com', 'hulu.com',
    'primevideo.com', 'hbomax.com', 'max.com',
    'peacocktv.com', 'paramountplus.com',
    'crunchyroll.com', 'funimation.com',
    'spotify.com', 'music.apple.com', 'tv.apple.com',
  ];

  let isBlocked = false;
  try {
    const hostname = new URL(tab.url).hostname.toLowerCase();
    isBlocked = BLOCKED_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {}

  if (isBlocked) {
    blockedStateEl.classList.add('visible');
    videoListEl.style.display = 'none';
    videoCountEl.textContent = 'blocked';
    // Still show downloads queue even on blocked domains
    startDownloadPolling();
    return;
  }

  // Initial load — show scanning state, then swap to results
  let hasAutoRescanned = false;
  emptyStateEl.classList.add('visible');
  emptyTitleEl.textContent = 'Detecting videos...';
  emptySubtitleEl.textContent = '';

  chrome.runtime.sendMessage({ action: 'getVideos', tabId: tab.id }, (response) => {
    if (chrome.runtime.lastError || !response) {
      showEmptyState('No videos detected', 'Browse a page with video content — detection is automatic.');
      return;
    }
    if (response.videos.length === 0 && !hasAutoRescanned) {
      hasAutoRescanned = true;
      chrome.runtime.sendMessage({ action: 'rescanTab', tabId: tab.id }, () => {
        setTimeout(() => {
          loadVideos(() => {
            // If still empty after first try, wait longer and try once more
            chrome.runtime.sendMessage({ action: 'getVideos', tabId: tab.id }, (r2) => {
              if (r2?.videos?.length === 0) {
                setTimeout(() => loadVideos(), 2000);
              }
            });
          });
        }, 1500);
      });
    } else {
      renderVideos(response.videos);
    }
  });

  // Start polling the global download queue
  startDownloadPolling();
});
