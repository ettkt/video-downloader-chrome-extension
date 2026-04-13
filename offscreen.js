// offscreen.js — Handles blob download saving (service workers can't reliably use blob URLs)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'saveBlob') {
    handleSaveBlob(message.cacheKey, message.filename)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

async function handleSaveBlob(cacheKey, filename) {
  const cache = await caches.open('hls-downloads');
  const request = new Request(cacheKey);
  const response = await cache.match(request);
  if (!response) throw new Error('No cached data found');

  const blob = await response.blob();
  await cache.delete(request);

  // Offscreen document has full DOM — blob URLs work here
  const blobUrl = URL.createObjectURL(blob);

  // Trigger download via anchor click
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Clean up after a delay
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

  return { ok: true };
}
