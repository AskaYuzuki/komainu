/* 狛犬図鑑 service worker
   アプリ本体は先に保存。data/ は新しいものを優先（通信できないときは保存分）。
   写真と地図タイルは見たものから保存する。データを差し替えたら CACHE の番号を上げる。 */
var CACHE = 'komainu-v26';
var CORE = [
  './', 'index.html', 'style.css', 'app.js', 'maplibre-gl.css', 'manifest.webmanifest',
  'data/site.json', 'data/taxonomy.json', 'data/shrines.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('komainu-v') === 0 && k !== CACHE; })  /* 同じ住所の別アプリの保存は消さない */.map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req) {
  return fetch(req).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () { return caches.match(req, { ignoreSearch: true }); });
}
function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res && (res.ok || res.type === 'opaque')) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === location.origin) {
    // アプリ本体とデータは新しいものを優先（通信できないときは保存分）。写真は ?v= 付きなので保存分を使う
    if (url.pathname.indexOf('/images/') < 0 && url.pathname.indexOf('/icons/') < 0) { e.respondWith(networkFirst(req)); return; }
    e.respondWith(cacheFirst(req));
    return;
  }
  // MapLibre本体・フォント・地図は外部。ライブラリとフォントは保存して使い回す
  if (/unpkg\.com|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host)) { e.respondWith(cacheFirst(req)); return; }
  if (/tiles\.openfreemap\.org|cyberjapandata\.gsi\.go\.jp/.test(url.host)) { e.respondWith(networkFirst(req)); }
});
