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
    pageUrlEl.textContent = tab.url || '';
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

    // Sort: streams first (M3U8 > DASH), then direct files by size desc
    videos.sort((a, b) => {
      const priority = { 'HLS (M3U8)': 0, 'DASH (MPD)': 1, MP4: 2, WebM: 3, FLV: 4 };
      const pa = priority[a.type] ?? 5;
      const pb = priority[b.type] ?? 5;
      if (pa !== pb) return pa - pb;
      // Larger files first within same type
      if (a.size && b.size) return b.size - a.size;
      return b.timestamp - a.timestamp;
    });

    videos.forEach((video) => {
      videoListEl.appendChild(createVideoCard(video));
    });
  }

  function getBadgeClass(type) {
    if (type.includes('M3U8') || type.includes('HLS')) return 'hls';
    if (type.includes('DASH') || type.includes('MPD')) return 'dash';
    if (type.includes('MP4')) return 'mp4';
    if (type.includes('WebM')) return 'webm';
    if (type.includes('FLV')) return 'flv';
    return 'other';
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return null;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
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
    const sizeStr = formatSize(video.size);
    const durationStr = formatDuration(video.duration);
    const isStreamType = video.isStream;

    const thumbHtml = video.thumbnail
      ? `<img src="${escapeAttr(video.thumbnail)}" alt="" loading="lazy">`
      : `<div class="thumb-placeholder">
           <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
             <path d="M15 10L30 20L15 30V10Z" fill="white"/>
           </svg>
         </div>`;

    // Overlays on thumbnail
    let thumbOverlays = '';
    if (durationStr) {
      thumbOverlays += `<span class="thumb-duration">${escapeHtml(durationStr)}</span>`;
    }

    // Build meta tags
    let metaHtml = `<span class="source-tag">${escapeHtml(video.source)}</span>`;
    if (durationStr) {
      metaHtml += `<span class="source-tag duration-tag">${escapeHtml(durationStr)}</span>`;
    }
    if (sizeStr) {
      metaHtml += `<span class="source-tag size-tag">${escapeHtml(sizeStr)}</span>`;
    }
    if (isStreamType) {
      metaHtml += `<span class="source-tag stream-tag">STREAM</span>`;
    }

    // Different actions for streams vs direct files
    let actionsHtml;
    if (isStreamType) {
      actionsHtml = `
        <button class="btn-action btn-download-stream" title="Download full stream as video file">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Download
        </button>
        <button class="btn-action btn-ffmpeg" title="Copy FFmpeg command">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M4 6.5h6M4 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="btn-action btn-copy" title="Copy URL">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M9.5 4.5V2.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        </button>
        <button class="btn-action btn-open" title="Open in new tab">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M6 2H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8M8 2h4v4M7 7l5-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      `;
    } else {
      actionsHtml = `
        <button class="btn-action btn-download" title="Download file">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Download${sizeStr ? ' (' + sizeStr + ')' : ''}
        </button>
        <button class="btn-action btn-open" title="Open in new tab">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M6 2H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8M8 2h4v4M7 7l5-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="btn-action btn-copy" title="Copy URL">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M9.5 4.5V2.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        </button>
      `;
    }

    card.innerHTML = `
      <div class="card-thumbnail">
        ${thumbHtml}
        <span class="thumb-badge type-badge ${badgeClass}">${escapeHtml(video.type)}</span>
        ${thumbOverlays}
      </div>
      <div class="card-info">
        <div class="video-url" title="${escapeAttr(video.url)}">${escapeHtml(video.url)}</div>
        <div class="card-meta">${metaHtml}</div>
      </div>
      <div class="card-actions">${actionsHtml}</div>
    `;

    // --- Probe metadata for direct video URLs (thumbnail + duration) ---
    if (!isStreamType) {
      const needsThumb = !video.thumbnail;
      const needsDuration = !durationStr;

      if (needsThumb || needsDuration) {
        probeVideoMetadata(video.url, needsThumb).then((meta) => {
          // Update thumbnail
          if (meta.thumbnail && needsThumb) {
            const thumbContainer = card.querySelector('.card-thumbnail');
            const placeholder = thumbContainer.querySelector('.thumb-placeholder');
            if (placeholder) {
              const img = document.createElement('img');
              img.src = meta.thumbnail;
              img.alt = '';
              thumbContainer.replaceChild(img, placeholder);
            }
          }
          // Update duration
          if (meta.duration) {
            const durStr = formatDuration(meta.duration);
            if (durStr) {
              // Add duration overlay on thumbnail
              let durOverlay = card.querySelector('.thumb-duration');
              if (!durOverlay) {
                durOverlay = document.createElement('span');
                durOverlay.className = 'thumb-duration';
                card.querySelector('.card-thumbnail').appendChild(durOverlay);
              }
              durOverlay.textContent = durStr;

              // Add duration tag in meta row
              const metaRow = card.querySelector('.card-meta');
              if (metaRow && !metaRow.querySelector('.duration-tag')) {
                const tag = document.createElement('span');
                tag.className = 'source-tag duration-tag';
                tag.textContent = durStr;
                metaRow.insertBefore(tag, metaRow.querySelector('.stream-tag'));
              }
            }
          }
        });
      }
    }

    // --- Event listeners ---

    // Download stream (HLS/DASH)
    const streamDlBtn = card.querySelector('.btn-download-stream');
    if (streamDlBtn) {
      streamDlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        streamDlBtn.classList.add('downloaded');
        streamDlBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Fetching...
        `;

        chrome.runtime.sendMessage({
          action: 'downloadStream',
          url: video.url,
          tabId: tab.id,
        }, (resp) => {
          if (resp?.ok) {
            streamDlBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Downloading!
            `;
          } else {
            streamDlBtn.classList.remove('downloaded');
            streamDlBtn.classList.add('download-failed');
            streamDlBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Failed
            `;
          }
          setTimeout(() => {
            streamDlBtn.classList.remove('downloaded', 'download-failed');
            streamDlBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Download
            `;
          }, 4000);
        });
      });
    }

    // Download (direct files only)
    const dlBtn = card.querySelector('.btn-download');
    if (dlBtn) {
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const filename = guessFilename(video.url, video.type);

        dlBtn.classList.add('downloaded');
        dlBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Starting...
        `;

        chrome.runtime.sendMessage({
          action: 'downloadVideo',
          url: video.url,
          filename,
          tabId: tab.id,
        }, (resp) => {
          if (resp?.ok) {
            dlBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Downloading!
            `;
          } else {
            dlBtn.classList.remove('downloaded');
            dlBtn.classList.add('download-failed');
            dlBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M6 2H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8M8 2h4v4M7 7l5-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Opened in tab
            `;
          }
          setTimeout(() => {
            dlBtn.classList.remove('downloaded', 'download-failed');
            dlBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 1v8.5M3.5 6.5L7 10l3.5-3.5M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Download${sizeStr ? ' (' + sizeStr + ')' : ''}
            `;
          }, 3000);
        });
      });
    }

    // Copy FFmpeg command (streams only)
    const ffmpegBtn = card.querySelector('.btn-ffmpeg');
    if (ffmpegBtn) {
      ffmpegBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cmd = `ffmpeg -i "${video.url}" -c copy output.mp4`;
        navigator.clipboard.writeText(cmd);
        ffmpegBtn.classList.add('copied');
        ffmpegBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Copied!
        `;
        setTimeout(() => {
          ffmpegBtn.classList.remove('copied');
          ffmpegBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
              <path d="M4 6.5h6M4 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            Copy FFmpeg
          `;
        }, 2000);
      });
    }

    // Open in new tab
    const openBtn = card.querySelector('.btn-open');
    if (openBtn) {
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.create({ url: video.url });
      });
    }

    // Copy URL
    const copyBtn = card.querySelector('.btn-copy');
    if (copyBtn) copyBtn.addEventListener('click', (e) => {
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

  // Probe a video URL for duration and optionally a frame thumbnail
  // Only downloads metadata (~first few KB), not the whole file
  function probeVideoMetadata(url, captureFrame) {
    return new Promise((resolve) => {
      const result = { duration: null, thumbnail: null };
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'metadata';

      const timeout = setTimeout(() => {
        video.src = '';
        resolve(result);
      }, 6000);

      video.addEventListener('loadedmetadata', () => {
        // Duration is available as soon as metadata loads
        if (video.duration && isFinite(video.duration) && video.duration > 0) {
          result.duration = video.duration;
        }

        if (captureFrame) {
          // Seek to get a frame for thumbnail
          video.currentTime = Math.min(1, video.duration * 0.1);
        } else {
          // No frame needed, we're done
          clearTimeout(timeout);
          video.src = '';
          resolve(result);
        }
      });

      video.addEventListener('seeked', () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          result.thumbnail = canvas.toDataURL('image/jpeg', 0.7);
        } catch {
          // CORS blocked frame capture — that's fine
        }
        video.src = '';
        resolve(result);
      });

      video.addEventListener('error', () => {
        clearTimeout(timeout);
        resolve(result);
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

  // Rescan — goes through background for fallback injection
  rescanBtn.addEventListener('click', () => {
    rescanBtn.classList.add('spinning');
    chrome.runtime.sendMessage({ action: 'rescanTab', tabId: tab.id }, (result) => {
      if (chrome.runtime.lastError) {
        rescanBtn.classList.remove('spinning');
        return;
      }
      // Wait for detections to arrive, then reload
      const delay = result?.method === 'injected' ? 1500 : 600;
      setTimeout(() => {
        loadVideos();
        rescanBtn.classList.remove('spinning');
      }, delay);
    });
  });

  // Clear
  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearVideos', tabId: tab.id }, () => {
      renderVideos([]);
    });
  });

  // Initial load — if 0 videos found, auto-rescan once
  let hasAutoRescanned = false;
  function initialLoad() {
    chrome.runtime.sendMessage({ action: 'getVideos', tabId: tab.id }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      if (response.videos.length === 0 && !hasAutoRescanned) {
        hasAutoRescanned = true;
        // Auto-rescan: inject content script and scan
        chrome.runtime.sendMessage({ action: 'rescanTab', tabId: tab.id }, () => {
          setTimeout(() => loadVideos(), 1000);
        });
      } else {
        renderVideos(response.videos);
      }
    });
  }
  initialLoad();
});
