function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function headersToObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, key) => {
    out[String(key || '').toLowerCase()] = String(value || '');
  });
  return out;
}

function parsePositiveTimeoutMs(value, fallbackMs) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return Math.max(1000, Math.floor(n));
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!request || typeof request !== 'object') return false;

  if (request.action === 'fetchImageAsDataUrl' && request.url) {
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
  }

  if (request.action === 'proxyHttpRequest' && request.url) {
    const method = String(request.method || 'GET').toUpperCase();
    const headers = (request.headers && typeof request.headers === 'object') ? request.headers : {};
    const body = typeof request.body === 'string' ? request.body : undefined;
    const timeoutMs = parsePositiveTimeoutMs(request.timeoutMs, 45000);

    console.log(`[SpachBob][BG] Proxy HTTP request: ${method} ${request.url} timeout=${timeoutMs}ms`);

    (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort(new Error(`Proxy request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const response = await fetch(request.url, { method, headers, body, signal: controller.signal });
        const bodyText = await response.text();
        clearTimeout(timeoutId);

        console.log(`[SpachBob][BG] Proxy HTTP response: ${method} ${request.url} status=${response.status}`);

        sendResponse({
          success: true,
          status: response.status,
          statusText: response.statusText || '',
          headers: headersToObject(response.headers),
          bodyText
        });
      } catch (error) {
        clearTimeout(timeoutId);
        console.error(`[SpachBob][BG] Proxy HTTP failed: ${method} ${request.url}`, error);
        sendResponse({ success: false, error: error.message || String(error) });
      }
    })();

    return true;
  }

  return false;
});
