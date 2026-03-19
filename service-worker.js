/* Minimal service worker:
   - enables basic offline caching
   - blocks navigations that redirect to/through "securly"
*/

const CACHE_NAME = 'simple-pwa-cache-v1';
const SECURLY = 'securly';

const ASSETS_TO_CACHE = ['./index.html', './manifest.json', './icon-192.svg', './icon-512.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .catch((err) => console.warn('Cache install failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function isSameOrigin(request) {
  try {
    const u = new URL(request.url);
    return u.origin === self.location.origin;
  } catch {
    return false;
  }
}

function isSecurlyUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().includes(SECURLY);
  } catch {
    return false;
  }
}

function blockedResponseForNavigation() {
  const body = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Redirect blocked</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b1220;color:#e5e7eb;padding:24px;">
    <h1 style="margin-top:0">Redirect blocked</h1>
    <p>Redirects involving <code>${SECURLY}</code> are blocked.</p>
    </body></html>`;
  return new Response(body, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function blockedResponseGeneric() {
  return new Response(`Redirect blocked: redirects involving "${SECURLY}"`, {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  });
}

async function applyRedirectBlocking(request, response) {
  const requestUrl = request?.url ?? '';
  const finalUrl = response?.url ?? '';

  const requestIsSecurly = isSecurlyUrl(requestUrl);
  const finalIsSecurly = isSecurlyUrl(finalUrl);
  const redirected = Boolean(response?.redirected);

  // Interpretation of "blocks all redirects from securly":
  // - if the request went to securly and the browser followed a redirect, block
  // - if the final redirected URL is securly, block
  if ((requestIsSecurly && redirected) || finalIsSecurly) {
    if (request.mode === 'navigate') return blockedResponseForNavigation();
    return blockedResponseGeneric();
  }

  return response;
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const res = await fetch(request);
  // Best-effort cache. If it can't be cached, that's okay.
  try {
    if (res && res.ok) cache.put(request, res.clone());
  } catch {}
  return res;
}

async function networkWithRedirectBlocking(request) {
  const response = await fetch(request);
  return applyRedirectBlocking(request, response);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only handle GET/navigation. Let the browser deal with other methods.
  if (request.method !== 'GET') return;

  const url = request.url;
  const isNavigation = request.mode === 'navigate';
  const sameOrigin = isSameOrigin(request);

  // Block any request that is itself securly even if it doesn't redirect.
  // (Helps prevent "redirect chains" being missed.)
  if (isSecurlyUrl(url)) {
    event.respondWith(isNavigation ? blockedResponseForNavigation() : blockedResponseGeneric());
    return;
  }

  event.respondWith(
    (async () => {
      try {
        if (sameOrigin && !isNavigation) {
          // Assets: cache-first.
          return cacheFirst(request).then((res) => applyRedirectBlocking(request, res));
        }

        // Navigations & cross-origin: network-first + redirect blocking.
        return networkWithRedirectBlocking(request).catch(async () => {
          // Offline fallback for navigations.
          if (isNavigation) {
            const cache = await caches.open(CACHE_NAME);
            return cache.match('./index.html');
          }
          throw new Error('Network failed');
        });
      } catch (err) {
        if (isNavigation) {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match('./index.html')) || blockedResponseForNavigation();
        }
        throw err;
      }
    })()
  );
});

