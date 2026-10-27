/* 狛犬撮影 service worker
   アプリ本体は先に保存して、電波がなくても起動できるようにする。
   受け取り口（script.google.com）と神社の検索（overpass-api.de）は保存しない。
   中身を差し替えたら CACHE の番号を上げる。
   第4版（アプリ 4.0.0）：写真の取り消し・まとめて送信・対ごとの感想・斜め45度・音声入力。 */
var CACHE = 'satsuei-v10';
var CORE = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(CORE.map(function (u) { return new Request(u, { cache: 'reload' }); }));  /* 端末の古い控えを使わず必ず取り直す */ }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('satsuei-v') === 0 && k !== CACHE; })  /* 同じ住所の別アプリの保存は消さない */.map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
function networkFirst(req) {
  return fetch(req).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () { return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); }); });
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
    if (req.mode === 'navigate') { e.respondWith(networkFirst(req)); return; }
    e.respondWith(cacheFirst(req)); return;
  }
  if (/fonts\.(googleapis|gstatic)\.com/.test(url.host)) { e.respondWith(cacheFirst(req)); }
});
