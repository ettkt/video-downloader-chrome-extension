// popup.js — Renders detected videos with thumbnails, download, and open actions

document.addEventListener('DOMContentLoaded', async () => {
  const videoListEl = document.getElementById('videoList');
  const emptyStateEl = document.getElementById('emptyState');
  const videoCountEl = document.getElementById('videoCount');
  const pageUrlEl = document.getElementById('pageUrl');
  const clearBtn = document.getElementById('clearBtn');
  const rescanBtn = document.getElementById('rescanBtn');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  try {
    const url = new URL(tab.url);
    pageUrlEl.textContent = url.hostname + url.pathname;
    pageUrlEl.title = tab.url;
  } catch {
    pageUrlEl.textContent = tab.url;
  }

  function loadVideos() {
    chrome.runtime.sendMessage({ action: 'getVideos', tabId: tab.id }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      renderVideos(response.videos);
    });
  }

  function renderVideos(videos) {
    videoListEl.innerHTML = '';

    if (!videos || videos.length === 0) {
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
      return b.timestamp - a.timestamp;
    });

    videos.forEach((video) => {
      const card = createVideoCard(video);
      videoListEl.appendChild(card);
    });
  }

  function getBadgeClass(type) {
    if (type.includes('M3U8') || type.includes('HLS')) return 'hls';
    if (type.includes('DASH') || type.includes('MPD')) return 'dash';
    if (type.includes('MP4')) return 'mp4';
    if (type.includes('WebM')) return 'webm';
    if (type.includes('FLV')) return 'flv';
    if (type.includes('TS')) return 'ts';
    return 'other';
  }

  function guessFilename(url, type) {
    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && last.includes('.')) return decodeURIComponent(last);
    } catch {}

    const ext = { 'HLS (M3U8)': 'm3u8', 'DASH (MPD)': 'mpd', MP4: 'mp4', WebM: 'webm', FLV: 'flv' };
    return `video.${ext[type] || 'mp4'}`;
  }

  function createVideoCard(video) {
    const card = document.createElement('div');
    card.className = 'video-card';

    const badgeClass = getBadgeClass(video.type);
    const thumbHtml = video.thumbnail
      ? `<img src="${escapeAttr(video.thumbnail)}" alt="" loading="lazy">`
      : `<div class="thumb-placeholder">
           <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
             <path d="M15 10L30 20L15 30V10Z" fill="white"/>
           </svg>
         </div>`;

    card.innerHTML = `
      <div class="card-thumbnail">
        ${thumbHtml}
        <span class="thumb-badge type-badge ${badgeClass}">${escapeHtml(video.type)}</span>
      </div>
      <div class="card-info">
        <div class="video-url" title="${escapeAttr(video.url)}">${escapeHtml(video.url)}</div>
        <div class="card-meta">
          <span class="source-tag">${escapeHtml(video.source)}</span>
          <span class="source-tag">${escapeHtml(guessFilename(video.url, video.type))}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-action btn-download" title="Download video">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Download
        </button>
        <button class="btn-action btn-open" title="Open in new tab">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M6 2H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8M8 2h4v4M7 7l5-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Open
        </button>
        <button class="btn-action btn-copy" title="Copy URL">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M9.5 4.5V2.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        </button>
      </div>
    `;

    // --- Thumbnail: try to generate frame for direct video URLs ---
    if (!video.thumbnail && (video.type === 'MP4' || video.type === 'WebM')) {
      generateFrameThumbnail(video.url).then((dataUrl) => {
        if (dataUrl) {
          const thumbContainer = card.querySelector('.card-thumbnail');
          const placeholder = thumbContainer.querySelector('.thumb-placeholder');
          if (placeholder) {
            const img = document.createElement('img');
            img.src = dataUrl;
            img.alt = '';
            thumbContainer.replaceChild(img, placeholder);
          }
        }
      });
    }

    // Download
    card.querySelector('.btn-download').addEventListener('click', (e) => {
      e.stopPropagation();
      const filename = guessFilename(video.url, video.type);
      chrome.runtime.sendMessage({ action: 'downloadVideo', url: video.url, filename });
      const btn = card.querySelector('.btn-download');
      btn.classList.add('downloaded');
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Downloaded
      `;
      setTimeout(() => {
        btn.classList.remove('downloaded');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Download
        `;
      }, 2000);
    });

    // Open in new tab
    card.querySelector('.btn-open').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: video.url });
    });

    // Copy URL
    card.querySelector('.btn-copy').addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(video.url);
      const btn = card.querySelector('.btn-copy');
      btn.classList.add('copied');
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M9.5 4.5V2.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        `;
      }, 1500);
    });

    return card;
  }

  // Generate a thumbnail by loading a video frame in a hidden <video> element
  function generateFrameThumbnail(url) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'metadata';

      const timeout = setTimeout(() => {
        video.src = '';
        resolve(null);
      }, 4000);

      video.addEventListener('loadeddata', () => {
        // Seek to 1 second or 10% of duration, whichever is smaller
        video.currentTime = Math.min(1, video.duration * 0.1);
      });

      video.addEventListener('seeked', () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          video.src = '';
          resolve(dataUrl);
        } catch {
          video.src = '';
          resolve(null);
        }
      });

      video.addEventListener('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });

      video.src = url;
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Rescan — ask content script to re-scan DOM + source, then reload list
  rescanBtn.addEventListener('click', () => {
    rescanBtn.classList.add('spinning');
    chrome.tabs.sendMessage(tab.id, { action: 'rescan' }, () => {
      // Small delay to let new detections arrive at background
      setTimeout(() => {
        loadVideos();
        rescanBtn.classList.remove('spinning');
      }, 500);
    });
  });

  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearVideos', tabId: tab.id }, () => {
      renderVideos([]);
    });
  });

  loadVideos();
});
