(async () => {
  const params = new URLSearchParams(location.search);
  const cacheUrl = params.get('cache');
  const filename = params.get('name') || 'video.ts';
  const status = document.getElementById('status');
  const detail = document.getElementById('detail');

  if (!cacheUrl) {
    status.textContent = 'Error: no cache key provided';
    status.style.color = '#E17055';
    return;
  }

  try {
    detail.textContent = 'Opening cache...';
    const cache = await caches.open('hls-downloads');

    detail.textContent = 'Reading cached data...';
    const resp = await cache.match(cacheUrl);

    if (!resp) {
      const keys = await cache.keys();
      console.log('Cache keys:', keys.map(r => r.url));
      console.log('Looking for:', cacheUrl);
      throw new Error('No data in cache. Keys found: ' + keys.length);
    }

    detail.textContent = 'Converting to blob...';
    const blob = await resp.blob();
    detail.textContent = 'Blob ready: ' + (blob.size / 1024 / 1024).toFixed(1) + ' MB';

    await cache.delete(cacheUrl);

    status.textContent = 'Starting download...';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    status.textContent = 'Download started!';
    detail.textContent = 'You can close this tab.';
    document.getElementById('spinner').style.display = 'none';
    setTimeout(() => { URL.revokeObjectURL(url); window.close(); }, 5000);
  } catch (e) {
    console.error('Save page error:', e);
    status.textContent = 'Error: ' + e.message;
    status.style.color = '#E17055';
    document.getElementById('spinner').style.display = 'none';
  }
})();
