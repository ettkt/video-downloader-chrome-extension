// popup.js — Renders detected videos and handles user actions

document.addEventListener('DOMContentLoaded', async () => {
  const videoListEl = document.getElementById('videoList');
  const emptyStateEl = document.getElementById('emptyState');
  const videoCountEl = document.getElementById('videoCount');
  const pageUrlEl = document.getElementById('pageUrl');
  const clearBtn = document.getElementById('clearBtn');

  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Show current page URL in footer
  try {
    const url = new URL(tab.url);
    pageUrlEl.textContent = url.hostname + url.pathname;
    pageUrlEl.title = tab.url;
  } catch {
    pageUrlEl.textContent = tab.url;
  }

  // Fetch detected videos from background
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

    // Sort: M3U8/DASH first, then by timestamp
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

  function truncateUrl(url, maxLen = 80) {
    if (url.length <= maxLen) return url;
    return url.slice(0, maxLen - 3) + '...';
  }

  function createVideoCard(video) {
    const card = document.createElement('div');
    card.className = 'video-card';

    const badgeClass = getBadgeClass(video.type);

    card.innerHTML = `
      <span class="type-badge ${badgeClass}">${escapeHtml(video.type)}</span>
      <div class="card-body">
        <div class="video-url" title="${escapeHtml(video.url)}">${escapeHtml(truncateUrl(video.url))}</div>
        <div class="card-meta">
          <span class="source-tag">${escapeHtml(video.source)}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-action copy-btn" title="Copy URL">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M9.5 4.5V2.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        </button>
        <button class="btn-action open-btn" title="Open in new tab">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M6 2H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8M8 2h4v4M7 7l5-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    `;

    // Copy URL
    card.querySelector('.copy-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(video.url);
      const btn = card.querySelector('.copy-btn');
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

    // Open URL in new tab
    card.querySelector('.open-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: video.url });
    });

    return card;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Clear all detections
  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearVideos', tabId: tab.id }, () => {
      renderVideos([]);
    });
  });

  // Initial load
  loadVideos();
});
