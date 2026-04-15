function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!request || request.action !== 'fetchImageAsDataUrl' || !request.url) {
    return false;
  }

  console.log(`[SpachBob][BG] Received image fetch request: ${request.url}`);

  (async () => {
    try {
      const response = await fetch(request.url);
      if (!response.ok) {
        throw new Error(`Image fetch failed: ${response.status}`);
      }

      const mimeType = response.headers.get('content-type') || 'application/octet-stream';
      const buffer = await response.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const dataUrl = `data:${mimeType};base64,${base64}`;

      console.log(
        `[SpachBob][BG] Image fetch success: ${request.url} (${buffer.byteLength} bytes, ${mimeType})`
      );

      sendResponse({
        success: true,
        dataUrl,
        mimeType
      });
    } catch (error) {
      console.error(`[SpachBob][BG] Image fetch failed: ${request.url}`, error);
      sendResponse({ success: false, error: error.message || String(error) });
    }
  })();

  return true;
});
