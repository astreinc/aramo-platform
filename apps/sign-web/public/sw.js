/*
 * SIGN-FREE-PARITY-1 S8 — the Aramo Sign web app's service worker (installable app).
 *
 * Custody rule: this worker caches ONLY static build files — the hashed JS/CSS under
 * /assets/, the self-hosted fonts, the app icons and its own offline page. It never
 * caches, and never even answers, an API call (/v1/*), a sign-in route (/auth/*), a
 * document, an envelope or a signed copy, nor any guest page (/s/*, /d/*, /c/*,
 * /qes/callback, /?token=): those go straight to the network as if no worker existed.
 *
 * Page loads inside the signed-in workspace go to the network first. With no network
 * the worker shows a plain "You're offline" page — never an earlier copy of a page.
 *
 * Registered only by production builds of the workspace entry (src/workspace/pwa.ts).
 * To retire it, ship a sw.js that calls self.registration.unregister().
 */
'use strict';

var CACHE_VERSION = 'v1';
var STATIC_CACHE = 'aramo-sign-static-' + CACHE_VERSION;
var OFFLINE_URL = '/offline.html';
var PRECACHE = [OFFLINE_URL, '/icons/icon-192.png'];

/**
 * Decide what the worker does with one request. Pure: the URL, the method and the
 * request mode only.
 *   'static'   — a static build file: answer from the cache, else fetch and keep it.
 *   'navigate' — a workspace page load: network first, the offline page if that fails.
 *   'bypass'   — everything else: the worker does not answer (plain network).
 * Anything not on the static allow-list is 'bypass', so new API paths are safe by default.
 */
function routeRequest(urlString, method, mode, origin) {
  var url;
  try {
    url = new URL(urlString);
  } catch (e) {
    return 'bypass';
  }
  if (method !== 'GET') return 'bypass';
  if (url.origin !== origin) return 'bypass';
  var path = url.pathname;

  // Never answered: API, sign-in, platform files, and every guest (token) page.
  if (path.indexOf('/v1/') === 0 || path === '/v1') return 'bypass';
  if (path.indexOf('/auth/') === 0 || path === '/auth') return 'bypass';
  if (path.indexOf('/.well-known/') === 0) return 'bypass';
  if (path.indexOf('/s/') === 0 || path.indexOf('/d/') === 0 || path.indexOf('/c/') === 0) return 'bypass';
  if (path === '/qes/callback') return 'bypass';
  if (url.searchParams.has('token')) return 'bypass';
  if (path === '/sw.js' || path === '/manifest.webmanifest') return 'bypass';

  if (mode === 'navigate') return 'navigate';

  // Static build files only. Vite names every /assets/ file by its content hash.
  if (path.indexOf('/assets/') === 0) return 'static';
  if (path.indexOf('/fonts/') === 0) return 'static';
  if (path.indexOf('/icons/') === 0) return 'static';
  if (path === '/favicon.png' || path === OFFLINE_URL) return 'static';
  return 'bypass';
}

self.aramoSignRouteRequest = routeRequest;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then(function (cache) {
        return cache.addAll(PRECACHE);
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k.indexOf('aramo-sign-') === 0 && k !== STATIC_CACHE;
            })
            .map(function (k) {
              return caches.delete(k);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function fromCacheThenNetwork(request) {
  return caches.open(STATIC_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        // Only a complete, same-origin, successful response is kept.
        if (response.ok && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      });
    });
  });
}

function networkThenOffline(request) {
  return fetch(request).catch(function () {
    return caches.match(OFFLINE_URL).then(function (page) {
      return (
        page ||
        new Response("You're offline. Check your connection and try again.", {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      );
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var route = routeRequest(request.url, request.method, request.mode, self.location.origin);
  if (route === 'static') {
    event.respondWith(fromCacheThenNetwork(request));
  } else if (route === 'navigate') {
    event.respondWith(networkThenOffline(request));
  }
  // 'bypass': no respondWith — the browser fetches it as if no worker existed.
});
