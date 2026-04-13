// popup.js — Renders detected videos with thumbnails, download, and open actions

document.addEventListener('DOMContentLoaded', async () => {
  const videoListEl = document.getElementById('videoList');
  const emptyStateEl = document.getElementById('emptyState');
  const videoCountEl = document.getElementById('videoCount');
  const pageUrlEl = document.getElementById('pageUrl');
  const clearBtn = document.getElementById('clearBtn');
  const rescanBtn = document.getElementById('rescanBtn');

  // Reusable SVG strings
  const dlIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const checkIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const cancelIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const ffmpegIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 6.5h6M4 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  const copyIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M9.5 4.5V2.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" stroke="currentColor" stroke-width="1.2"/></svg>`;

  // Track active polling intervals so we can clean up
  const activePollers = [];

  // Keep service worker alive while popup is open
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

  // --- Utility functions ---

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

  // --- Rendering ---

  function loadVideos(callback) {
    chrome.runtime.sendMessage({ action: 'getVideos', tabId: tab.id }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      renderVideos(response.videos);
      if (callback) callback();
    });
  }

  function renderVideos(videos) {
    // Stop any existing pollers
    activePollers.forEach((id) => clearInterval(id));
    activePollers.length = 0;
    videoListEl.innerHTML = '';

    if (!videos?.length) {
      emptyStateEl.classList.add('visible');
      videoListEl.style.display = 'none';
      videoCountEl.textContent = '0 videos';
      return;
    }

    emptyStateEl.classList.remove('visible');
    videoListEl.style.display = 'block';
    videoCountEl.textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''}`;

    videos.sort((a, b) => {
      const priority = { 'HLS (M3U8)': 0, 'DASH (MPD)': 1, MP4: 2, WebM: 3, FLV: 4 };
      const pa = priority[a.type] ?? 5;
      const pb = priority[b.type] ?? 5;
      if (pa !== pb) return pa - pb;
      if (a.size && b.size) return b.size - a.size;
      return b.timestamp - a.timestamp;
    });

    videos.forEach((v) => videoListEl.appendChild(createVideoCard(v)));
  }

  // --- Card creation ---

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
        <button class="btn-action btn-download-stream" title="Download full stream as video file">${dlIcon} Download</button>
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

    // --- Probe metadata for direct videos ---
    if (!isStreamType && (!video.thumbnail || !durationStr)) {
      probeVideoMetadata(video.url, !video.thumbnail).then((meta) => {
        if (meta.thumbnail && !video.thumbnail) {
          const ph = card.querySelector('.thumb-placeholder');
          if (ph) {
            const img = document.createElement('img');
            img.src = meta.thumbnail;
            img.alt = '';
            ph.parentNode.replaceChild(img, ph);
          }
        }
        if (meta.duration) {
          const dur = formatDuration(meta.duration);
          if (dur) {
            let overlay = card.querySelector('.thumb-duration');
            if (!overlay) {
              overlay = document.createElement('span');
              overlay.className = 'thumb-duration';
              card.querySelector('.card-thumbnail').appendChild(overlay);
            }
            overlay.textContent = dur;
            const metaRow = card.querySelector('.card-meta');
            if (metaRow && !metaRow.querySelector('.duration-tag')) {
              const tag = document.createElement('span');
              tag.className = 'source-tag duration-tag';
              tag.textContent = dur;
              metaRow.insertBefore(tag, metaRow.querySelector('.stream-tag'));
            }
          }
        }
      });
    }

    // --- Stream download button ---
    const streamBtn = card.querySelector('.btn-download-stream');
    if (streamBtn) {
      streamBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startStreamDownload(streamBtn, video.url);
      });
    }

    // --- Direct download button ---
    const dlBtn = card.querySelector('.btn-download');
    if (dlBtn) {
      const dlLabel = `Download${sizeStr ? ' (' + sizeStr + ')' : ''}`;
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dlBtn.disabled = true;
        dlBtn.classList.add('downloaded');
        dlBtn.innerHTML = dlIcon + ' Starting...';

        chrome.runtime.sendMessage({
          action: 'downloadVideo', url: video.url,
          filename: guessFilename(video.url, video.type), tabId: tab.id,
        }, (resp) => {
          dlBtn.innerHTML = resp?.ok ? (checkIcon + ' Downloading!') : (dlIcon + ' Opened in tab');
          if (!resp?.ok) { dlBtn.classList.remove('downloaded'); dlBtn.classList.add('download-failed'); }
          setTimeout(() => {
            dlBtn.disabled = false;
            dlBtn.classList.remove('downloaded', 'download-failed');
            dlBtn.innerHTML = dlIcon + ' ' + dlLabel;
          }, 3000);
        });
      });
    }

    // --- FFmpeg button ---
    const ffBtn = card.querySelector('.btn-ffmpeg');
    if (ffBtn) {
      ffBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(`ffmpeg -i "${video.url}" -c copy output.mp4`);
        ffBtn.classList.add('copied');
        ffBtn.innerHTML = checkIcon;
        setTimeout(() => { ffBtn.classList.remove('copied'); ffBtn.innerHTML = ffmpegIcon; }, 2000);
      });
    }

    // --- Copy + Open buttons ---
    const copyBtn = card.querySelector('.btn-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(video.url);
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = checkIcon;
        setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.innerHTML = copyIcon; }, 1500);
      });
    }
    const openBtn = card.querySelector('.btn-open');
    if (openBtn) {
      openBtn.addEventListener('click', (e) => { e.stopPropagation(); chrome.tabs.create({ url: video.url }); });
    }

    return card;
  }

  // --- Stream download + progress polling (per-URL) ---

  function startStreamDownload(btn, videoUrl) {
    btn.disabled = true;
    btn.classList.add('downloading');
    btn.innerHTML = dlIcon + ' 0%';

    // Insert cancel button after the download button
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-action btn-cancel';
    cancelBtn.title = 'Cancel download';
    cancelBtn.innerHTML = cancelIcon;
    btn.parentNode.insertBefore(cancelBtn, btn.nextSibling);

    let cancelled = false;

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelled = true;
      chrome.runtime.sendMessage({ action: 'cancelDownload', url: videoUrl });
      cancelBtn.remove();
      btn.classList.remove('downloading');
      btn.classList.add('download-failed');
      btn.innerHTML = dlIcon + ' Cancelled';
      btn.disabled = true;
      setTimeout(() => resetBtn(btn), 3000);
    });

    // Poll progress for THIS specific URL
    const pollId = setInterval(() => {
      chrome.runtime.sendMessage({ action: 'getDownloadProgress', url: videoUrl }, (prog) => {
        if (chrome.runtime.lastError || !prog) return;
        if (prog.state === 'downloading') {
          const info = prog.segsTotal ? ` (${prog.segsDone}/${prog.segsTotal})` : '';
          btn.innerHTML = dlIcon + ` ${prog.percent}%${info}`;
        }
      });
    }, 500);
    activePollers.push(pollId);

    chrome.runtime.sendMessage({ action: 'downloadStream', url: videoUrl, tabId: tab.id }, (resp) => {
      clearInterval(pollId);
      cancelBtn.remove();
      if (cancelled) return;
      if (resp?.ok) {
        btn.classList.remove('downloading');
        btn.classList.add('downloaded');
        btn.innerHTML = checkIcon + ' Done!';
        setTimeout(() => resetBtn(btn), 5000);
      } else {
        btn.classList.remove('downloading');
        btn.classList.add('download-failed');
        btn.innerHTML = dlIcon + ' Failed';
        btn.title = resp?.error || 'Download failed';
        setTimeout(() => resetBtn(btn), 5000);
      }
    });
  }

  function resetBtn(btn) {
    btn.disabled = false;
    btn.classList.remove('downloaded', 'download-failed', 'downloading');
    btn.innerHTML = dlIcon + ' Download';
    btn.title = 'Download full stream as video file';
  }

  // --- Resume active downloads on popup open ---
  // Queries ALL active downloads and matches them to rendered cards by URL

  function resumeActiveDownloads() {
    chrome.runtime.sendMessage({ action: 'getDownloadProgress' }, (allDownloads) => {
      if (chrome.runtime.lastError || !allDownloads) return;

      for (const [url, prog] of Object.entries(allDownloads)) {
        // Find card with this URL
        const card = videoListEl.querySelector(`.video-card[data-url="${CSS.escape(url)}"]`);
        if (!card) continue;

        const btn = card.querySelector('.btn-download-stream');
        if (!btn) continue;

        if (prog.state === 'downloading') {
          btn.disabled = true;
          btn.classList.add('downloading');
          const info = prog.segsTotal ? ` (${prog.segsDone}/${prog.segsTotal})` : '';
          btn.innerHTML = dlIcon + ` ${prog.percent}%${info}`;

          // Add cancel button
          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'btn-action btn-cancel';
          cancelBtn.title = 'Cancel download';
          cancelBtn.innerHTML = cancelIcon;
          btn.parentNode.insertBefore(cancelBtn, btn.nextSibling);

          cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({ action: 'cancelDownload', url });
            cancelBtn.remove();
            btn.classList.remove('downloading');
            btn.classList.add('download-failed');
            btn.innerHTML = dlIcon + ' Cancelled';
            setTimeout(() => resetBtn(btn), 3000);
          });

          // Start polling for this URL
          const pollId = setInterval(() => {
            chrome.runtime.sendMessage({ action: 'getDownloadProgress', url }, (p) => {
              if (chrome.runtime.lastError || !p) { clearInterval(pollId); return; }
              if (p.state === 'downloading') {
                const i = p.segsTotal ? ` (${p.segsDone}/${p.segsTotal})` : '';
                btn.innerHTML = dlIcon + ` ${p.percent}%${i}`;
              } else if (p.state === 'done') {
                clearInterval(pollId);
                cancelBtn.remove();
                btn.classList.remove('downloading');
                btn.classList.add('downloaded');
                btn.innerHTML = checkIcon + ' Done!';
                setTimeout(() => resetBtn(btn), 5000);
              } else if (p.state === 'error') {
                clearInterval(pollId);
                cancelBtn.remove();
                btn.classList.remove('downloading');
                btn.classList.add('download-failed');
                btn.innerHTML = dlIcon + ' Failed';
                setTimeout(() => resetBtn(btn), 5000);
              }
            });
          }, 500);
          activePollers.push(pollId);

        } else if (prog.state === 'done') {
          btn.disabled = true;
          btn.classList.add('downloaded');
          btn.innerHTML = checkIcon + ' Done!';
          setTimeout(() => resetBtn(btn), 5000);

        } else if (prog.state === 'error') {
          btn.classList.add('download-failed');
          btn.innerHTML = dlIcon + ' Failed';
          setTimeout(() => resetBtn(btn), 5000);
        }
      }
    });
  }

  // --- Metadata probe ---

  function probeVideoMetadata(url, captureFrame) {
    return new Promise((resolve) => {
      const result = { duration: null, thumbnail: null };
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'metadata';

      const timeout = setTimeout(() => { video.src = ''; resolve(result); }, 6000);

      video.addEventListener('loadedmetadata', () => {
        if (video.duration && isFinite(video.duration) && video.duration > 0) {
          result.duration = video.duration;
        }
        if (captureFrame) {
          video.currentTime = Math.min(1, video.duration * 0.1);
        } else {
          clearTimeout(timeout); video.src = ''; resolve(result);
        }
      });

      video.addEventListener('seeked', () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320; canvas.height = 180;
          canvas.getContext('2d').drawImage(video, 0, 0, 320, 180);
          result.thumbnail = canvas.toDataURL('image/jpeg', 0.7);
        } catch {}
        video.src = ''; resolve(result);
      });

      video.addEventListener('error', () => { clearTimeout(timeout); resolve(result); });
      video.src = url;
    });
  }

  // --- Header buttons ---

  rescanBtn.addEventListener('click', () => {
    rescanBtn.classList.add('spinning');
    chrome.runtime.sendMessage({ action: 'rescanTab', tabId: tab.id }, (result) => {
      if (chrome.runtime.lastError) { rescanBtn.classList.remove('spinning'); return; }
      const delay = result?.method === 'injected' ? 1500 : 600;
      setTimeout(() => {
        loadVideos(() => resumeActiveDownloads());
        rescanBtn.classList.remove('spinning');
      }, delay);
    });
  });

  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearVideos', tabId: tab.id }, () => renderVideos([]));
  });

  // --- Initial load ---

  let hasAutoRescanned = false;
  chrome.runtime.sendMessage({ action: 'getVideos', tabId: tab.id }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    if (response.videos.length === 0 && !hasAutoRescanned) {
      hasAutoRescanned = true;
      chrome.runtime.sendMessage({ action: 'rescanTab', tabId: tab.id }, () => {
        setTimeout(() => loadVideos(() => resumeActiveDownloads()), 1000);
      });
    } else {
      renderVideos(response.videos);
      resumeActiveDownloads();
    }
  });
});
