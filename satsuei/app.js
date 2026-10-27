/* 狛犬撮影 app.js
   撮る画角を順番に案内 → 写真と位置を端末（IndexedDB）に保存 → 電波があれば受け取り口（Google Apps Script）へ送る。
   撮影の前に神社名を必ず確かめる。どの手順も「とばす」で進められる（必須は対の場所と最低1枚）。
   どの画面からでも「作品として撮る」で作品写真（kind=art）を撮れる。
   感想の画面：受け取り口から「感想待ち」を読み、感想と判断を送る。「投稿待ち」に載った項目は iPhone から Instagram へ渡す。
   対ごとに「生き物」（狛犬・狐・牛・蛙など。図鑑の taxonomy.json の animals）と「一対／1体だけ」を選ぶ。
   1体だけのときは片方の手順を飛ばし、残る1体が阿形・吽形・不明のどれかを記録する（第3版）。
   第4版：写真を1枚ずつ取り消せる（送信済みなら受け取り口に delphoto を送る）。写真は「送信する」を押したときにまとめて送る
   （設定の「撮ったらすぐ送る」で第3版と同じ自動送信にもできる。感想・取り消し・投稿済みの知らせは自動で送る）。
   対ごとの感想（pairs[n].kansou）を対のおわりと撮影のおわりで書ける。阿形・吽形の斜め45度（a_diag45・u_diag45）を通常の手順に入れた。
   感想の欄は音声入力（SpeechRecognition）ができる。
   window.KOMAINU_DEMO が true のときは見本の位置で動き、送信しない（claude.ai の Artifact 用）。 */
'use strict';
(function () {
  var DEMO = !!window.KOMAINU_DEMO;
  var VERSION = '4.0.0';
  var OVERPASS = 'https://overpass-api.de/api/interpreter';
  var RADIUS = 500;
  var MAX_EDGE = 2400, JPEG_Q = 0.85;
  var DEMO_POS = { lat: 36.22395, lon: 140.10025, accuracy: 12 };
  var DEMO_CANDS = [
    { name: '筑波山神社', type: 'way', id: 0, lat: 36.22412, lon: 140.09985 },
    { name: '見本稲荷社', type: 'node', id: 0, lat: 36.22520, lon: 140.10190 },
    { name: '見本八幡宮', type: 'node', id: 0, lat: 36.22110, lon: 140.10420 }
  ];
  var PLACES = ['鳥居前', '参道', '随神門前', '拝殿前', '本殿脇', '摂社・末社前', 'その他'];
  /* 生き物：図鑑（狛犬 作業ファイル app/data/taxonomy.json）の animals と同じ id。初期値は komainu */
  var ANIMALS = [
    { id: 'komainu', name: '狛犬' }, { id: 'fox', name: '狐' }, { id: 'ushi', name: '牛' }, { id: 'saru', name: '猿' },
    { id: 'usagi', name: '兎' }, { id: 'okami', name: '狼' }, { id: 'shika', name: '鹿' }, { id: 'inoshishi', name: '猪' },
    { id: 'kaeru', name: '蛙' }, { id: 'ryu', name: '龍' }, { id: 'kame', name: '亀' }, { id: 'hebi', name: '蛇' },
    { id: 'tori', name: '鳥' }, { id: 'nezumi', name: '鼠' }, { id: 'tora', name: '虎' }, { id: 'other', name: 'その他' }
  ];
  var SIDES = [{ v: 'a', name: '阿形（口を開く）' }, { v: 'u', name: '吽形（口を閉じる）' }, { v: 'unknown', name: '分からない' }];

  /* ---------- 撮る画角 ---------- */
  var TEXT_TIP = '横から光が当たると、彫った文字に影ができて読みやすくなります。日陰ならスマホのライトを真横から当てます。';
  var SHOTS = {
    keidai_map: { group: 'shrine', label: '境内の案内図', title: '境内の案内図の看板', text: '境内図の看板があれば、正面から全体が入るように撮ります。見取り図の材料にします。看板がなければ「とばす」。', tip: '文字が小さいときは、半分ずつ寄った写真も「もう1枚」で足します。', fig: 'board', more: 'もう1枚（寄り）' },
    zenkei: { group: 'shrine', label: '鳥居からの全景', title: '鳥居から社殿の方向', text: '鳥居の手前に立ち、参道と社殿が一緒に入るように引いて撮ります。', fig: 'zenkei' },
    place: { group: 'pair', label: '対の場所', title: 'この対がいる場所', text: '下から場所を選び、鳥居や社殿が一緒に入るように引いて1枚撮ります。', tip: '後で「どの像か」を見分けるための写真です。位置も一緒に記録します。', fig: 'place' },
    a_front: { group: 'pair', side: 'a', label: '阿形 正面', title: '向かって右（阿形）の正面', text: '口を開けている方です。正面に立ち、台座の上の全身が入るように撮ります。', fig: 'front' },
    a_diag45: { group: 'pair', side: 'a', label: '阿形 斜め45度', title: '阿形を左前から斜め45度で', text: '阿形の左前方（参道の側）、正面と真横のあいだに立ち、狛犬に向かって撮ります。顔と体の向きが両方分かるように全身を入れます。', tip: '図鑑の詳しいページで大きく出す写真です。台座の上まで入れます。', fig: 'diag' },
    a_side: { group: 'pair', side: 'a', label: '阿形 真横', title: '阿形を真横から', text: '真横に回り、全身を撮ります。お尻を上げているか、前脚を踏ん張っているかが分かるように。', tip: '撮れれば、構え型・尻上げかどうかを見分けるのに役立ちます。', fig: 'side' },
    a_face: { group: 'pair', side: 'a', label: '阿形 顔', title: '阿形の顔のアップ', text: '顔に寄って撮ります。口元と歯の彫り方、目・鼻・耳の形が分かるように。', tip: '少し下から撮ると、口の中と歯が写ります。', fig: 'face' },
    a_tail: { group: 'pair', side: 'a', label: '阿形 尾', title: '阿形の尾のアップ', text: '後ろに回り、尾の形が分かるように寄って撮ります。', tip: '尾の形（団扇・ろうそく・巻き毛など）は様式を見分けるいちばんの手がかりです。', fig: 'tail' },
    u_front: { group: 'pair', side: 'u', label: '吽形 正面', title: '向かって左（吽形）の正面', text: '口を閉じている方です。正面に立ち、台座の上の全身が入るように撮ります。', fig: 'front' },
    u_diag45: { group: 'pair', side: 'u', label: '吽形 斜め45度', title: '吽形を右前から斜め45度で', text: '吽形の右前方（参道の側）、正面と真横のあいだに立ち、狛犬に向かって撮ります。顔と体の向きが両方分かるように全身を入れます。', tip: '図鑑の詳しいページで大きく出す写真です。台座の上まで入れます。', fig: 'diag' },
    u_side: { group: 'pair', side: 'u', label: '吽形 真横', title: '吽形を真横から', text: '真横に回り、全身を撮ります。お尻を上げているか、前脚を踏ん張っているかが分かるように。', tip: '撮れれば、構え型・尻上げかどうかを見分けるのに役立ちます。', fig: 'side' },
    u_face: { group: 'pair', side: 'u', label: '吽形 顔', title: '吽形の顔のアップ', text: '顔に寄って撮ります。口元と歯の彫り方、目・鼻・耳の形が分かるように。', tip: '角があるときは角も入れます。', fig: 'face' },
    u_tail: { group: 'pair', side: 'u', label: '吽形 尾', title: '吽形の尾のアップ', text: '後ろに回り、尾の形が分かるように寄って撮ります。', tip: '尾の形（団扇・ろうそく・巻き毛など）は様式を見分けるいちばんの手がかりです。', fig: 'tail' },
    base_front: { group: 'pair', label: '台座 正面', title: '台座の正面', text: '台座の正面を、文字が読めるように撮ります。「奉献」の文字や奉納者の名前があります。阿形・吽形の両方の台座を撮ります。', tip: TEXT_TIP, fig: 'base_front', more: 'もう1枚（吽形の台座・下の段）', isText: true },
    base_left: { group: 'pair', label: '台座 左の側面', title: '台座の左の側面', text: '向かって左の側面です。年号や石工の名前が彫られていることが多い面です。', tip: TEXT_TIP, fig: 'base_left', more: 'もう1枚（吽形の台座・下の段）', isText: true },
    base_right: { group: 'pair', label: '台座 右の側面', title: '台座の右の側面', text: '向かって右の側面です。年号や石工の名前が彫られていることが多い面です。', tip: TEXT_TIP, fig: 'base_right', more: 'もう1枚（吽形の台座・下の段）', isText: true },
    base_back: { group: 'pair', label: '台座 背面', title: '台座の背面', text: '後ろに回って台座の背面を撮ります。年号・石工・奉納者の一覧があることがあります。', tip: '段が多いときは、段ごとに「もう1枚」で分けて撮ります。2段目・3段目に石工名が隠れていることがあります。', fig: 'base_back', more: 'もう1枚（吽形の台座・下の段）', isText: true },
    body_text: { group: 'opt', label: '本体の文字', title: '本体に彫られた文字', text: '背中・お尻・胸・前脚の内側に文字があれば撮ります。', tip: TEXT_TIP, isText: true },
    board: { group: 'opt', label: '案内板・由緒書き', title: '案内板・由緒書き', text: '神社の由緒書きや、像の説明板があれば撮ります。', tip: '年代や作者が書いてあることがあります。' },
    stone: { group: 'opt', label: '石の表面', title: '石の表面のアップ', text: '素材を見分けるため、石の表面に寄って撮ります。', tip: '雨のあとは色が変わるので、乾いた所を選びます。' },
    pair_both: { group: 'opt', label: '一対が並ぶ写真', title: '阿形と吽形を一緒に', text: '参道の中ほどから、阿形と吽形が一緒に入るように撮ります。' },
    /* 第3版までの任意の手順。第4版では a_diag45・u_diag45 に分けた。古い記録の写真を表示するためだけに残す */
    diag45: { group: 'opt', label: '斜め45度（前の版）', title: '斜め前45度から', text: '前の版で撮った斜め45度の写真です。' },
    other: { group: 'opt', label: 'その他', title: 'その他', text: '玉・子ども（子獅子など）・欠けた所など、気になった所を撮ります。' },
    art: { group: 'art', label: '作品', title: '作品写真', text: '' }
  };
  var SHRINE_STEPS = ['keidai_map', 'zenkei'];
  var PAIR_STEPS = ['place', 'a_front', 'a_diag45', 'a_side', 'a_face', 'a_tail', 'u_front', 'u_diag45', 'u_side', 'u_face', 'u_tail', 'base_front', 'base_left', 'base_right', 'base_back', '__opt'];
  var OPT_SHOTS = ['pair_both', 'body_text', 'board', 'stone', 'other'];
  var LEGACY_OPT = ['diag45'];  // 前の版の任意の画角（写真があるときだけ出す）

  /* ---------- 小道具 ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid(p) { return (p || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localDate(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function hm(iso) { if (!iso) return ''; var d = new Date(iso); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function dist(a, b, c, d) {
    var R = 6371000, t = Math.PI / 180, x = (c - a) * t, y = (d - b) * t;
    var h = Math.sin(x / 2) * Math.sin(x / 2) + Math.cos(a * t) * Math.cos(c * t) * Math.sin(y / 2) * Math.sin(y / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }
  function fmtDist(m) { return m == null ? '' : (m < 1000 ? m + 'm' : (m / 1000).toFixed(1) + 'km'); }
  function online() { return DEMO || navigator.onLine !== false; }
  var toastTimer = null;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2600); }

  /* ---------- 保存（IndexedDB。使えないときはメモリ） ---------- */
  var mem = null, dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r;
      try { r = indexedDB.open('komainu-satsuei', 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore('sessions', { keyPath: 'id' });
        d.createObjectStore('photos', { keyPath: 'id' });
        d.createObjectStore('outbox', { keyPath: 'id' });
        d.createObjectStore('kv', { keyPath: 'k' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    }).catch(function () {
      mem = { sessions: {}, photos: {}, outbox: {}, kv: {} };
      return null;
    });
    return dbp;
  }
  function keyOf(store, v) { return store === 'kv' ? v.k : v.id; }
  function wrap(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function dbPut(store, v) {
    return openDB().then(function (d) {
      if (!d) { mem[store][keyOf(store, v)] = v; return; }
      return wrap(d.transaction(store, 'readwrite').objectStore(store).put(v));
    });
  }
  function dbGet(store, k) {
    return openDB().then(function (d) {
      if (!d) return mem[store][k];
      return wrap(d.transaction(store).objectStore(store).get(k));
    });
  }
  function dbDel(store, k) {
    return openDB().then(function (d) {
      if (!d) { delete mem[store][k]; return; }
      return wrap(d.transaction(store, 'readwrite').objectStore(store).delete(k));
    });
  }
  function dbAll(store) {
    return openDB().then(function (d) {
      if (!d) return Object.keys(mem[store]).map(function (k) { return mem[store][k]; });
      return wrap(d.transaction(store).objectStore(store).getAll());
    });
  }
  function kvGet(k, dflt) { return dbGet('kv', k).then(function (r) { return r ? r.v : dflt; }).catch(function () { return dflt; }); }
  function kvSet(k, v) { return dbPut('kv', { k: k, v: v }).catch(function () {}); }

  /* 写真：Blob のまま保存。失敗したら ArrayBuffer にして保存 */
  function putPhoto(p) {
    return dbPut('photos', p).catch(function () {
      if (!p.blob) throw new Error('save_failed');
      return p.blob.arrayBuffer().then(function (buf) {
        var q = Object.assign({}, p, { blob: null, buf: buf, type: p.blob.type || 'image/jpeg' });
        return dbPut('photos', q);
      });
    });
  }
  function photoBlob(p) { if (p.blob) return p.blob; if (p.buf) return new Blob([p.buf], { type: p.type || 'image/jpeg' }); return null; }

  /* ---------- 状態 ---------- */
  var S = {
    tab: 'shoot',
    shootView: 'home',     // home | guide | settings
    settings: { url: '', pass: '', autoSend: false },  // autoSend：撮ったらすぐ送る（初期値は送らない）
    session: null,         // 撮影中の神社
    photos: [],            // 撮影中の神社の写真
    here: { status: 'idle', pos: null, cands: [], sel: 0, manual: '', error: '' },
    lastFix: null,
    watchId: null,
    counts: { wait: 0, sent: 0, onDevice: 0, kwait: 0, swait: 0, dwait: 0 },
    sending: false,
    sendingId: null,       // いま送っている写真のID
    pendingAll: false,     // 送信中に「送信する」が押された
    cancelled: {},         // 取り消した写真のID
    confirmPhoto: null,    // 「取り消しますか？」を出している写真のID
    done: null,            // 撮影をおえたあとの画面：{ s: 撮影の記録, photos: [] }
    sendError: '',
    sheet: false,
    kansou: { data: null, loading: false, error: '', fetchedAt: null, answered: {} },
    kstate: {},            // itemId → { decision, at, sent }
    kdraft: {},
    confirmDelete: false,
    artId: null,           // 作品写真のシートで開いている写真のID
    artDraft: null,        // { title, pair }
    posts: { data: null, posted: {}, loading: false, error: '', fetchedAt: null },  // 投稿待ち.json と 投稿済み
    pstate: {},            // itemId → { phase: idle|loading|ready|shared, files: [File], got, total, error, copied }
    postedLocal: {}        // itemId → { via, at }（この端末で「投稿しました」を押したもの）
  };
  var thumbUrls = [];

  /* ---------- 位置 ---------- */
  function getPos(timeout) {
    if (DEMO) return Promise.resolve({ lat: DEMO_POS.lat, lon: DEMO_POS.lon, accuracy: DEMO_POS.accuracy, at: new Date().toISOString() });
    return new Promise(function (res, rej) {
      if (!navigator.geolocation) { rej(new Error('no_geolocation')); return; }
      navigator.geolocation.getCurrentPosition(function (p) {
        res({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), at: new Date(p.timestamp).toISOString() });
      }, rej, { enableHighAccuracy: true, timeout: timeout || 15000, maximumAge: 30000 });
    });
  }
  function startWatch() {
    if (DEMO) { S.lastFix = { lat: DEMO_POS.lat, lon: DEMO_POS.lon, accuracy: DEMO_POS.accuracy, at: new Date().toISOString() }; return; }
    if (S.watchId != null || !navigator.geolocation) return;
    S.watchId = navigator.geolocation.watchPosition(function (p) {
      S.lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), at: new Date(p.timestamp).toISOString() };
    }, function () {}, { enableHighAccuracy: true, maximumAge: 20000, timeout: 30000 });
  }
  function stopWatch() { if (S.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  function freshFix() {
    if (DEMO) return { lat: DEMO_POS.lat, lon: DEMO_POS.lon, accuracy: DEMO_POS.accuracy, at: new Date().toISOString() };
    var f = S.lastFix; if (!f) return null;
    return (Date.now() - new Date(f.at).getTime() < 3 * 60 * 1000) ? f : null;
  }

  /* 半径500m以内の神社（OpenStreetMap / Overpass） */
  function findShrines(lat, lon) {
    if (DEMO) {
      return Promise.resolve(DEMO_CANDS.map(function (c) { return Object.assign({}, c, { dist: dist(lat, lon, c.lat, c.lon) }); })
        .sort(function (a, b) { return a.dist - b.dist; }));
    }
    var q = '[out:json][timeout:20];nwr(around:' + RADIUS + ',' + lat + ',' + lon + ')["amenity"="place_of_worship"]["religion"="shinto"];out center tags 60;';
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 25000);
    return fetch(OVERPASS, {
      method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl ? ctl.signal : undefined
    }).then(function (r) { if (!r.ok) throw new Error('overpass_' + r.status); return r.json(); })
      .then(function (j) {
        var seen = {}, out = [];
        (j.elements || []).forEach(function (el) {
          var la = el.lat != null ? el.lat : (el.center && el.center.lat), lo = el.lon != null ? el.lon : (el.center && el.center.lon);
          if (la == null) return;
          var t = el.tags || {};
          var nm = t['name:ja'] || t.name || '';
          var c = { name: nm, type: el.type, id: el.id, lat: la, lon: lo, dist: dist(lat, lon, la, lo) };
          out.push(c);
        });
        out.sort(function (a, b) { return (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.dist - b.dist; });
        return out.filter(function (c) { var k = c.name || (c.type + c.id); if (seen[k]) return false; seen[k] = 1; return true; })
          .sort(function (a, b) { return (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.dist - b.dist; })
          .map(function (c) { if (!c.name) c.name = '名前のない神社'; return c; });
      })
      .finally(function () { clearTimeout(timer); });
  }

  function locate() {
    var h = S.here;
    h.status = 'locating'; h.error = ''; h.cands = []; h.sel = 0;
    renderHome();
    getPos(15000).then(function (pos) {
      h.pos = pos;
      if (!online()) { h.status = 'offline'; renderHome(); return; }
      h.status = 'searching'; renderHome();
      return findShrines(pos.lat, pos.lon).then(function (c) {
        h.cands = c; h.sel = 0; h.status = c.length ? 'found' : 'none'; renderHome();
      }).catch(function () { h.status = 'offline'; renderHome(); });
    }).catch(function (e) {
      h.pos = null; h.status = 'noloc';
      h.error = (e && e.code === 1) ? '位置情報の利用が許可されていません。iPhoneの「設定」→「プライバシーとセキュリティ」→「位置情報サービス」で、このアプリ（またはSafari）を「使用中のみ許可」にすると自動で探せます。' : '位置情報が取れませんでした。';
      renderHome();
    });
  }

  /* ---------- 撮影の記録 ---------- */
  function saveSession() { if (!S.session) return Promise.resolve(); S.session.updatedAt = new Date().toISOString(); return dbPut('sessions', S.session); }
  function loadSessionPhotos() {
    if (!S.session) { S.photos = []; return Promise.resolve(); }
    var id = S.session.id;
    return dbAll('photos').then(function (all) { S.photos = all.filter(function (p) { return p.sessionId === id; }); });
  }
  function photosOf(pair, shot) {
    return S.photos.filter(function (p) { return p.pair === pair && p.shot === shot; }).sort(function (a, b) { return a.seq - b.seq; });
  }
  function skipKey(pair, shot) { return pair + ':' + shot; }
  function pairOf(no) { return S.session && S.session.pairs[no - 1]; }
  /* 1体だけの対：撮る側の画角キー（吽形を選んだときだけ u_*。阿形・不明は a_*） */
  function singlePrefix(p) { return p && p.side === 'u' ? 'u' : 'a'; }
  function stepsOfPair(p) {
    if (!p || !p.single) return PAIR_STEPS;
    var x = singlePrefix(p);
    return ['place', x + '_front', x + '_diag45', x + '_side', x + '_face', x + '_tail', 'base_front', 'base_left', 'base_right', 'base_back', '__opt'];
  }
  function stepsOf(pair) { return pair === 0 ? SHRINE_STEPS : stepsOfPair(pairOf(pair)); }
  function animalOf(p) { return (p && p.animal) || 'komainu'; }
  function animalName(id) { var a = ANIMALS.find(function (x) { return x.id === id; }); return a ? a.name : 'その他'; }
  function optShotsOf(p) {
    var list = p && p.single ? OPT_SHOTS.filter(function (k) { return k !== 'pair_both'; }) : OPT_SHOTS;
    // 前の版の「斜め45度」に写真がある対だけ、そのタイルも出す（古い記録を壊さない）
    var legacy = p ? LEGACY_OPT.filter(function (k) { return photosOf(p.no, k).length; }) : [];
    return list.concat(legacy);
  }
  /* 対ごとの見出し（例：対2・狐・1体・拝殿前）。狛犬の一対のときは第2版と同じ「対1・拝殿前」 */
  function pairTitle(p) {
    if (!p) return '';
    var a = animalOf(p);
    return '対' + p.no + (a !== 'komainu' ? '・' + animalName(a) : '') + (p.single ? '・1体' : '') + (p.place ? '・' + placeLabel(p) : '');
  }
  /* 対の情報を、受け取り口へ送る形にする（metadata.json の pairs と同じ） */
  function pairPayload(p, no) {
    if (!p) return { no: no || 0, place: '', placeLabel: '', location: null };
    var single = !!p.single;
    return { no: p.no, place: p.place || '', placeLabel: placeLabel(p), location: p.location || null,
      animal: animalOf(p), single: single, side: single ? (p.side === 'a' || p.side === 'u' ? p.side : 'unknown') : null,
      kansou: (p.kansou || '').trim(), kansouAt: p.kansouAt || null };
  }
  /* 画角の説明。1体だけの対では、阿形・吽形の決め打ちを外した文言にする */
  var SINGLE_TEXT = {
    _front: { label: '正面', title: '正面', text: '正面に立ち、台座の上の全身が入るように撮ります。' },
    _diag45: { label: '斜め45度', title: '斜め前45度から', text: '正面と真横のあいだ（斜め前45度）に立ち、顔と体の向きが両方分かるように全身を撮ります。' },
    _side: { label: '真横', title: '真横から', text: '真横に回り、全身を撮ります。お尻を上げているか、前脚を踏ん張っているかが分かるように。' },
    _face: { label: '顔', title: '顔のアップ', text: '顔に寄って撮ります。口元と歯の彫り方、目・鼻・耳の形が分かるように。' },
    _tail: { label: '尾', title: '尾のアップ', text: '後ろに回り、尾の形が分かるように寄って撮ります。' }
  };
  function shotFor(pair, key) {
    var sh = SHOTS[key] || { label: key, group: 'opt' };
    var p = pair > 0 ? pairOf(pair) : null;
    if (!p || !p.single) return sh;
    var o = Object.assign({}, sh);
    if (sh.side) {
      var t = SINGLE_TEXT[key.slice(1)], who = p.side === 'a' ? '阿形' : p.side === 'u' ? '吽形' : '1体';
      o.label = who + ' ' + t.label; o.title = (p.side === 'a' || p.side === 'u' ? who + 'の' : '') + t.title; o.text = t.text;
      o.side = p.side === 'a' || p.side === 'u' ? p.side : null; o.figSide = singlePrefix(p);
      if (key.slice(1) === '_face' && p.side === 'u') o.tip = SHOTS.u_face.tip;
    } else if (/^base_/.test(key)) {
      o.more = 'もう1枚（下の段）';
      if (key === 'base_front') o.text = '台座の正面を、文字が読めるように撮ります。「奉献」の文字や奉納者の名前があります。';
      o.figSide = singlePrefix(p);
    } else if (key === 'diag45') {
      o.text = '斜め前から全身を撮ります。';
    }
    o.single = true;
    return o;
  }

  /* 神社名を確かめてから撮影に入る。how = auto | picked | manual | later */
  function startSession(how) {
    var h = S.here, shrine, now = new Date().toISOString();
    if (how === 'manual') {
      var nm = (h.manual || '').trim();
      if (!nm) { toast('神社名を入れてください'); var mi = document.getElementById('manual-name'); if (mi) mi.focus(); return; }
      shrine = { name: nm, source: 'manual' };
    } else if (how === 'auto' || how === 'picked') {
      var c = h.cands[h.sel]; if (!c) return;
      shrine = { name: c.name, source: DEMO ? 'demo' : 'osm', osmType: c.type, osmId: c.id, lat: c.lat, lon: c.lon, distanceM: c.dist };
      how = h.sel === 0 ? 'auto' : 'picked';
    } else if (how === 'later' && h.pos) {
      shrine = { name: '', source: 'pending' };
    } else { toast('神社名を入れてください'); return; }
    shrine.confirmed = how !== 'later';
    shrine.confirmedBy = how;
    shrine.confirmedAt = now;
    S.session = {
      id: uid('s'), date: localDate(), startedAt: now, shrine: shrine,
      location: h.pos || null,
      candidates: (h.cands || []).slice(0, 8).map(function (c) { return { name: c.name, osmType: c.type, osmId: c.id, lat: c.lat, lon: c.lon, distanceM: c.dist }; }),
      pairs: [], skips: {}, cursor: { pair: 0, step: 0, mode: 'step' }, status: 'shooting', demo: DEMO || undefined
    };
    S.photos = [];
    kvSet('current', S.session.id);
    saveSession().then(function () {
      S.shootView = 'guide'; startWatch(); render();
      toast(how === 'later' ? '位置を保存しました。神社名はあとで調べます' : '「' + shrine.name + '」で撮影をはじめます');
    });
  }

  function photosInPair(pair) { return S.photos.filter(function (p) { return p.pair === pair && !p.hold; }); }
  function newPair() {
    var ps = S.session.pairs, last = ps[ps.length - 1];
    // 写真のない対が最後にあれば、それを使い直す（空の対を増やさない）
    if (last && !photosInPair(last.no).length) {
      last.place = ''; last.placeOther = ''; last.animal = 'komainu'; last.single = false; last.side = null;
      last.location = freshFix(); last.startedAt = new Date().toISOString();
      S.session.cursor = { pair: last.no, step: 0, mode: 'step' };
      return;
    }
    var no = ps.length + 1;
    ps.push({ no: no, place: '', placeOther: '', animal: 'komainu', single: false, side: null, location: freshFix(), startedAt: new Date().toISOString() });
    S.session.cursor = { pair: no, step: 0, mode: 'step' };
  }
  // 対の場所は必須（写真はとばせる）
  function needPlace(c) {
    if (c.mode !== 'step' || c.pair === 0 || stepsOf(c.pair)[c.step] !== 'place') return false;
    return false;  // あすかさん 10/27：場所も「とばす」でとばせるようにする（あとで③が写真から決める）
  }
  function goNext() {
    var c = S.session.cursor, list = stepsOf(c.pair);
    if (c.mode !== 'step') return;
    if (needPlace(c)) return;
    if (c.step < list.length - 1) c.step++;
    else if (c.pair === 0) { if (S.session.pairs.length) S.session.cursor = { pair: 1, step: 0, mode: 'step' }; else newPair(); }
    else c.mode = 'pairEnd';
    saveSession(); renderGuide(true);
  }
  function goPrev() {
    var c = S.session.cursor;
    if (c.mode === 'pairEnd') { c.mode = 'step'; c.step = stepsOf(c.pair).length - 1; }
    else if (c.mode === 'finish') { var n = S.session.pairs.length; S.session.cursor = n ? { pair: n, step: 0, mode: 'pairEnd' } : { pair: 0, step: 0, mode: 'step' }; }
    else if (c.step > 0) c.step--;
    else if (c.pair > 1) { S.session.cursor = { pair: c.pair - 1, step: 0, mode: 'pairEnd' }; }
    else if (c.pair === 1) { S.session.cursor = { pair: 0, step: SHRINE_STEPS.length - 1, mode: 'step' }; }
    saveSession(); renderGuide(true);
  }
  function skipStep() {
    var c = S.session.cursor, shot = stepsOf(c.pair)[c.step];
    if (needPlace(c)) return;
    if (shot && shot !== '__opt') S.session.skips[skipKey(c.pair, shot)] = true;
    goNext();
  }

  function onCapture(input) {
    var f = input.files && input.files[0];
    var d = input.dataset;
    input.value = '';
    if (!f || !S.session) return;
    if (d.act === 'art' || d.act === 'art-replace') { onArtCapture(f, d); return; }
    var pair = +d.pair, shot = d.shot, now = new Date().toISOString(), loc = freshFix();
    if (f.lastModified && Date.now() - f.lastModified > 60000) now = new Date(f.lastModified).toISOString();  // カメラアプリで撮った写真はその時刻
    if (f.lastModified && Date.now() - f.lastModified > 600000) loc = null;  // 10分より前に撮った写真は、今いる場所が撮った場所とは限らないので位置を付けない
    var prom;
    if (d.act === 'replace') {
      prom = dbGet('photos', d.id).then(function (old) {
        if (!old) return null;
        // 同じIDで送り直す → 受け取り口で上書きされる
        return Object.assign({}, old, { blob: f, buf: null, takenAt: now, location: loc, sent: false, sentAt: null, deleted: false, lastError: '' });
      });
    } else prom = Promise.resolve(null);
    prom.then(function (rec) {
      if (!rec) {
        var seq = photosOf(pair, shot).reduce(function (m, p) { return Math.max(m, p.seq); }, 0) + 1;
        rec = { id: uid('p'), sessionId: S.session.id, pair: pair, shot: shot, kind: 'record', title: '', seq: seq, takenAt: now, location: loc, blob: f, sent: false, sentAt: null, deleted: false, lastError: '' };
      }
      return putPhoto(rec).then(function () { return rec; });
    }).then(function () {
      delete S.session.skips[skipKey(pair, shot)];
      return saveSession();
    }).then(loadSessionPhotos).then(function () {
      renderGuide(); refreshCounts(); pump();
    }).catch(function () { toast('写真を保存できませんでした。端末の空き容量を確かめてください'); });
  }

  /* ---------- 作品写真 ---------- */
  function artSeq(pair, exceptId) {
    return S.photos.filter(function (p) { return p.kind === 'art' && p.pair === pair && p.id !== exceptId; })
      .reduce(function (m, p) { return Math.max(m, p.seq || 0); }, 0) + 1;
  }
  function defaultArtPair() { var c = S.session.cursor; return c.pair > 0 && pairOf(c.pair) ? c.pair : 0; }
  // 撮った直後に保存（hold=true の間は送らない）→ 作品名と紐づけ先を決めるシートを出す
  function onArtCapture(f, d) {
    var now = new Date().toISOString(), loc = freshFix();
    if (f.lastModified && Date.now() - f.lastModified > 60000) now = new Date(f.lastModified).toISOString();
    if (f.lastModified && Date.now() - f.lastModified > 600000) loc = null;  // 前に撮った写真には今の位置を付けない
    var prom;
    if (d.act === 'art-replace' && d.id) {
      prom = dbGet('photos', d.id).then(function (old) {
        if (!old) return null;
        return Object.assign({}, old, { blob: f, buf: null, takenAt: now, location: loc, sent: false, sentAt: null, lastError: '', hold: true });
      });
    } else prom = Promise.resolve(null);
    prom.then(function (rec) {
      if (!rec) {
        var pair = defaultArtPair();
        rec = { id: uid('p'), sessionId: S.session.id, pair: pair, shot: 'art', kind: 'art', title: '', seq: artSeq(pair), takenAt: now, location: loc, blob: f, sent: false, sentAt: null, deleted: false, lastError: '', hold: true };
      }
      return putPhoto(rec).then(function () { return rec; });
    }).then(function (rec) {
      return loadSessionPhotos().then(function () { openArt(rec.id); refreshCounts(); });
    }).catch(function () { toast('写真を保存できませんでした。端末の空き容量を確かめてください'); });
  }
  function openArt(id) {
    var p = S.photos.find(function (x) { return x.id === id; }); if (!p) return;
    S.artId = id; S.artDraft = { title: p.title || '', pair: p.pair };
    renderOverlay();
  }
  function saveArt() {
    var p = S.photos.find(function (x) { return x.id === S.artId; }); if (!p) { closeArt(); return; }
    var d = S.artDraft || {};
    var title = (d.title || '').trim(), pair = d.pair == null ? p.pair : d.pair;
    var changed = p.hold || title !== (p.title || '') || pair !== p.pair;
    if (pair !== p.pair) p.seq = artSeq(pair, p.id);
    p.title = title; p.pair = pair; p.hold = false;
    if (changed && p.sent) { p.sent = false; p.sentAt = null; }  // 同じIDで送り直す → 受け取り口で上書き
    dbGet('photos', p.id).then(function (rec) {
      return putPhoto(Object.assign({}, rec || p, { title: p.title, pair: p.pair, seq: p.seq, hold: false, sent: p.sent, sentAt: p.sentAt }));
    }).then(function () {
      S.artId = null; S.artDraft = null; renderOverlay();
      toast('作品写真を保存しました' + (pair ? '（対' + pair + '）' : '（神社全体）'));
      return loadSessionPhotos();
    }).then(function () { if (S.shootView === 'guide' && S.tab === 'shoot') renderGuide(); else render(); refreshCounts(); pump(); });
  }
  /* 写真を1枚取り消す。未送信なら端末から消すだけ。送信済み（または送っている最中）なら、
     受け取り口へ「取り消し」（type=delphoto）を送信待ちに入れる。電波がなければあとで送る */
  function wasSent(p) { return !!(p && (p.sent || p.sentAt || p.remote || S.sendingId === p.id)); }
  function cancelPhoto(id) {
    var now = new Date().toISOString();
    return dbGet('photos', id).then(function (rec) {
      rec = rec || S.photos.find(function (x) { return x.id === id; });
      if (!rec) return null;
      var remote = wasSent(rec);
      S.cancelled[id] = true;
      var jobs = [dbDel('photos', id)];
      if (remote && !DEMO) {
        jobs.push(dbPut('outbox', { id: 'd_' + id, kind: 'delphoto', photoId: id, createdAt: now, sent: false,
          payload: { type: 'delphoto', delphoto: { sessionId: rec.sessionId, id: id, requestedAt: now, appVersion: VERSION } } }));
      }
      return Promise.all(jobs).then(function () { return { remote: remote, art: rec.kind === 'art' }; });
    }).then(function (r) {
      S.confirmPhoto = null;
      if (S.artId === id) { S.artId = null; S.artDraft = null; }
      if (!r) { render(); return; }
      toast(r.remote ? (DEMO ? '写真を取り消しました（見本なので受信箱には送りません）' : '写真を取り消しました。受信箱からも消します') : '写真を取り消しました');
      return loadSessionPhotos().then(function () {
        if (S.done) return loadDone(S.done.s.id);
      }).then(function () { render(); refreshCounts(); if (r.remote) pump(); });
    }).catch(function () { toast('取り消せませんでした。もう一度押してください'); });
  }
  function deleteArt() { if (S.artId) cancelPhoto(S.artId); }
  /* 「取り消す」と確かめの一言（サムネイル・作品写真のシート・手順の一覧で使う） */
  function cancelBtnHTML(p, cls) {
    if (S.confirmPhoto === p.id) {
      return '<div class="pconfirm"><span>' + (wasSent(p) ? '受信箱からも取り消しますか？' : '取り消しますか？') + '</span>' +
        '<button type="button" class="btn danger" data-act="del-photo" data-id="' + esc(p.id) + '">取り消す</button>' +
        '<button type="button" class="btn ghost" data-act="cancel-del-photo">やめる</button></div>';
    }
    return '<button type="button" class="' + (cls || 'btn ghost') + '" data-act="ask-del-photo" data-id="' + esc(p.id) + '">取り消す</button>';
  }
  function closeArt() {
    // 閉じたときも保存扱い（撮った写真を失わない）
    if (S.artId) { saveArt(); return; }
    renderOverlay();
  }

  function finishSession() {
    var s = S.session;
    if (!S.photos.length) { toast('1枚以上撮ると、おえられます'); return; }
    clearTimeout(pkTimer); pkDirty = {}; micStop();  // 感想は下の saveSession で一緒に保存する
    s.status = 'done'; s.finishedAt = new Date().toISOString();
    s.artCount = S.photos.filter(function (p) { return p.kind === 'art'; }).length;
    s.emptyPairs = s.pairs.filter(function (p) { return !photosInPair(p.no).length; }).map(function (p) { return p.no; });
    var msg = {
      id: 'f_' + s.id, kind: 'session', createdAt: s.finishedAt, sent: false,
      payload: { type: 'session', session: sessionInfo(s, S.photos.length) }
    };
    Promise.all([saveSession(), dbPut('outbox', msg), kvSet('current', null)]).then(function () {
      stopWatch(); S.session = null; S.photos = []; S.here.status = 'idle';
      return loadDone(s.id);
    }).then(function () {
      S.shootView = 'done';
      toast(DEMO ? '撮影をおえました（見本なので送信はしません）' : S.settings.autoSend ? '撮影をおえました。写真は順に送ります' : '撮影をおえました。「送信する」を押すと送ります');
      render(); $('#view-done').scrollTop = 0; refreshCounts(); pump();
    });
  }
  /* 撮影をおえたあとの画面のための読み込み */
  function loadDone(id) {
    return Promise.all([dbGet('sessions', id), dbAll('photos'), dbGet('outbox', 'f_' + id)]).then(function (r) {
      if (!r[0]) { S.done = null; return; }
      S.done = { s: r[0], photos: r[1].filter(function (p) { return p.sessionId === id; }), msg: r[2] || null };
    });
  }
  /* 対ごとの感想を書き換える。撮影中の記録でも、おえた記録でもよい。
     おえた記録の「撮影の終わり」がもう送られていたら、送り直す（受け取り口で pairs が上書きされる） */
  var pkTimer = null, pkDirty = {};
  function sessFor(sid) {
    if (S.session && S.session.id === sid) return S.session;
    if (S.done && S.done.s.id === sid) return S.done.s;
    return null;
  }
  function setPairKansou(sid, no, val) {
    var s = sessFor(sid); if (!s) return;
    var pr = s.pairs.find(function (p) { return p.no === no; }); if (!pr) return;
    if ((pr.kansou || '') === val) return;
    pr.kansou = val; pr.kansouAt = new Date().toISOString();
    pkDirty[sid] = s;
    clearTimeout(pkTimer); pkTimer = setTimeout(flushPairKansou, 500);
  }
  function flushPairKansou() {
    var list = Object.keys(pkDirty).map(function (k) { return pkDirty[k]; }); pkDirty = {};
    return Promise.all(list.map(function (s) {
      s.updatedAt = new Date().toISOString();
      return dbPut('sessions', s).then(function () {
        if (s.status !== 'done') return;
        return dbGet('outbox', 'f_' + s.id).then(function (o) {
          if (o && o.sent) { o.sent = false; o.resend = true; return dbPut('outbox', o); }
        });
      });
    })).then(function () { if (list.length) refreshCounts(); });
  }
  // 1枚も撮らずにやめる（記録を残さない）
  function discardSession() {
    var s = S.session; if (!s || S.photos.length) return;
    Promise.all([dbDel('sessions', s.id), kvSet('current', null)]).then(function () {
      stopWatch(); S.session = null; S.photos = []; S.shootView = 'home'; S.here.status = 'idle'; S.confirmDiscard = false;
      toast('撮影をやめました'); render(); refreshCounts();
    });
  }
  // 撮影の記録を消す（撮影中・中断中・撮りおえたもの）。この端末の写真と送信待ちを消す。受信箱に届いた写真は消えない
  function deleteSession(id) {
    return Promise.all([dbAll('photos'), dbAll('outbox')]).then(function (r) {
      var jobs = r[0].filter(function (p) { return p.sessionId === id; }).map(function (p) { return dbDel('photos', p.id); });
      r[1].filter(function (o) { return o.id === 'f_' + id || (o.payload && o.payload.session && o.payload.session.sessionId === id); })
        .forEach(function (o) { jobs.push(dbDel('outbox', o.id)); });
      jobs.push(dbDel('sessions', id));
      if (S.session && S.session.id === id) {
        jobs.push(kvSet('current', null));
        stopWatch(); S.session = null; S.photos = []; S.shootView = 'home'; S.here.status = 'idle';
      }
      return Promise.all(jobs);
    }).then(function () { S.confirmSess = null; toast('撮影の記録を消しました'); render(); refreshCounts(); });
  }
  function sessDeleteHTML(id, name) {
    if (S.confirmSess !== id) return '<button type="button" class="link-btn" data-act="ask-del-sess" data-id="' + esc(id) + '">この記録を削除する</button>';
    return '<div class="confirm"><p class="prose">「' + esc(name) + '」の撮影の記録と写真を、この端末から消します。送信待ちの写真も送られなくなります。受信箱にすでに届いた写真は消えません。</p>' +
      '<div class="row"><button type="button" class="btn danger" data-act="del-sess" data-id="' + esc(id) + '">削除する</button><button type="button" class="btn ghost" data-act="cancel-del-sess">やめる</button></div></div>';
  }
  // 対の場所が決まっていない対（写真があるもの）を探す
  function pairWithoutPlace() {
    return S.session.pairs.find(function (p) { return !p.place && photosInPair(p.no).length; });
  }
  function sessionInfo(s, photoCount) {
    return {
      sessionId: s.id, date: s.date, startedAt: s.startedAt, finishedAt: s.finishedAt || null,
      shrine: s.shrine, candidates: s.candidates, location: s.location,
      pairs: s.pairs.filter(function (p) { return !s.emptyPairs || s.emptyPairs.indexOf(p.no) < 0; })
        .map(function (p) { return pairPayload(p); }),
      skipped: Object.keys(s.skips || {}), photoCount: photoCount, artCount: s.artCount || 0, appVersion: VERSION
    };
  }
  /* 送る写真の画角情報（撮影中でない記録でも使えるよう、対の記録から直接決める） */
  function shotOfRec(p, pr) {
    var sh = SHOTS[p.shot] || { label: p.shot, group: 'opt' };
    if (!pr || !pr.single || !sh.side) return sh;
    var t = SINGLE_TEXT[p.shot.slice(1)], sd = pr.side === 'a' || pr.side === 'u' ? pr.side : null;
    return { label: (sd === 'a' ? '阿形' : sd === 'u' ? '吽形' : '1体') + ' ' + t.label, group: sh.group, side: sd };
  }
  function placeLabel(p) { if (!p) return ''; return p.place === 'その他' ? ('その他' + (p.placeOther ? '：' + p.placeOther : '')) : (p.place || ''); }

  /* ---------- 送信 ---------- */
  function shrink(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () {
        var w0 = img.naturalWidth, h0 = img.naturalHeight, k = Math.min(1, MAX_EDGE / Math.max(w0, h0));
        var w = Math.round(w0 * k), h = Math.round(h0 * k);
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { c.width = c.height = 0; if (b) res({ blob: b, w: w, h: h }); else rej(new Error('encode')); }, 'image/jpeg', JPEG_Q);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  function toBase64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function post(obj) {
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 120000);
    return fetch(S.settings.url, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(obj), signal: ctl ? ctl.signal : undefined
    }).then(function (r) { return r.text(); })
      .then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: false, error: 'bad_response' }; } })
      .finally(function () { clearTimeout(timer); });
  }
  function errText(code) {
    if (code === 'wrong_passphrase') return '合言葉が受け取り口と違います。設定を確かめてください。';
    if (code === 'bad_response') return '受け取り口から思った返事が来ません。設定のURLと、公開の「アクセスできるユーザー：全員」を確かめてください。';
    if (code === 'unknown_type') return '受け取り口が古い版です。Code.gs を第4版に入れ替えてください。';
    return '受け取り口でうまく保存できませんでした（' + code + '）。';
  }
  function tryResolve(s) {
    if (!s || !s.shrine || s.shrine.source !== 'pending' || !s.location) return Promise.resolve();
    return findShrines(s.location.lat, s.location.lon).then(function (c) {
      if (!c.length) return;
      var x = c[0];
      s.shrine = { name: x.name, source: 'osm_later', osmType: x.type, osmId: x.id, lat: x.lat, lon: x.lon, distanceM: x.dist, confirmed: false, confirmedBy: 'later', confirmedAt: (s.shrine && s.shrine.confirmedAt) || null };
      s.candidates = c.slice(0, 8).map(function (k) { return { name: k.name, osmType: k.type, osmId: k.id, lat: k.lat, lon: k.lon, distanceM: k.dist }; });
      if (S.session && S.session.id === s.id) { S.session.shrine = s.shrine; S.session.candidates = s.candidates; }
      return dbPut('sessions', s);
    }).catch(function () {});
  }

  /* 送る。mode='all'（「送信する」を押したとき）は写真と撮影の終わりも送る。
     それ以外（起動・電波が戻ったとき・感想を入れたときなど）は、設定の「撮ったらすぐ送る」が入っていなければ
     感想・取り消し・投稿済みの知らせだけを送る */
  function pump(mode) {
    var all = mode === 'all' || !!S.settings.autoSend;
    if (DEMO || !S.settings.url || !S.settings.pass || !online()) { renderStatus(); return; }
    if (S.sending) { if (all) S.pendingAll = true; return; }
    S.sending = true; S.sendingAll = all; renderStatus();
    var sessCache = {};
    function sess(id) {
      if (S.session && S.session.id === id) return Promise.resolve(S.session);
      if (sessCache[id]) return Promise.resolve(sessCache[id]);
      return dbGet('sessions', id).then(function (s) { sessCache[id] = s; return s; });
    }
    var stop = false;
    dbAll('photos').then(function (photos) {
      var queue = !all ? [] : photos.filter(function (p) { return !p.sent && !p.deleted && !p.hold; }).sort(function (a, b) { return a.takenAt < b.takenAt ? -1 : 1; });
      return queue.reduce(function (chain, p) {
        return chain.then(function () {
          if (stop || S.cancelled[p.id]) return;
          S.sendingId = p.id;
          return sess(p.sessionId).then(function (s) {
            if (!s) return;
            return tryResolve(s).then(function () {
              var b = photoBlob(p); if (!b) return;
              return shrink(b).then(function (sm) {
                return toBase64(sm.blob).then(function (b64) {
                  var pairRec = s.pairs[p.pair - 1];
                  var shot = shotOfRec(p, pairRec);
                  return post({
                    type: 'photo', passphrase: S.settings.pass, version: 1,
                    photo: {
                      id: p.id, sessionId: s.id, date: s.date, shrine: s.shrine, candidates: s.candidates, location: s.location,
                      pair: pairPayload(pairRec, p.pair),
                      shot: { key: p.shot, label: shot.label, group: shot.group, side: shot.side || null, seq: p.seq },
                      kind: p.kind === 'art' ? 'art' : 'record', title: p.kind === 'art' ? (p.title || '') : '',
                      takenAt: p.takenAt, takenLocation: p.location, width: sm.w, height: sm.h, mime: 'image/jpeg', data: b64
                    }
                  }).then(function (r) {
                    // 送っている間に取り消された写真：記録を戻さない（取り消しの知らせは cancelPhoto が入れてある）
                    if (S.cancelled[p.id]) return;
                    if (r && r.ok && r.id === p.id) {
                      p.sent = true; p.sentAt = new Date().toISOString(); p.lastError = ''; p.remote = { file: r.file, folder: r.folder };
                      S.sendError = '';
                    } else {
                      var code = (r && r.error) || 'unknown';
                      p.lastError = code; S.sendError = errText(code);
                      if (code === 'wrong_passphrase' || code === 'bad_response') stop = true;
                    }
                    return putPhoto(p);
                  });
                });
              });
            });
          }).then(function () {
            S.sendingId = null;
            var lp = S.photos.find(function (x) { return x.id === p.id; }); if (lp) Object.assign(lp, { sent: p.sent, sentAt: p.sentAt, remote: p.remote });
            if (S.done) { var dp = S.done.photos.find(function (x) { return x.id === p.id; }); if (dp) Object.assign(dp, { sent: p.sent, sentAt: p.sentAt, remote: p.remote }); }
            refreshCounts();
          }, function (e) { S.sendingId = null; throw e; });
        });
      }, Promise.resolve());
    }).then(function () {
      if (stop) return;
      return dbAll('outbox').then(function (ob) {
        // 撮影の終わり（session）は、写真と一緒に「送信する」で送る
        var q = ob.filter(function (o) { return !o.sent && (all || o.kind !== 'session'); }).sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
        return q.reduce(function (chain, o) {
          return chain.then(function () {
            if (stop) return;
            var body = Object.assign({}, o.payload, { passphrase: S.settings.pass, version: 1 });
            var go = Promise.resolve();
            if (o.kind === 'session') {
              go = sess(o.payload.session.sessionId).then(function (s) { if (s) return tryResolve(s).then(function () { body.session = sessionInfo(s, o.payload.session.photoCount); }); });
            }
            return go.then(function () { return post(body); }).then(function (r) {
              if (r && r.ok) {
                o.sent = true; o.sentAt = new Date().toISOString();
                if (o.kind === 'kansou') { var st = S.kstate[o.itemId]; if (st) { st.sent = true; kvSet('kstate', S.kstate); } }
                if (o.kind === 'posted') {
                  var pv = r.posted || o.payload.posted;
                  S.posts.posted[o.itemId] = { via: pv.via, at: pv.postedAt, already: !!r.already };
                  if (r.already && pv.via !== 'iphone') toast('この投稿は、先に' + viaLabel(pv.via) + 'で投稿済みでした');
                }
              } else {
                var code = (r && r.error) || 'unknown';
                S.sendError = (o.kind === 'delphoto' && code === 'unknown_type') ? '受け取り口が古い版のため、写真の取り消しを受信箱に伝えられません。Code.gs を第4版に入れ替えてください。' : errText(code);
                if (code === 'wrong_passphrase' || code === 'bad_response') stop = true;
              }
              return dbPut('outbox', o);
            });
          });
        }, Promise.resolve());
      });
    }).catch(function () {
      S.sendError = all ? 'つながりませんでした。電波のある所で、もう一度「送信する」を押してください。' : 'つながりませんでした。電波のある所でアプリを開くと、続きを送ります。';
    }).then(function () {
      S.sending = false; S.sendingAll = false; S.sendingId = null; refreshCounts();
      if (S.tab === 'kansou') renderKansou();
      if (S.done) loadDone(S.done.s.id).then(function () { if (S.tab === 'shoot' && S.shootView === 'done') renderDoneStatus(); });
      if (S.pendingAll) { S.pendingAll = false; pump('all'); }
    });
  }

  function refreshCounts() {
    return Promise.all([dbAll('photos'), dbAll('outbox')]).then(function (r) {
      var c = { wait: 0, sent: 0, onDevice: 0, kwait: 0, swait: 0, dwait: 0 };
      r[0].forEach(function (p) { if (p.hold) return; if (p.deleted) { c.sent++; return; } if (p.sent) { c.sent++; c.onDevice++; } else c.wait++; });
      r[1].forEach(function (o) {
        if (o.sent) return;
        if (o.kind === 'kansou' || o.kind === 'posted') c.kwait++;
        else if (o.kind === 'session') c.swait++;
        else if (o.kind === 'delphoto') c.dwait++;
      });
      S.counts = c; renderStatus();
      if (S.tab === 'send') renderSend();
      if (S.tab === 'shoot' && S.shootView === 'done') renderDoneStatus();
    }).catch(function () {});
  }
  function anyToSend() { var c = S.counts; return !!(c.wait || c.swait || c.kwait || c.dwait); }

  function renderStatus() {
    var b = $('#status-band'), c = S.counts;
    b.className = 'status-band' + (S.sendError ? ' err' : c.wait ? ' wait' : '') + (S.sending ? ' busy' : '');
    var t;
    if (DEMO) t = '見本：送信待ち <b>' + c.wait + '枚</b>（見本のため送信しません）';
    else if (!S.settings.url || !S.settings.pass) t = '送信待ち <b>' + c.wait + '枚</b>・受け取り口が未設定です（右上の設定から）';
    else if (S.sendError) t = S.sendError;
    else if (S.sending) t = S.sendingAll ? '送信中… 残り <b>' + c.wait + '枚</b>' : '感想・取り消しの知らせを送っています…';
    else if (!online()) t = '電波なし・送信待ち <b>' + c.wait + '枚</b>（' + (S.settings.autoSend ? 'つながったら自動で送ります' : '電波のある所で「送信する」を押します') + '）';
    else if (c.wait) t = '送信待ち <b>' + c.wait + '枚</b>' + (S.settings.autoSend ? '' : '（「送信する」を押すと送ります）');
    else if (c.swait) t = '撮影の終わりの記録が送信待ちです（「送信する」を押すと送ります）';
    else t = 'すべて送信済み（' + c.sent + '枚）';
    b.innerHTML = '<span class="dot"></span><span>' + t + '</span>';
    var badge = document.querySelector('.tabs [data-tab="send"] .badge');
    var n = c.wait + c.kwait + c.swait + c.dwait;
    if (n) { if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; document.querySelector('.tabs [data-tab="send"]').appendChild(badge); } badge.textContent = n; }
    else if (badge) badge.remove();
  }

  /* ---------- 画面の切り替え ---------- */
  function render() {
    var views = { home: 'view-home', guide: 'view-guide', done: 'view-done', kansou: 'view-kansou', send: 'view-send', settings: 'view-settings' };
    if (S.tab === 'shoot' && S.shootView === 'done' && !S.done) S.shootView = S.session ? 'guide' : 'home';
    var show = S.tab === 'shoot' ? S.shootView : S.tab;
    if (show !== micViewOf()) micStop();
    Object.keys(views).forEach(function (k) { document.getElementById(views[k]).hidden = (k !== show); });
    document.querySelectorAll('.tabs [data-tab]').forEach(function (b) { if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (show === 'home') renderHome();
    else if (show === 'guide') renderGuide();
    else if (show === 'done') renderDone();
    else if (show === 'kansou') renderKansou();
    else if (show === 'send') renderSend();
    else if (show === 'settings') renderSettings();
    renderStatus(); renderArtBtn(); renderOverlay();
  }
  /* 見出しの「作品として撮る」：撮影中はどの画面からでもカメラを開く */
  var ICON_ART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 16l5-5 4 4 2.5-2.5 5.5 5.5"/><circle cx="15.5" cy="9.5" r="1.6"/></svg>';
  function renderArtBtn() {
    var w = $('#art-slot'); if (!w) return;
    if (S.session) {
      w.innerHTML = '<label class="art-btn">' + ICON_ART + '<span>作品として撮る</span><input class="vh" type="file" accept="image/*" data-act="art"></label>';
    } else {
      w.innerHTML = '<button type="button" class="art-btn off" data-act="art-nosession">' + ICON_ART + '<span>作品として撮る</span></button>';
    }
  }
  function renderOverlay() {
    var o = $('#overlay'); if (!o) return;
    if (!S.artId || !S.session) { o.innerHTML = ''; o.hidden = true; return; }
    var p = S.photos.find(function (x) { return x.id === S.artId; });
    if (!p) { o.innerHTML = ''; o.hidden = true; return; }
    var d = S.artDraft || { title: '', pair: p.pair };
    var b = photoBlob(p), src = b ? URL.createObjectURL(b) : '';
    if (src) thumbUrls.push(src);
    var pairs = [{ no: 0, label: '神社全体' }].concat(S.session.pairs.map(function (q) { return { no: q.no, label: pairTitle(q) }; }));
    o.hidden = false;
    o.innerHTML = '<div class="sheet-backdrop" data-act="art-close"></div><div class="sheet" role="dialog" aria-label="作品写真">' +
      '<div class="sheet-head"><h2 class="h3">作品写真</h2><button type="button" class="link-btn" data-act="art-close">閉じる</button></div>' +
      '<div class="sheet-body art-body">' +
      '<div class="art-ph">' + (src ? '<img src="' + src + '" alt="撮った作品写真">' : '') + '</div>' +
      '<div class="field"><label for="art-title">作品名（なくてもかまいません）</label><input id="art-title" type="text" autocomplete="off" enterkeyhint="done" value="' + esc(d.title) + '" placeholder="例：夕映えの随神門"></div>' +
      '<div class="field"><span class="flabel">どの写真として残すか</span><div class="chips" role="group" aria-label="紐づけ先">' + pairs.map(function (q) {
        return '<button type="button" class="chip" data-act="art-pair" data-no="' + q.no + '" aria-pressed="' + (d.pair === q.no) + '">' + esc(q.label) + '</button>';
      }).join('') + '</div></div>' +
      '<button type="button" class="btn primary wide" data-act="art-save">保存する</button>' +
      (S.confirmPhoto === p.id ? cancelBtnHTML(p) :
        '<div class="row">' + '<label class="btn ghost">撮り直す<input class="vh" type="file" accept="image/*" capture="environment" data-act="art-replace" data-id="' + esc(p.id) + '"></label>' +
        cancelBtnHTML(p, 'btn danger') + '</div>') +
      (wasSent(p) ? '<p class="hint">送信済みの写真です。作品名や紐づけ先を変えると、同じ写真として送り直します。取り消すと、受信箱からも消します。</p>' : '') +
      '</div></div>';
  }

  /* ---------- ホーム ---------- */
  var ICON_CAM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z"/><circle cx="12" cy="13.2" r="3.4"/></svg>';
  var ICON_TIP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="6.3"/><path d="M8 7.2v4M8 4.8v.1"/></svg>';

  function renderHome() {
    var v = $('#view-home');
    if (S.tab !== 'shoot' || S.shootView !== 'home') return;
    if (S.session) {
      var s = S.session, c = s.cursor;
      var where = c.mode === 'finish' ? '最後の確認' : c.mode === 'pairEnd' ? ('対' + c.pair + 'の撮影のあと') : c.pair === 0 ? ('神社の撮影・' + SHOTS[SHRINE_STEPS[c.step]].label) : ('対' + c.pair + '・' + (stepsOf(c.pair)[c.step] === '__opt' ? '任意の写真' : shotFor(c.pair, stepsOf(c.pair)[c.step]).label));
      var art = S.photos.filter(function (p) { return p.kind === 'art'; }).length;
      v.innerHTML = '<div class="pad">' +
        '<div class="here"><p class="eyebrow">撮影中</p><div class="name">' + esc(s.shrine.name || '神社名はあとで調べます') + '</div>' +
        '<div class="sub">' + esc(s.date) + '・写真 ' + S.photos.length + '枚' + (art ? '（作品 ' + art + '枚）' : '') + '・' + esc(where) + 'から</div></div>' +
        '<button type="button" class="btn primary big wide" data-act="resume">' + ICON_CAM + '続きを撮る</button>' +
        '<button type="button" class="btn wide" data-act="to-finish">この神社の撮影をおえる</button>' +
        sessDeleteHTML(s.id, s.shrine.name || '神社名はあとで調べます') +
        '</div>';
      return;
    }
    var h = S.here, body = '';
    var pos = h.pos ? '位置の誤差 約' + h.pos.accuracy + 'm' : '';
    var laterBtn = h.pos ? '<button type="button" class="btn wide" data-act="start-later">名前はあとで調べる（位置だけ保存して撮る）</button>' : '';
    var manualBox = function (label, primary) {
      return '<div class="panel"><h2 class="h3">' + esc(label) + '</h2>' + manualField('神社名') +
        '<button type="button" class="btn' + (primary ? ' primary' : '') + ' wide" data-act="start-manual"' + (h.manual.trim() ? '' : ' disabled') + '>入力した名前で撮る</button></div>';
    };
    if (h.status === 'idle') { locate(); return; }
    if (h.status === 'locating') body = '<p class="meta"><span class="spinner"></span>位置を調べています…</p>';
    else if (h.status === 'searching') body = '<p class="meta"><span class="spinner"></span>近くの神社を探しています…</p>';
    else if (h.status === 'found') {
      var sel = h.cands[h.sel];
      body = '<div class="ask"><p class="eyebrow">撮影の前に、神社名を確かめます</p>' +
        '<div class="name">' + esc(sel.name) + '</div><p class="q">でよいですか？</p>' +
        '<div class="sub">' + (h.sel === 0 ? '位置からいちばん近い神社' : '一覧から選んだ神社') + '・ここから ' + fmtDist(sel.dist) + '・' + pos + '</div></div>' +
        '<button type="button" class="btn primary big wide" data-act="start-ok">' + ICON_CAM + 'はい、この神社で撮る</button>' +
        (h.cands.length > 1 ? '<div class="panel"><h2 class="h3">ちがうときは選び直す（' + h.cands.length + '件）</h2><ul class="cands">' +
          h.cands.map(function (c, i) { return '<li><button type="button" data-act="pick" data-i="' + i + '" aria-pressed="' + (i === h.sel) + '"><span class="nm">' + esc(c.name) + '</span><span class="d">' + fmtDist(c.dist) + '</span></button></li>'; }).join('') +
          '</ul><p class="hint">選ぶと、上の名前が変わります。そのあと「はい」を押します。</p></div>' : '') +
        manualBox('一覧にないときは入力', false) + laterBtn;
    } else if (h.status === 'none') {
      body = '<div class="ask"><p class="eyebrow">撮影の前に、神社名を確かめます</p><div class="name">近くに見つかりません</div>' +
        '<div class="sub">半径500m以内に、地図に載った神社がありません。' + pos + '</div></div>' +
        manualBox('神社名を入力', true) +
        (h.pos ? '<div class="panel"><p class="prose">名前が分からないときは、位置だけ保存して撮れます。<b>神社名はあとで調べます。</b>よいですか？</p>' + laterBtn + '</div>' : '');
    } else if (h.status === 'offline') {
      body = '<div class="ask"><p class="eyebrow">撮影の前に、神社名を確かめます</p><div class="name">名前はあとで調べます</div>' +
        '<p class="q">よいですか？</p><div class="sub">電波がないため、いまは神社名を調べられません。位置（' + pos + '）を保存し、電波のある所で調べます。</div></div>' +
        '<button type="button" class="btn primary big wide" data-act="start-later">' + ICON_CAM + 'はい、位置だけ保存して撮る</button>' +
        manualBox('名前が分かるときは入力', false);
    } else if (h.status === 'noloc') {
      body = '<div class="ask"><p class="eyebrow">撮影の前に、神社名を確かめます</p><div class="name">位置が取れません</div></div>' +
        '<p class="msg">' + esc(h.error) + '</p>' + manualBox('神社名を入力してください', true);
    }
    v.innerHTML = '<div class="pad">' + body +
      (h.status !== 'locating' && h.status !== 'searching' ? '<div class="row"><button type="button" class="link-btn" data-act="relocate">位置をとり直す</button></div>' : '') +
      '<div class="panel"><h2 class="h3">撮る順番</h2><ol class="order">' +
      '<li><b>神社</b>：境内の案内図、鳥居からの全景</li>' +
      '<li><b>像の1対ごと</b>（狛犬・狐など）：場所と生き物 → 阿形（正面・斜め45度・真横・顔・尾）→ 吽形（同じ）→ 台座。1体だけのときは片方だけ</li>' +
      '<li><b>任意</b>：一対が並ぶ写真・文字・由緒書きなど</li>' +
      '<li><b>感想</b>：対ごとに、その場で書けます（話して入力もできます）</li>' +
      '</ol><p class="hint">どの手順も「とばす」で進めます。生き物は初めは狛犬になっています。いつでも右上の「作品として撮る」で、自由に作品写真を撮れます。写真は「送信する」を押したときにまとめて送ります。</p></div>' +
      '</div>';
  }
  function manualField(label) {
    return '<div class="field"><label for="manual-name">' + esc(label) + '</label><input id="manual-name" type="text" autocomplete="off" enterkeyhint="done" value="' + esc(S.here.manual) + '" placeholder="例：筑波山神社"></div>';
  }

  /* ---------- 見取り図（上から見た図） ---------- */
  function fig(kind, side, single) {
    var W = 240, H = 188;
    var A = { x: 178, y: 92 }, U = { x: 62, y: 92 };
    var T = side === 'u' ? U : A;
    var g = '<rect class="d-ground" x="0" y="0" width="' + W + '" height="' + H + '"/>';
    g += '<rect class="d-sando" x="102" y="22" width="36" height="166"/>';
    g += '<rect class="d-build" x="88" y="4" width="64" height="20" rx="2"/><text class="d-txt" x="120" y="17.5" text-anchor="middle">社殿</text>';
    g += '<path class="d-torii" d="M96 150h48M100 156h40M104 150v14M136 150v14"/>';
    var target = null, cam = null, half = 22, camLbl = 'ここから', baseOn = false, kOn = true;
    function komainu(K, on, lbl) {
      var s = '<rect class="d-base' + (on && baseOn ? ' on' : '') + '" x="' + (K.x - 17) + '" y="' + (K.y - 15) + '" width="34" height="34" rx="2"/>';
      s += '<path class="d-tail" d="M' + K.x + ' ' + (K.y - 8) + 'q6 -8 0 -12"/>';
      s += '<ellipse class="d-k' + (on && kOn ? ' on' : '') + '" cx="' + K.x + '" cy="' + K.y + '" rx="10" ry="12"/>';
      s += '<circle class="d-head' + (on && kOn ? ' on' : '') + '" cx="' + K.x + '" cy="' + (K.y + 12) + '" r="6.5"/>';
      s += '<text class="d-lbl" x="' + K.x + '" y="' + (K.y + 3) + '" text-anchor="middle">' + lbl + '</text>';
      return s;
    }
    var both = false;
    switch (kind) {
      case 'front': cam = { x: T.x, y: T.y + 58 }; target = { x: T.x, y: T.y + 4 }; break;
      case 'side': cam = { x: side === 'u' ? 12 : 228, y: T.y }; target = T; camLbl = '真横'; break;
      case 'face': cam = { x: T.x, y: T.y + 36 }; target = { x: T.x, y: T.y + 12 }; half = 14; camLbl = '寄る'; break;
      case 'tail': cam = { x: T.x, y: T.y - 44 }; target = { x: T.x, y: T.y - 10 }; half = 16; camLbl = '後ろ'; break;
      case 'base_front': cam = { x: T.x, y: T.y + 60 }; target = { x: T.x, y: T.y + 14 }; baseOn = true; kOn = false; both = true; break;
      case 'base_left': cam = { x: T.x - 48, y: T.y + 2 }; target = { x: T.x - 14, y: T.y + 2 }; baseOn = true; kOn = false; both = true; camLbl = '左'; break;
      case 'base_right': cam = { x: Math.min(228, T.x + 48), y: T.y + 2 }; target = { x: T.x + 14, y: T.y + 2 }; baseOn = true; kOn = false; both = true; camLbl = '右'; break;
      case 'base_back': cam = { x: T.x, y: T.y - 46 }; target = { x: T.x, y: T.y - 12 }; baseOn = true; kOn = false; both = true; camLbl = '後ろ'; break;
      // 斜め前45度：正面と、外側の真横のあいだ
      case 'diag': cam = { x: T.x + (side === 'u' ? 40 : -40), y: T.y + 46 };  /* 阿形は左前方から、吽形は右前方から（参道の側から狛犬に向かって） */ target = { x: T.x, y: T.y + 4 }; camLbl = '斜め45度'; break;
      case 'place': cam = { x: 120, y: 178 }; target = { x: 120, y: 40 }; half = 40; camLbl = '引いて'; both = true; break;
      case 'zenkei': cam = { x: 120, y: 178 }; target = { x: 120, y: 14 }; half = 24; camLbl = '鳥居の手前'; kOn = false; break;
      case 'board': break;
      default: break;
    }
    if (kind === 'board') {
      g += komainu(U, false, '吽') + komainu(A, false, '阿');
      g += '<rect class="d-board" x="10" y="128" width="56" height="30" rx="2"/><path class="d-tail" d="M18 137h40M18 144h28M18 151h34"/>';
      g += '<text class="d-txt" x="38" y="172" text-anchor="middle">案内図の看板</text>';
      cam = { x: 114, y: 126 }; target = { x: 66, y: 140 }; half = 26; camLbl = '正面から';
    } else if (kind === 'zenkei') {
      g += komainu(U, false, '吽') + komainu(A, false, '阿');
    } else {
      if (single) g += side === 'u' ? komainu(U, true, '吽') : komainu(A, true, '阿');
      else g += komainu(U, side === 'u' || (both && kind === 'place'), '吽') + komainu(A, side !== 'u' || (both && kind === 'place'), '阿');
    }
    if (cam && target) {
      var ang = Math.atan2(target.y - cam.y, target.x - cam.x), L = Math.hypot(target.x - cam.x, target.y - cam.y) + 14;
      var a1 = ang - half * Math.PI / 180, a2 = ang + half * Math.PI / 180;
      g += '<polygon class="d-cone" points="' + cam.x + ',' + cam.y + ' ' + (cam.x + Math.cos(a1) * L).toFixed(1) + ',' + (cam.y + Math.sin(a1) * L).toFixed(1) + ' ' + (cam.x + Math.cos(a2) * L).toFixed(1) + ',' + (cam.y + Math.sin(a2) * L).toFixed(1) + '"/>';
      var deg = (ang * 180 / Math.PI).toFixed(1);
      g += '<g transform="translate(' + cam.x + ' ' + cam.y + ') rotate(' + deg + ')"><rect class="d-cam" x="-9" y="-6.5" width="15" height="13" rx="2.5"/><rect class="d-cam" x="5" y="-3.5" width="5" height="7" rx="1"/><circle class="d-lens" cx="-1.5" cy="0" r="3"/></g>';
      var lx = cam.x, ly = cam.y + 18, anchor = 'middle';
      if (cam.y > H - 20) { ly = cam.y - 12; lx = cam.x + 34; anchor = 'start'; if (kind === 'place' || kind === 'zenkei') { lx = cam.x + 14; ly = cam.y + 4; } }
      if (cam.y < 60) { ly = cam.y - 11; }
      if (kind === 'side') { ly = cam.y + 22; lx = cam.x; anchor = side === 'u' ? 'start' : 'end'; lx = side === 'u' ? 4 : 236; }
      if (kind === 'diag') { ly = cam.y - 14; anchor = side === 'u' ? 'start' : 'end'; lx = cam.x + (side === 'u' ? 12 : -12); }
      if (kind === 'board') { ly = cam.y - 14; lx = cam.x + 4; anchor = 'start'; }
      g += '<text class="d-cam-lbl" x="' + lx + '" y="' + ly + '" text-anchor="' + anchor + '">' + camLbl + '</text>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="立ち位置の図：上から見た境内。カメラの印の所から撮ります">' + g + '</svg>';
  }

  /* ---------- 撮影の案内 ---------- */
  // capture を付けない入力：iPhone では「写真ライブラリ／写真を撮る／ファイルを選択」が出る。
  // 標準のカメラアプリ（広角・望遠・ポートレートなど）で撮った写真を選べる
  function libraryLabel(cls, html, act, pair, shot) {
    return '<label class="' + cls + '">' + html + '<input class="vh" type="file" accept="image/*" data-act="' + act + '" data-pair="' + pair + '" data-shot="' + shot + '"></label>';
  }
  function captureLabel(cls, html, act, pair, shot, id) {
    return '<label class="' + cls + '">' + html + '<input class="vh" type="file" accept="image/*" capture="environment" data-act="' + act + '" data-pair="' + pair + '" data-shot="' + shot + '"' + (id ? ' data-id="' + id + '"' : '') + '></label>';
  }
  // withLabel：任意の写真の一覧では、何の写真かを下に出す
  function thumbsHTML(list, pair, shot, withLabel) {
    thumbUrls.forEach(function (u) { URL.revokeObjectURL(u); }); thumbUrls = [];
    return '<div class="thumbs">' + list.map(function (p) {
      var b = photoBlob(p), src = '';
      if (b) { src = URL.createObjectURL(b); thumbUrls.push(src); }
      var conf = S.confirmPhoto === p.id;
      return '<div class="thumb' + (conf ? ' asking' : '') + '"><div class="ph">' + (src ? '<img src="' + src + '" alt="撮った写真">' : '') +
        '<span class="st' + (p.sent ? ' sent' : '') + '">' + (p.sent ? '送信済み' : '送信待ち') + '</span></div>' +
        (withLabel ? '<span class="cap">' + esc(shotFor(pair, p.shot).label) + '</span>' : '') +
        (conf ? '' : captureLabel('btn ghost', '撮り直し', 'replace', pair, shot || p.shot, p.id)) +
        cancelBtnHTML(p, 'btn ghost') + '</div>';
    }).join('') + '</div>';
  }
  function progressHTML(pair, cur) {
    var list = stepsOf(pair).filter(function (k) { return k !== '__opt'; });
    return '<div class="progress" aria-hidden="true">' + list.map(function (k, i) {
      var cls = i === cur ? 'now' : photosOf(pair, k).length ? 'done' : S.session.skips[skipKey(pair, k)] ? 'skip' : '';
      return '<span class="' + cls + '"></span>';
    }).join('') + '</div>';
  }

  function renderGuide(scrollTop) {
    var v = $('#view-guide');
    if (!S.session) { S.shootView = 'home'; render(); return; }
    var s = S.session, c = s.cursor;
    var shrineName = s.shrine.name || '神社名はあとで調べます';
    var head = '<div class="guide-head"><button type="button" class="link-btn" data-act="home">中断</button><span class="where">' + esc(shrineName) + '</span><button type="button" class="link-btn" data-act="steps">手順一覧</button></div>';
    var html;
    if (c.mode === 'pairEnd') html = pairEndHTML(c.pair);
    else if (c.mode === 'finish') html = finishHTML();
    else {
      var key = stepsOf(c.pair)[c.step];
      html = key === '__opt' ? optHTML(c.pair) : stepHTML(c.pair, c.step, key);
    }
    v.innerHTML = '<div class="guide">' + head + html + (S.sheet ? sheetHTML() : '') + '</div>';
    if (scrollTop) v.scrollTop = 0;
  }

  function stepHTML(pair, step, key) {
    var sh = shotFor(pair, key), list = photosOf(pair, key);
    var total = stepsOf(pair).filter(function (k) { return k !== '__opt'; }).length;
    var label = pair === 0 ? '神社　' + (step + 1) + ' / ' + total : '対' + pair + '　' + (step + 1) + ' / ' + total;
    var extra = '';
    if (key === 'place') {
      var p = pairOf(pair);
      extra = '<div class="chips" role="group" aria-label="対の場所">' + PLACES.map(function (pl) {
        return '<button type="button" class="chip" data-act="place" data-v="' + esc(pl) + '" aria-pressed="' + (p.place === pl) + '">' + esc(pl) + '</button>';
      }).join('') + '</div>' +
        (p.place === 'その他' ? '<div class="field"><label for="place-other">場所（その他）</label><input id="place-other" type="text" value="' + esc(p.placeOther) + '" placeholder="例：二の鳥居の先"></div>' : '') +
        pairKindHTML(p);
    }
    var actions;
    if (!list.length) {
      actions = captureLabel('btn primary big wide', ICON_CAM + '撮影する', 'shoot', pair, key) +
        libraryLabel('btn wide', 'カメラアプリで撮った写真を選ぶ', 'shoot', pair, key) +
        '<div class="row"><button type="button" class="btn ghost" data-act="prev"' + (pair === 0 && step === 0 ? ' disabled' : '') + '>戻る</button><button type="button" class="btn ghost" data-act="skip">とばす</button></div>';
    } else {
      actions = '<button type="button" class="btn primary big wide" data-act="next">次へ</button>' +
        '<div class="row"><button type="button" class="btn ghost" data-act="prev"' + (pair === 0 && step === 0 ? ' disabled' : '') + '>戻る</button>' +
        captureLabel('btn', esc(sh.more || 'もう1枚'), 'more', pair, key) + '</div>' +
        libraryLabel('btn ghost wide', 'カメラアプリで撮った写真を選ぶ', 'more', pair, key);
    }
    return progressHTML(pair, step) +
      '<div class="guide-body">' +
      '<div class="stepno"><span class="k">' + label + '</span>' + (sh.isText ? '<span class="tag">文字</span>' : '') + '</div>' +
      '<div class="diagram">' + fig(sh.fig, sh.figSide || sh.side, !!sh.single) + '</div>' +
      '<h2 class="h2">' + esc(sh.title) + '</h2>' +
      '<p class="instr">' + esc(sh.text) + '</p>' +
      (sh.tip ? '<p class="tip">' + ICON_TIP + '<span>' + esc(sh.tip) + '</span></p>' : '') +
      extra +
      (list.length ? thumbsHTML(list, pair, key) : '') +
      '</div>' +
      '<div class="guide-actions">' + actions + '</div>';
  }

  /* 対の場所の画面：生き物と、一対／1体だけ */
  function pairKindHTML(p) {
    var a = animalOf(p);
    var h = '<div class="field kind-field"><span class="flabel">生き物</span><div class="chips" role="group" aria-label="生き物">' + ANIMALS.map(function (x) {
      return '<button type="button" class="chip" data-act="animal" data-v="' + x.id + '" aria-pressed="' + (a === x.id) + '">' + esc(x.name) + '</button>';
    }).join('') + '</div></div>';
    h += '<div class="field kind-field"><span class="flabel">数</span><div class="chips" role="group" aria-label="一対か1体だけか">' +
      '<button type="button" class="chip" data-act="pair-mode" data-v="pair" aria-pressed="' + !p.single + '">一対（2体）</button>' +
      '<button type="button" class="chip" data-act="pair-mode" data-v="single" aria-pressed="' + !!p.single + '">1体だけ</button></div></div>';
    if (p.single) {
      var sd = p.side === 'a' || p.side === 'u' ? p.side : 'unknown';
      h += '<div class="field kind-field"><span class="flabel">残っている1体は</span><div class="chips" role="group" aria-label="阿形か吽形か">' + SIDES.map(function (x) {
        return '<button type="button" class="chip" data-act="single-side" data-v="' + x.v + '" aria-pressed="' + (sd === x.v) + '">' + esc(x.name) + '</button>';
      }).join('') + '</div><p class="hint">1体だけのときは、もう片方の手順をとばします。</p></div>';
    }
    return h;
  }
  /* 一対／1体だけ・阿吽を変えたとき：撮った写真の画角キーを合わせ、送った写真は送り直す */
  function sigOf(p, pr) { var sh = shotOfRec(p, pr); return p.shot + '|' + (sh.side || '') + '|' + sh.label; }
  function applyPairKind(pr, mode, side) {
    var old = { single: !!pr.single, side: pr.side };
    var recs = S.photos.filter(function (p) { return p.pair === pr.no && p.kind !== 'art' && /^[au]_/.test(p.shot); });
    var before = {}; recs.forEach(function (p) { before[p.id] = sigOf(p, old); });
    var hasA = recs.some(function (p) { return p.shot.charAt(0) === 'a'; }), hasU = recs.some(function (p) { return p.shot.charAt(0) === 'u'; });
    if (mode === 'single') {
      if (pr.single) return;
      if (hasA && hasU) { toast('阿形と吽形の両方に写真があるので、1体だけにはできません'); return; }
      pr.single = true; pr.side = hasU ? 'u' : hasA ? 'a' : 'unknown';
    } else if (mode === 'pair') {
      if (!pr.single) return;
      pr.single = false; pr.side = null;
    } else {
      if (!pr.single || pr.side === side) return;
      pr.side = side;
    }
    // 1体だけ：撮る側の画角キーにそろえる（a_* ⇔ u_*）。とばした記録も合わせる
    if (pr.single) {
      var want = singlePrefix(pr);
      Object.keys(S.session.skips).forEach(function (k) {
        var m = k.match(/^(\d+):([au])(_.+)$/);
        if (m && +m[1] === pr.no && m[2] !== want) { delete S.session.skips[k]; S.session.skips[m[1] + ':' + want + m[3]] = true; }
      });
      recs.forEach(function (p) { if (p.shot.charAt(0) !== want) p.shot = want + p.shot.slice(1); });
    }
    var saves = recs.map(function (p) {
      if (sigOf(p, pr) === before[p.id]) return null;
      if (p.sent) { p.sent = false; p.sentAt = null; }   // 同じIDで送り直す → 受け取り口で上書き
      return putPhoto(p);
    }).filter(Boolean);
    S.session.cursor.step = Math.min(S.session.cursor.step, stepsOf(pr.no).length - 1);
    Promise.all(saves).then(saveSession).then(loadSessionPhotos).then(function () { renderGuide(); refreshCounts(); if (saves.length) pump(); });
  }

  function optHTML(pair) {
    var keys = optShotsOf(pairOf(pair));
    var taken = [];
    keys.forEach(function (k) { taken = taken.concat(photosOf(pair, k)); });
    return progressHTML(pair, -1) + '<div class="guide-body">' +
      '<div class="stepno"><span class="k">対' + pair + '　任意</span></div>' +
      '<h2 class="h2">ほかに撮るもの</h2><p class="instr">あれば撮ります。なければそのまま「この対はおわり」。</p>' +
      '<div class="opt-grid">' + keys.map(function (k) {
        var n = photosOf(pair, k).length, sh = shotFor(pair, k);
        return captureLabel('opt-tile', '<span class="t">' + esc(sh.label) + '</span><span class="s">' + esc(sh.text) + '</span>' + (n ? '<span class="n">' + n + '枚 撮影済み</span>' : ''), 'more', pair, k);
      }).join('') + '</div>' +
      (taken.length ? '<h3 class="h3">撮った写真</h3>' + thumbsHTML(taken, pair, null, true) : '') +
      '<p class="tip">' + ICON_TIP + '<span>' + esc(TEXT_TIP) + '</span></p>' +
      '</div><div class="guide-actions"><button type="button" class="btn primary big wide" data-act="next">この対はおわり</button>' +
      '<div class="row"><button type="button" class="btn ghost" data-act="prev">戻る</button></div></div>';
  }

  function pairStats(pair) {
    var list = photosInPair(pair), pr = pairOf(pair);
    var sides = pr && pr.single ? [singlePrefix(pr) + '_side'] : ['a_side', 'u_side'];
    return { photos: list.length, art: list.filter(function (p) { return p.kind === 'art'; }).length,
      sideKey: sides[0], noSide: sides.every(function (k) { return !photosOf(pair, k).length; }) };
  }
  function pairEndHTML(pair) {
    var st = pairStats(pair), p = pairOf(pair);
    var body;
    if (!st.photos) {
      body = '<h2 class="h2">この対はまだ写真がありません</h2>' +
        '<p class="instr">1枚でも撮れば記録になります。撮らないときは、この対は記録に残しません。</p>';
    } else {
      // 撮れた枚数だけを出す。真横がないときは責めない一言の提案だけ
      var hint = st.noSide ? '<p class="tip">' + ICON_TIP + '<span>もし撮れそうなら、真横からの1枚があると構え型かどうかを見分けやすくなります。<button type="button" class="link-btn" data-act="jump" data-pair="' + pair + '" data-i="' + stepsOf(pair).indexOf(st.sideKey) + '">真横の手順へ</button></span></p>' : '';
      body = '<h2 class="h2">この対の撮影がおわりました</h2>' +
        '<p class="count-big"><b>' + st.photos + '</b>枚 撮れました' + (st.art ? '<span class="meta">（うち作品 ' + st.art + '枚）</span>' : '') + '</p>' + hint +
        pairKansouHTML(S.session, p, 'この対の感想') +
        '<p class="instr">同じ神社にほかの像（狛犬・狐など）がいれば、次の対へ進みます。</p>';
    }
    var nextNo = st.photos ? S.session.pairs.length + 1 : pair;
    return '<div class="guide-body">' +
      '<p class="eyebrow">' + esc(pairTitle(p) || ('対' + pair)) + '</p>' + body +
      '</div><div class="guide-actions">' +
      (st.photos ? '<button type="button" class="btn primary big wide" data-act="new-pair">次の対を撮る（対' + nextNo + '）</button>'
        : '<button type="button" class="btn primary big wide" data-act="jump" data-pair="' + pair + '" data-i="0">戻って撮る</button>') +
      '<div class="row"><button type="button" class="btn ghost" data-act="prev">戻る</button><button type="button" class="btn" data-act="to-finish">神社の撮影をおえる</button></div></div>';
  }
  function finishHTML() {
    var total = S.photos.length, art = S.photos.filter(function (p) { return p.kind === 'art'; }).length;
    var used = S.session.pairs.filter(function (p) { return photosInPair(p.no).length; }), pairs = used.length;
    var byA = {}; used.forEach(function (p) { var n = animalName(animalOf(p)); byA[n] = (byA[n] || 0) + 1; });
    var breakdown = Object.keys(byA).map(function (n) { return n + ' ' + byA[n]; }).join('・');
    var name = S.session.shrine.name || 'この神社';
    if (!total) {
      return '<div class="guide-body">' +
        '<p class="eyebrow">最後の確認</p><h2 class="h2">' + esc(name) + 'の撮影をおえる</h2>' +
        '<p class="instr">まだ写真がありません。1枚以上撮ると、おえられます。</p>' +
        (S.confirmDiscard ? '<div class="confirm"><p class="prose">この撮影の記録を消して、はじめの画面に戻ります。</p><div class="row"><button type="button" class="btn danger" data-act="discard">消して戻る</button><button type="button" class="btn ghost" data-act="cancel-discard">やめる</button></div></div>' : '') +
        '</div><div class="guide-actions"><button type="button" class="btn primary big wide" data-act="prev">戻って撮る</button>' +
        '<div class="row"><button type="button" class="btn ghost" data-act="ask-discard">撮らずにやめる</button></div></div>';
    }
    return '<div class="guide-body">' +
      '<p class="eyebrow">最後の確認</p><h2 class="h2">' + esc(name) + 'の撮影をおえる</h2>' +
      '<p class="count-big"><b>' + total + '</b>枚 撮れました' + (art ? '<span class="meta">（うち作品 ' + art + '枚）</span>' : '') + '</p>' +
      '<p class="meta">' + pairs + '対' + (pairs ? '（' + esc(breakdown) + '）' : '') + '</p>' +
      (used.length ? '<section class="pk-list"><h3 class="h3">対ごとの感想</h3><p class="hint">送信する前なら、あとから直せます。</p>' +
        used.map(function (p) { return pairKansouHTML(S.session, p); }).join('') + '</section>' : '') +
      '<p class="hint">' + (S.settings.autoSend ? 'おえたあとも、写真は電波のある所で順に送ります。' : 'おえたあとの画面か「送信」の画面で「送信する」を押すと、写真と感想をまとめて送ります。') + '送った写真から、分類・調査・見取り図の下書きが進みます。</p>' +
      '</div><div class="guide-actions"><button type="button" class="btn primary big wide" data-act="finish">撮影をおえる</button>' +
      '<div class="row"><button type="button" class="btn ghost" data-act="prev">戻る</button></div></div>';
  }
  function sheetHTML() {
    var s = S.session, c = s.cursor, out = '';
    function item(pair, i, k) {
      var n = photosOf(pair, k).length, sk = s.skips[skipKey(pair, k)];
      var cur = c.mode === 'step' && c.pair === pair && c.step === i;
      var lbl = k === '__opt' ? '任意の写真' : shotFor(pair, k).label;
      var stt = k === '__opt' ? (OPT_SHOTS.concat(LEGACY_OPT).reduce(function (m, o) { return m + photosOf(pair, o).length; }, 0) + '枚') : n ? n + '枚' : sk ? 'とばした' : '';
      return '<li><button type="button" data-act="jump" data-pair="' + pair + '" data-i="' + i + '"' + (cur ? ' aria-current="step"' : '') + '><span class="i">' + (k === '__opt' ? '任' : i + (pair === 0 ? 1 : 0)) + '</span><span>' + esc(lbl) + '</span><span class="s' + (n ? ' done' : '') + '">' + stt + '</span></button></li>';
    }
    out += '<li class="grp">神社</li>' + SHRINE_STEPS.map(function (k, i) { return item(0, i, k); }).join('');
    s.pairs.forEach(function (p) {
      out += '<li class="grp">' + esc(pairTitle(p)) + '</li>' + stepsOf(p.no).map(function (k, i) { return item(p.no, i, k); }).join('');
    });
    var arts = S.photos.filter(function (p) { return p.kind === 'art'; });
    if (arts.length) {
      out += '<li class="grp">作品写真</li>' + arts.map(function (p, i) {
        return '<li class="art-li"><div class="art-row"><button type="button" data-act="art-open" data-id="' + esc(p.id) + '"><span class="i">' + (i + 1) + '</span><span>' + esc(p.title || '作品名なし') + '</span><span class="s">' + (p.pair ? '対' + p.pair : '神社全体') + '</span></button>' +
          (S.confirmPhoto === p.id ? '' : cancelBtnHTML(p, 'link-btn')) + '</div>' + (S.confirmPhoto === p.id ? cancelBtnHTML(p) : '') + '</li>';
      }).join('');
    }
    return '<div class="sheet-backdrop" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-label="手順の一覧"><div class="sheet-head"><h2 class="h3">手順の一覧</h2><button type="button" class="link-btn" data-act="close-sheet">閉じる</button></div>' +
      '<div class="sheet-body"><ul class="steplist">' + out + '</ul></div></div>';
  }

  /* ---------- 対ごとの感想の欄 ---------- */
  function pairKansouHTML(s, p, label) {
    var id = 'pk-' + s.id + '-' + p.no;
    return '<div class="field pk"><div class="label-row"><label for="' + esc(id) + '">' + esc(label || (pairTitle(p) + ' の感想')) + '</label>' + micBtnHTML(id) + '</div>' +
      '<textarea id="' + esc(id) + '" data-pk="1" data-sid="' + esc(s.id) + '" data-pair="' + p.no + '" placeholder="その場で感じたこと、いちばん印象に残ったところ（なくてもかまいません）">' + esc(p.kansou || '') + '</textarea>' +
      micNoteHTML(id) + '</div>';
  }

  /* ---------- 音声入力（感想の欄の横のマイク） ----------
     iPhone の Safari では、ボタンを押した操作の中で start() を呼ぶ必要がある（あとから呼ぶと止められる）。
     確定した文は、欄のカーソルの位置（なければ末尾）に足す。途中経過は欄の下に小さく出す。 */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var mic = { rec: null, target: null, view: null };
  var caret = {};   // 欄ごとの最後のカーソル位置
  var ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5v3"/></svg>';
  function micBtnHTML(id) {
    if (!SR) return '';
    var on = mic.rec && mic.target === id;
    return '<button type="button" class="mic-btn' + (on ? ' on' : '') + '" data-act="mic" data-for="' + esc(id) + '" aria-pressed="' + !!on + '">' + ICON_MIC + '<span>' + (on ? '止める' : '話して入力') + '</span></button>';
  }
  function micNoteHTML(id) {
    if (!SR) return '<p class="hint mic-note">キーボードのマイクのボタンでも音声入力できます。</p>';
    return '<p class="mic-live" id="ml-' + esc(id) + '"' + (mic.rec && mic.target === id ? '' : ' hidden') + '>' + (mic.rec && mic.target === id ? '聞いています…' : '') + '</p>';
  }
  function micViewOf() { return mic.view; }
  function micUI() {
    document.querySelectorAll('.mic-btn').forEach(function (b) {
      var on = !!mic.rec && b.dataset.for === mic.target;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
      var sp = b.querySelector('span'); if (sp) sp.textContent = on ? '止める' : '話して入力';
    });
    document.querySelectorAll('.mic-live').forEach(function (l) {
      var on = !!mic.rec && l.id === 'ml-' + mic.target;
      l.hidden = !on; if (!on) l.textContent = '';
    });
  }
  function micLive(text) {
    var l = document.getElementById('ml-' + mic.target); if (!l) return;
    l.hidden = false; l.textContent = text ? '聞き取り中：' + text : '聞いています…';
  }
  function micInsert(text) {
    var ta = document.getElementById(mic.target);
    text = (text || '').trim(); if (!ta || !text) return;
    var v = ta.value, pos = caret[mic.target];
    if (pos == null || pos > v.length) pos = v.length;
    var before = v.slice(0, pos), after = v.slice(pos);
    var sep = before && !/[\s。、！？!?]$/.test(before) ? '、' : '';
    if (before && /\n$/.test(before)) sep = '';
    ta.value = before + sep + text + after;
    caret[mic.target] = (before + sep + text).length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function micStop() {
    var r = mic.rec; if (!r) return;
    mic.rec = null;
    try { r.stop(); } catch (e) { /* もう止まっている */ }
    micUI();
  }
  function micStart(id) {
    if (mic.rec) { var same = mic.target === id; micStop(); if (same) return; }
    if (!SR) { toast('キーボードのマイクのボタンでも音声入力できます'); return; }
    var r;
    try { r = new SR(); } catch (e) { toast('音声入力を始められませんでした。キーボードのマイクのボタンでも音声入力できます'); return; }
    r.lang = 'ja-JP'; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
    mic.rec = r; mic.target = id; mic.view = S.tab === 'shoot' ? S.shootView : S.tab;
    r.onresult = function (e) {
      if (mic.rec !== r) return;
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var res = e.results[i];
        if (res.isFinal) micInsert(res[0].transcript); else interim += res[0].transcript;
      }
      micLive(interim);
    };
    r.onerror = function (e) {
      var code = e && e.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') toast('マイクの利用が許可されていません。キーボードのマイクのボタンでも音声入力できます');
      else if (code === 'no-speech') toast('声が聞き取れませんでした。もう一度押してください');
      else if (code !== 'aborted') toast('音声入力が止まりました。キーボードのマイクのボタンでも音声入力できます');
    };
    r.onend = function () { if (mic.rec === r) { mic.rec = null; micUI(); } };
    try { r.start(); } catch (e) { mic.rec = null; toast('音声入力を始められませんでした。もう一度押してください'); }
    micUI(); if (mic.rec) micLive('');
  }
  ['keyup', 'click', 'select', 'input', 'focusout'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      var t = e.target;
      if (t && t.tagName === 'TEXTAREA' && t.id && typeof t.selectionEnd === 'number' && document.activeElement === t) caret[t.id] = t.selectionEnd;
    }, true);
  });

  /* ---------- 撮影をおえたあとの画面 ---------- */
  function doneCounts() {
    var d = S.done; if (!d) return { wait: 0, sent: 0, n: 0 };
    var c = { wait: 0, sent: 0, n: 0 };
    d.photos.forEach(function (p) { if (p.hold) return; c.n++; if (p.sent || p.deleted) c.sent++; else c.wait++; });
    c.msgWait = !!(d.msg && !d.msg.sent);
    return c;
  }
  function doneStatusHTML() {
    var c = doneCounts(), noSet = !S.settings.url || !S.settings.pass, all = S.counts;
    var msg;
    if (DEMO) msg = '<p class="msg">見本のため、送信はしません。</p>';
    else if (noSet) msg = '<p class="msg">受け取り口のURLと合言葉がまだ設定されていないため、送信できません。<button type="button" class="link-btn" data-act="open-settings">設定を開く</button></p>';
    else if (S.sending && S.sendingAll) msg = '<p class="meta"><span class="spinner"></span>送信中…</p>';
    else if (!c.wait && !c.msgWait) msg = '<p class="msg ok">この神社の写真と感想は、すべて送信しました。</p>';
    else msg = '<p class="meta">この神社：送信待ち <b>' + c.wait + '枚</b>' + (c.msgWait ? '・対ごとの感想と撮影の記録' : '') + '</p>';
    var can = !DEMO && !noSet && !S.sending && anyToSend();
    return msg + (S.sendError && !DEMO ? '<p class="msg bad">' + esc(S.sendError) + '</p>' : '') +
      '<button type="button" class="btn primary big wide" data-act="pump"' + (can ? '' : ' disabled') + '>' + (S.sending && S.sendingAll ? '送信中…' : '送信する' + (all.wait ? '（' + all.wait + '枚）' : '')) + '</button>' +
      '<p class="hint">' + (online() ? '' : '電波がありません。電波のある所で押してください。') + 'ほかの神社の送信待ちも一緒に送ります。</p>';
  }
  function renderDoneStatus() { var b = document.getElementById('done-status'); if (b) b.innerHTML = doneStatusHTML(); }
  function renderDone() {
    var v = $('#view-done'), d = S.done; if (!d) return;
    var s = d.s, c = doneCounts();
    var used = s.pairs.filter(function (p) { return d.photos.some(function (x) { return x.pair === p.no && !x.hold; }); });
    var art = d.photos.filter(function (p) { return p.kind === 'art'; }).length;
    v.innerHTML = '<div class="pad">' +
      '<div class="here"><p class="eyebrow">撮影をおえました</p><div class="name">' + esc(s.shrine.name || '神社名はあとで調べます') + '</div>' +
      '<div class="sub">' + esc(s.date) + '・写真 ' + c.n + '枚' + (art ? '（作品 ' + art + '枚）' : '') + '・' + used.length + '対</div></div>' +
      '<div id="done-status" class="stack">' + doneStatusHTML() + '</div>' +
      (used.length ? '<section class="pk-list"><h2 class="h3">対ごとの感想</h2><p class="hint">送信する前に直せます。送ったあとに直したときは、もう一度「送信する」を押すと送り直します。</p>' +
        used.map(function (p) { return pairKansouHTML(s, p); }).join('') + '</section>' : '') +
      (S.session ? '<button type="button" class="btn wide" data-act="resume">撮影中の神社に戻る</button>' : '<button type="button" class="btn wide" data-act="done-home">次の神社を撮る</button>') +
      '</div>';
  }

  /* ---------- 送信の画面 ---------- */
  function renderSend() {
    var v = $('#view-send');
    Promise.all([dbAll('sessions'), dbAll('photos')]).then(function (r) {
      var sessions = r[0].sort(function (a, b) { return a.startedAt < b.startedAt ? 1 : -1; });
      var byS = {};
      r[1].forEach(function (p) { var x = byS[p.sessionId] || (byS[p.sessionId] = { n: 0, sent: 0, wait: 0 }); x.n++; if (p.sent) x.sent++; else if (!p.deleted) x.wait++; });
      var c = S.counts;
      var noSet = !S.settings.url || !S.settings.pass;
      v.innerHTML = '<div class="pad">' +
        '<div class="counts"><div><b>' + c.wait + '</b><span>送信待ち</span></div><div><b>' + c.sent + '</b><span>送信済み</span></div><div><b>' + c.onDevice + '</b><span>送信済みで端末に残る</span></div></div>' +
        (DEMO ? '<p class="msg">見本のため、送信はしません。</p>' : noSet ? '<p class="msg">受け取り口のURLと合言葉がまだ設定されていないため、送信できません。<button type="button" class="link-btn" data-act="open-settings">設定を開く</button></p>' : '') +
        (S.sendError && !DEMO ? '<p class="msg bad">' + esc(S.sendError) + '</p>' : '') +
        '<button type="button" class="btn primary big wide" data-act="pump"' + (DEMO || noSet || S.sending || !anyToSend() ? ' disabled' : '') + '>' + (S.sending && S.sendingAll ? '送信中…' : '送信する' + (c.wait ? '（' + c.wait + '枚）' : '')) + '</button>' +
        '<p class="hint">' + (S.settings.autoSend ? '設定で「撮ったらすぐ送る」になっています。電波があれば撮るたびに送ります。' : '写真と対ごとの感想は「送信する」を押したときにまとめて送ります（撮影の途中でも送れます）。') +
        '感想タブの感想と、写真の取り消しの知らせは、電波があれば自動で送ります。写真は長辺2400pxに縮めて送り、端末には元の写真が残ります。</p>' +
        (S.confirmDelete ?
          '<div class="confirm"><p class="prose">受け取り口に届いたことを確かめた写真 ' + c.onDevice + '枚を、この端末から消します。送信待ちの写真は消しません。iPhoneの写真アプリには残りません（このアプリの中だけの写真です）。</p><div class="row"><button type="button" class="btn danger" data-act="delete-sent">消す</button><button type="button" class="btn ghost" data-act="cancel-delete">やめる</button></div></div>' :
          '<button type="button" class="btn wide" data-act="ask-delete"' + (c.onDevice ? '' : ' disabled') + '>送信済みの写真を端末から消す（' + c.onDevice + '枚）</button>') +
        '<h2 class="h3">撮影の記録</h2>' +
        (sessions.length ? '<ul class="sess">' + sessions.map(function (s) {
          var x = byS[s.id] || { n: 0, sent: 0, wait: 0 };
          var nm = s.shrine && s.shrine.name ? s.shrine.name : (s.location ? '位置のみ（' + s.location.lat.toFixed(4) + ', ' + s.location.lon.toFixed(4) + '）' : '名前なし');
          var nk = (s.pairs || []).filter(function (p) { return (p.kansou || '').trim(); }).length;
          return '<li><span class="nm">' + esc(nm) + (s.demo ? '<span class="sample-tag">見本</span>' : '') + '</span><span class="sub">' + esc(s.date) + '・' + s.pairs.length + '対・写真 ' + x.n + '枚（送信済み ' + x.sent + '・送信待ち ' + x.wait + '）' + (nk ? '・感想 ' + nk + '対' : '') + (s.status === 'shooting' ? '・撮影中' : '') + '</span>' +
            (s.status === 'done' ? '<button type="button" class="link-btn" data-act="open-done" data-id="' + esc(s.id) + '">対ごとの感想を見る・直す</button>' : '') +
            sessDeleteHTML(s.id, nm) + '</li>';
        }).join('') + '</ul>' : '<p class="meta">まだ撮影の記録はありません。</p>') +
        '</div>';
    });
  }

  /* ---------- 感想の画面 ---------- */
  var DEMO_MACHI = {
    schema: 'komainu-kansou-machi/1', updatedAt: new Date().toISOString(),
    items: [{
      id: 'sample-1', sessionId: 's-sample', folderName: '2026-10-26_見本神社', sample: true,
      shrine: { name: '見本神社', kana: 'みほんじんじゃ', address: '〇〇県〇〇市' }, pairNo: 1, place: '拝殿前',
      photo: { thumb: '' },
      draft: { regionalTypes: ['江戸流れ（形から推定）'], pose: '構え型', material: '石造（花崗岩・推定）', maker: '石工 〇〇〇〇（台座の銘）', year: '〇〇〇〇年（台座の銘）', notes: '吽形の尾が巻き毛。台座の左側面に年号。' },
      mapSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 140"><rect width="200" height="140" fill="#fff"/><rect x="88" y="20" width="24" height="120" fill="#e6ebe4"/><rect x="74" y="6" width="52" height="18" fill="#81d4ca" stroke="#2b2b2b"/><path d="M80 120h40M84 126h32M88 120v14M112 120v14" stroke="#2b2b2b" stroke-width="2.5" fill="none"/><circle cx="70" cy="44" r="9" fill="#81d4ca"/><text x="70" y="48" font-size="11" text-anchor="middle" fill="#fff" font-weight="700">1</text><circle cx="130" cy="44" r="9" fill="#81d4ca"/><text x="130" y="48" font-size="11" text-anchor="middle" fill="#fff" font-weight="700">1</text></svg>',
      caption: '【見本】見本神社の狛犬｜拝殿前で構える江戸流れ\n〇〇県〇〇市\n\n（ここに明日香さんの感想が入ります）',
      status: 'waiting'
    }]
  };
  function loadMachi() {
    var k = S.kansou;
    loadPosts();
    if (DEMO) { k.data = DEMO_MACHI; k.fetchedAt = new Date().toISOString(); renderKansou(); return; }
    if (!S.settings.url || !S.settings.pass) { renderKansou(); return; }
    if (!online()) { k.error = '電波がないため、前に読み込んだ一覧を表示しています。'; renderKansou(); return; }
    k.loading = true; k.error = ''; renderKansou();
    var u = S.settings.url + (S.settings.url.indexOf('?') >= 0 ? '&' : '?') + 'type=pending&passphrase=' + encodeURIComponent(S.settings.pass);
    fetch(u, { redirect: 'follow' }).then(function (r) { return r.text(); }).then(function (t) {
      var j; try { j = JSON.parse(t); } catch (e) { throw new Error('bad_response'); }
      if (!j.ok) throw new Error(j.error || 'unknown');
      k.data = j.data || { items: [] }; k.answered = {}; (j.answered || []).forEach(function (id) { k.answered[id] = true; });
      k.fetchedAt = new Date().toISOString();
      kvSet('machi', { data: k.data, answered: k.answered, fetchedAt: k.fetchedAt });
    }).catch(function (e) {
      k.error = e && e.message ? (e.message === 'Failed to fetch' ? 'つながりませんでした。前に読み込んだ一覧を表示しています。' : errText(e.message)) : 'つながりませんでした。';
    }).then(function () { k.loading = false; renderKansou(); });
  }
  /* ---------- Instagram への投稿（iPhone） ---------- */
  var DEMO_POSTS = {
    schema: 'komainu-toukou-machi/1', updatedAt: new Date().toISOString(),
    items: [{
      itemId: 'sample-1', sample: true, shrineName: '見本神社', pairNo: 1,
      images: [{ fileId: 'demo-1', role: 'cover', name: '01_cover.jpg' }, { fileId: 'demo-2', role: 'map', name: '02_map.jpg' }, { fileId: 'demo-3', role: 'data', name: '03_data.jpg' }],
      caption: '【見本】見本神社の狛犬｜拝殿前で構える江戸流れ\n〇〇県〇〇市\n\n（ここに明日香さんの感想が入ります）\n\n#狛犬 #見本神社',
      status: 'ready'
    }]
  };
  function viaLabel(v) { return v === 'pc' ? 'パソコン' : v === 'iphone' ? 'iPhone' : (v || ''); }
  function apiGet(params) {
    var u = S.settings.url + (S.settings.url.indexOf('?') >= 0 ? '&' : '?') + Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&') +
      '&passphrase=' + encodeURIComponent(S.settings.pass);
    return fetch(u, { redirect: 'follow' }).then(function (r) { return r.text(); }).then(function (t) {
      var j; try { j = JSON.parse(t); } catch (e) { throw new Error('bad_response'); }
      if (!j.ok) throw new Error(j.error || 'unknown');
      return j;
    });
  }
  function loadPosts() {
    var P = S.posts;
    if (DEMO) { P.data = DEMO_POSTS; P.fetchedAt = new Date().toISOString(); return Promise.resolve(); }
    if (!S.settings.url || !S.settings.pass || !online()) return Promise.resolve();
    P.loading = true;
    return apiGet({ type: 'posts' }).then(function (j) {
      P.data = j.data || { items: [] }; P.posted = {};
      (j.posted || []).forEach(function (x) { P.posted[x.itemId] = { via: x.via, at: x.postedAt }; });
      P.fetchedAt = new Date().toISOString(); P.error = '';
      kvSet('posts', { data: P.data, posted: P.posted, fetchedAt: P.fetchedAt });
    }).catch(function (e) {
      P.error = e && e.message === 'unknown_type' ? '受け取り口が古い版です。Code.gs を第4版に入れ替えてください。' : '';
    }).then(function () { P.loading = false; if (S.tab === 'kansou') renderKansou(); });
  }
  function postItem(id) { var d = S.posts.data; return d && (d.items || []).find(function (x) { return x.itemId === id; }); }
  function postedInfo(id) { return S.posts.posted[id] || S.postedLocal[id] || null; }
  function readyPosts() {
    var d = S.posts.data; if (!d) return [];
    return (d.items || []).filter(function (x) { return (x.status || 'ready') === 'ready' && x.images && x.images.length; });
  }
  function b64ToBlob(b64, mime) {
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: mime || 'image/jpeg' });
  }
  // 見本：画像の代わりに簡単な札を描く
  function demoImage(im, i) {
    return new Promise(function (res) {
      var c = document.createElement('canvas'); c.width = 1080; c.height = 1350;
      var g = c.getContext('2d');
      g.fillStyle = i === 0 ? '#66746d' : '#f7f8f5'; g.fillRect(0, 0, 1080, 1350);
      g.fillStyle = i === 0 ? '#f7f8f5' : '#22302b'; g.font = 'bold 72px serif'; g.textAlign = 'center';
      g.fillText('見本 ' + (i + 1) + '/3', 540, 640);
      g.font = '44px sans-serif'; g.fillText(im.role === 'cover' ? '作品写真' : im.role === 'map' ? '見取り図カード' : 'データカード', 540, 740);
      c.toBlob(function (b) { res(b); }, 'image/jpeg', 0.8);
    });
  }
  function prepPost(id) {
    var it = postItem(id); if (!it) return;
    var st = S.pstate[id] = { phase: 'loading', files: [], got: 0, total: it.images.length, error: '' };
    renderKansou();
    // 直前に投稿済みかを確かめる（PCで先に投稿していれば出さない）
    var check = DEMO ? Promise.resolve() : loadPosts();
    check.then(function () {
      var pi = postedInfo(id);
      if (pi) { st.phase = 'idle'; renderKansou(); toast(viaLabel(pi.via) + 'で投稿済みです'); return; }
      return it.images.reduce(function (chain, im, i) {
        return chain.then(function () {
          var get = DEMO ? demoImage(im, i) : apiGet({ type: 'postimage', id: im.fileId }).then(function (j) { return b64ToBlob(j.data, j.mime); });
          return get.then(function (blob) {
            var name = im.name || ((i + 1 < 10 ? '0' : '') + (i + 1) + '.jpg');
            var f;
            try { f = new File([blob], name, { type: blob.type || 'image/jpeg' }); } catch (e) { f = blob; f.name = name; }
            st.files.push(f); st.got++; renderKansou();
          });
        });
      }, Promise.resolve()).then(function () { st.phase = 'ready'; renderKansou(); });
    }).catch(function (e) {
      st.phase = 'idle'; st.error = '画像を取り出せませんでした（' + ((e && e.message) || 'エラー') + '）。電波を確かめて、もう一度押してください。';
      renderKansou();
    });
  }
  // コピーと共有は、押した操作の中ですぐに呼ぶ（iPhone の Safari は、時間がたつと共有を止める）
  function sharePost(id) {
    var it = postItem(id), st = S.pstate[id]; if (!it || !st || !st.files.length) return;
    var cap = it.caption || '';
    st.copied = false; st.error = '';
    if (DEMO) { st.copied = true; st.phase = 'shared'; renderKansou(); toast('見本なので共有はしません。実機ではここで Instagram を選びます'); return; }
    var copyP = (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(cap).then(function () { st.copied = true; }, function () { st.copied = false; }) : Promise.resolve();
    var data = { files: st.files };
    if (!navigator.share || (navigator.canShare && !navigator.canShare(data))) {
      st.error = 'この端末では画像を Instagram に直接渡せません。パソコンからの投稿を待つか、iPhone の Safari（iOS 15 以降）で開き直してください。';
      copyP.then(function () { renderKansou(); });
      return;
    }
    var shareP = navigator.share(data);
    Promise.all([copyP, shareP.then(function () { return 'ok'; }, function (e) { return e && e.name === 'AbortError' ? 'abort' : 'error'; })]).then(function (r) {
      if (r[1] === 'ok') st.phase = 'shared';
      else if (r[1] === 'error') st.error = '共有を開けませんでした。もう一度押してください。';
      renderKansou();
    });
  }
  function donePost(id) {
    var now = new Date().toISOString();
    S.postedLocal[id] = { via: 'iphone', at: now }; kvSet('postedLocal', S.postedLocal);
    var st = S.pstate[id]; if (st) { st.phase = 'idle'; st.files = []; }
    if (DEMO) { toast('見本なので記録は送りません'); renderKansou(); return; }
    var rec = { id: uid('t'), itemId: id, via: 'iphone', postedAt: now, appVersion: VERSION };
    dbPut('outbox', { id: rec.id, kind: 'posted', itemId: id, createdAt: now, sent: false, payload: { type: 'posted', posted: rec } }).then(function () {
      toast('「投稿しました」を記録します'); renderKansou(); refreshCounts(); pump();
    });
  }
  function postBlockHTML(it, inCard) {
    var id = it.itemId, pi = postedInfo(id), st = S.pstate[id] || { phase: 'idle' };
    if (pi) return '<p class="kdone">Instagram に投稿済み（' + viaLabel(pi.via) + '・' + hm(pi.at) + '）</p>';
    var n = (it.images || []).length;
    var head = inCard ? '' : '<div class="kname"><h3 class="h2">' + esc(it.shrineName || '') + (it.sample ? '<span class="sample-tag">見本</span>' : '') + '</h3><p class="meta">' + (it.pairNo ? '対' + esc(it.pairNo) + '・' : '') + '画像 ' + n + '枚</p></div>' +
      (it.caption ? '<details class="cap"><summary>キャプションを見る</summary><p>' + esc(it.caption) + '</p></details>' : '');
    var err = st.error ? '<p class="msg">' + esc(st.error) + '</p>' : '';
    var body;
    if (st.phase === 'loading') body = '<p class="meta"><span class="spinner"></span>画像を取り出しています…（' + st.got + ' / ' + st.total + '）</p>';
    else if (st.phase === 'ready') {
      body = '<ol class="steps-mini"><li>下のボタンを押すと、キャプションをコピーして共有の一覧が開きます</li><li>一覧から <b>Instagram</b> を選びます</li><li>Instagram のキャプション欄に貼り付けて投稿してください</li></ol>' +
        '<button type="button" class="btn primary wide" data-act="p-share" data-id="' + esc(id) + '">コピーして Instagram へ（画像 ' + st.files.length + '枚）</button>' +
        '<button type="button" class="link-btn" data-act="p-cancel" data-id="' + esc(id) + '">やめる</button>';
    } else if (st.phase === 'shared') {
      body = '<p class="msg ok">' + (st.copied ? 'キャプションをコピーしました。' : '') + 'Instagram で貼り付けて投稿してください。</p>' +
        (st.copied ? '' : '<div class="field"><label>キャプション（長押しで全部選んでコピー）</label><textarea readonly>' + esc(it.caption || '') + '</textarea></div>') +
        '<button type="button" class="btn primary wide" data-act="p-done" data-id="' + esc(id) + '">投稿しました</button>' +
        '<div class="row"><button type="button" class="btn ghost" data-act="p-copy" data-id="' + esc(id) + '">キャプションをコピー</button><button type="button" class="btn ghost" data-act="p-share" data-id="' + esc(id) + '">もう一度開く</button><button type="button" class="btn ghost" data-act="p-cancel" data-id="' + esc(id) + '">まだ投稿しない</button></div>';
    } else {
      body = '<button type="button" class="btn primary wide" data-act="p-prep" data-id="' + esc(id) + '">iPhoneで投稿する</button>' +
        '<p class="hint">パソコンで先に投稿されたときは、このボタンは消えます。</p>';
    }
    return '<div class="post' + (inCard ? ' in-card' : '') + '">' + head + err + body + '</div>';
  }

  function renderKansou() {
    var v = $('#view-kansou'); if (S.tab !== 'kansou') return;
    var k = S.kansou;
    if (!DEMO && (!S.settings.url || !S.settings.pass)) {
      v.innerHTML = '<div class="pad"><h2 class="h2">感想を入れる</h2><p class="msg">受け取り口のURLと合言葉を設定すると、感想待ちの像がここに並びます。</p><button type="button" class="btn primary" data-act="open-settings">設定を開く</button></div>';
      return;
    }
    var items = (k.data && k.data.items) || [];
    var inK = {}; items.forEach(function (x) { inK[x.id] = true; });
    var posts = readyPosts().filter(function (x) { return !inK[x.itemId] && !postedInfo(x.itemId); });
    var head = '<div class="row" style="justify-content:space-between"><h2 class="h2">感想待ち <span class="meta">' + items.length + '件</span></h2><button type="button" class="btn" data-act="reload-machi"' + (k.loading ? ' disabled' : '') + '>' + (k.loading ? '読み込み中…' : '読み込み直す') + '</button></div>' +
      (k.fetchedAt ? '<p class="hint">' + hm(k.fetchedAt) + ' に読み込み' + (k.data && k.data.updatedAt ? '・一覧の更新 ' + hm(k.data.updatedAt) : '') + '</p>' : '') +
      (k.error ? '<p class="msg">' + esc(k.error) + '</p>' : '') +
      (S.posts.error ? '<p class="msg">' + esc(S.posts.error) + '</p>' : '') +
      (DEMO ? '<p class="msg">見本の1件です。実際は、送った写真から作った下書きが並びます。</p>' : '');
    var postSec = posts.length ? '<section class="stack"><h2 class="h3">Instagram に投稿する <span class="meta">' + posts.length + '件</span></h2>' +
      posts.map(function (x) { return '<article class="kcard"><div class="kbody">' + postBlockHTML(x, false) + '</div></article>'; }).join('') + '</section>' : '';
    if (!items.length) {
      v.innerHTML = '<div class="pad">' + head + postSec + (k.loading ? '' : '<p class="meta">いま感想待ちの像はありません。撮影した写真の下書きができると、ここに並びます。</p>') + '</div>';
      return;
    }
    v.innerHTML = '<div class="pad">' + head + items.map(kcardHTML).join('') + postSec + '</div>';
  }
  function kcardHTML(it) {
    var st = S.kstate[it.id], answered = S.kansou.answered[it.id];
    var d = it.draft || {}, ph = it.photo || {};
    var img = ph.thumb ? '<img src="' + esc(ph.thumb) + '" alt="代表写真">' : ph.url ? '<img src="' + esc(ph.url) + '" alt="代表写真" referrerpolicy="no-referrer">' : '<span>代表写真</span>';
    var facts = [['様式', (d.regionalTypes || []).join('、')], ['ポーズ', d.pose], ['素材', d.material], ['作者', d.maker], ['年', d.year], ['メモ', d.notes]]
      .filter(function (f) { return f[1]; }).map(function (f) { return '<dt>' + f[0] + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('');
    var map = it.mapSvg ? '<figure class="kmap"><img src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(it.mapSvg) + '" alt="見取り図の下書き"><figcaption>見取り図の下書き（略図）</figcaption></figure>' : '';
    var cap = it.caption ? '<details class="cap"><summary>キャプションの下書きを見る</summary><p>' + esc(it.caption) + '</p></details>' : '';
    var done = '';
    if (st) done = '<p class="kdone">' + (st.decision === 'ok' ? '「公開してよい」' : '「直してほしいこと」') + 'を' + (st.sent || DEMO ? '送りました' : '送信待ちに入れました') + '（' + hm(st.at) + '）</p>';
    else if (answered) done = '<p class="kdone">送信済みです</p>';
    var pit = postItem(it.id), post = '';
    if ((st && st.decision === 'ok') || (answered && !st)) {
      if (pit && ((pit.status || 'ready') === 'ready' || postedInfo(it.id))) post = postBlockHTML(pit, true);
      else if (st && st.decision === 'ok') post = '<p class="hint">投稿の準備（画像とキャプション）ができると、ここに「iPhoneで投稿する」が出ます。「読み込み直す」で確かめられます。</p>';
    }
    var dr = S.kdraft[it.id] || {};
    var form = (st || answered) ? '<button type="button" class="link-btn" data-act="k-again" data-id="' + esc(it.id) + '">もう一度送る</button>' :
      '<div class="field"><div class="label-row"><label for="kt-' + esc(it.id) + '">感想（1〜3行）</label>' + micBtnHTML('kt-' + it.id) + '</div><textarea id="kt-' + esc(it.id) + '" data-k="kansou" data-id="' + esc(it.id) + '" placeholder="その場で感じたこと、いちばん印象に残ったところ">' + esc(dr.kansou || '') + '</textarea>' + micNoteHTML('kt-' + it.id) + '</div>' +
      '<button type="button" class="btn primary wide" data-act="k-ok" data-id="' + esc(it.id) + '">公開してよい</button>' +
      (dr.fixOpen ? '<div class="field"><div class="label-row"><label for="kf-' + esc(it.id) + '">直してほしいこと</label>' + micBtnHTML('kf-' + it.id) + '</div><textarea id="kf-' + esc(it.id) + '" data-k="fix" data-id="' + esc(it.id) + '" placeholder="例：場所は拝殿前ではなく随神門前です">' + esc(dr.fix || '') + '</textarea>' + micNoteHTML('kf-' + it.id) + '</div>' +
        '<button type="button" class="btn wide" data-act="k-fix" data-id="' + esc(it.id) + '">この内容で送る</button>' :
        '<button type="button" class="btn wide" data-act="k-fix-open" data-id="' + esc(it.id) + '">直してほしいことがある</button>');
    var shrine = it.shrine || {};
    return '<article class="kcard"><div class="kph">' + img + '</div><div class="kbody">' +
      '<div class="kname"><h3 class="h2">' + esc(shrine.name || '') + (it.sample ? '<span class="sample-tag">見本</span>' : '') + '</h3><p class="meta">対' + esc(it.pairNo) + (it.place ? '・' + esc(it.place) : '') + (shrine.address ? '・' + esc(shrine.address) : '') + '</p></div>' +
      (facts ? '<dl class="facts">' + facts + '</dl>' : '') + map + cap + done + post + form + '</div></article>';
  }
  function sendKansou(id, decision) {
    var items = (S.kansou.data && S.kansou.data.items) || [];
    var it = items.find(function (x) { return x.id === id; }); if (!it) return;
    var dr = S.kdraft[id] || {};
    if (decision === 'ok' && !(dr.kansou || '').trim()) { toast('感想を入れてください'); var t = document.getElementById('kt-' + id); if (t) t.focus(); return; }
    if (decision === 'fix' && !(dr.fix || '').trim()) { toast('直してほしいことを書いてください'); return; }
    var now = new Date().toISOString();
    var k = {
      id: uid('k'), itemId: id, sessionId: it.sessionId || '', folderName: it.folderName || '', shrineName: (it.shrine && it.shrine.name) || '', pairNo: it.pairNo,
      decision: decision, kansou: (dr.kansou || '').trim(), fixRequest: decision === 'fix' ? (dr.fix || '').trim() : '', submittedAt: now, appVersion: VERSION
    };
    S.kstate[id] = { decision: decision, at: now, sent: false };
    kvSet('kstate', S.kstate);
    if (DEMO) { toast('見本なので送信はしません'); renderKansou(); return; }
    dbPut('outbox', { id: k.id, kind: 'kansou', itemId: id, createdAt: now, sent: false, payload: { type: 'kansou', kansou: k } }).then(function () {
      delete S.kdraft[id]; kvSet('kdraft', S.kdraft);
      toast(online() ? '送ります' : '電波が戻ったら送ります');
      renderKansou(); refreshCounts(); pump();
    });
  }

  /* ---------- 設定 ---------- */
  function renderSettings() {
    var v = $('#view-settings');
    v.innerHTML = '<div class="pad">' +
      '<div class="row"><button type="button" class="link-btn" data-act="close-settings">もどる</button></div>' +
      '<h2 class="h2">設定</h2>' +
      '<p class="prose">受け取り口（Google Apps Script）を公開したあとに、そのURLと合言葉を一度だけ入れます。</p>' +
      '<div class="field"><label for="set-url">受け取り口のURL</label><input id="set-url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(S.settings.url) + '"></div>' +
      '<div class="field"><label for="set-pass">合言葉</label><input id="set-pass" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(S.settings.pass) + '"><p class="hint">Code.gs の AIKOTOBA の行（上から16行目あたり）に書いた合言葉と同じものを入れます。</p></div>' +
      '<div class="row"><button type="button" class="btn primary" data-act="save-settings">保存する</button><button type="button" class="btn" data-act="test-settings">つながるか確かめる</button></div>' +
      '<p class="meta" id="set-result"></p>' +
      '<div class="panel"><h3 class="h3">撮ったらすぐ送る</h3><div class="chips" role="group" aria-label="撮ったらすぐ送るか">' +
      '<button type="button" class="chip" data-act="auto-send" data-v="off" aria-pressed="' + !S.settings.autoSend + '">送らない（「送信する」で送る）</button>' +
      '<button type="button" class="chip" data-act="auto-send" data-v="on" aria-pressed="' + !!S.settings.autoSend + '">すぐ送る</button></div>' +
      '<p class="hint">「送らない」にすると、撮った写真は端末にためておき、撮影をおえたあとの画面か「送信」の画面で「送信する」を押したときにまとめて送ります。感想を書いてから送れます。</p></div>' +
      '<div class="panel"><h3 class="h3">このアプリについて</h3><p class="hint">版 ' + VERSION + '。写真はこの端末の中（アプリ専用の保存場所）に入り、送信が確かめられるまで消えません。神社の検索には OpenStreetMap のデータ（© OpenStreetMap contributors）を使います。</p></div>' +
      '</div>';
  }
  function saveSettings() {
    var u = ($('#set-url').value || '').trim(), p = ($('#set-pass').value || '').trim();
    if (u && !/^https:\/\/script\.google(usercontent)?\.com\//.test(u)) { $('#set-result').textContent = 'URLは https://script.google.com/macros/s/ で始まるものを貼ってください。'; return false; }
    S.settings = { url: u, pass: p, autoSend: !!S.settings.autoSend }; kvSet('settings', S.settings);
    $('#set-result').textContent = '保存しました。';
    S.sendError = ''; renderStatus(); pump();
    return true;
  }
  function testSettings() {
    if (!saveSettings()) return;
    var r = $('#set-result');
    if (DEMO) { r.textContent = '見本ではつなぎません。'; return; }
    if (!S.settings.url || !S.settings.pass) { r.textContent = 'URLと合言葉を入れてください。'; return; }
    r.textContent = '確かめています…';
    fetch(S.settings.url + '?type=ping&passphrase=' + encodeURIComponent(S.settings.pass), { redirect: 'follow' }).then(function (x) { return x.text(); }).then(function (t) {
      var j; try { j = JSON.parse(t); } catch (e) { r.textContent = errText('bad_response'); return; }
      r.textContent = j.ok ? 'つながりました。写真は「' + (j.inbox || '受信箱') + '」に届きます。' : errText(j.error);
    }).catch(function () { r.textContent = 'つながりませんでした。電波とURLを確かめてください。'; });
  }

  /* ---------- 操作 ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-tab]'); if (!t) return;
    if (t.dataset.tab) {
      S.tab = t.dataset.tab;
      if (S.tab === 'shoot' && S.shootView === 'settings') S.shootView = S.session ? 'guide' : S.done ? 'done' : 'home';
      if (S.tab === 'kansou' && !S.kansou.fetchedAt) loadMachi();
      render(); return;
    }
    var a = t.dataset.act;
    switch (a) {
      case 'relocate': S.here.manual = ''; locate(); break;
      case 'pick': S.here.sel = +t.dataset.i; S.here.manual = ''; renderHome(); break;
      case 'start-ok': startSession('auto'); break;
      case 'start-manual': startSession('manual'); break;
      case 'start-later': startSession('later'); break;
      case 'art-nosession': S.tab = 'shoot'; S.shootView = 'home'; render(); toast('先に神社名を確かめると、作品写真を撮れます'); break;
      case 'art-open': S.sheet = false; renderGuide(); openArt(t.dataset.id); break;
      case 'art-pair': if (S.artDraft) { S.artDraft.pair = +t.dataset.no; renderOverlay(); } break;
      case 'art-save': saveArt(); break;
      case 'art-close': closeArt(); break;
      case 'art-delete': deleteArt(); break;
      case 'ask-del-photo': case 'cancel-del-photo':
        S.confirmPhoto = a === 'ask-del-photo' ? t.dataset.id : null;
        if (S.tab === 'shoot' && S.shootView === 'guide') renderGuide(); renderOverlay();
        break;
      case 'del-photo': cancelPhoto(t.dataset.id); break;
      case 'mic': micStart(t.dataset.for); break;   // 押した操作の中で start() を呼ぶ
      case 'auto-send':
        S.settings.autoSend = t.dataset.v === 'on'; kvSet('settings', S.settings);
        renderSettings(); renderStatus(); toast(S.settings.autoSend ? '撮ったらすぐ送ります' : '「送信する」を押したときに送ります');
        if (S.settings.autoSend) pump();
        break;
      case 'open-done': loadDone(t.dataset.id).then(function () { S.tab = 'shoot'; S.shootView = 'done'; render(); $('#view-done').scrollTop = 0; }); break;
      case 'done-home': S.done = null; S.shootView = S.session ? 'guide' : 'home'; render(); break;
      case 'ask-discard': S.confirmDiscard = true; renderGuide(); break;
      case 'cancel-discard': S.confirmDiscard = false; renderGuide(); break;
      case 'discard': discardSession(); break;
      case 'p-prep': prepPost(t.dataset.id); break;
      case 'p-share': sharePost(t.dataset.id); break;
      case 'p-copy': {
        var pit = postItem(t.dataset.id), pst = S.pstate[t.dataset.id];
        if (pit && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pit.caption || '').then(function () { if (pst) pst.copied = true; toast('キャプションをコピーしました'); renderKansou(); }, function () { toast('コピーできませんでした。下の欄を長押ししてコピーしてください'); if (pst) pst.copied = false; renderKansou(); });
        break;
      }
      case 'p-done': donePost(t.dataset.id); break;
      case 'p-cancel': { var ps = S.pstate[t.dataset.id]; if (ps) { ps.phase = 'idle'; ps.files = []; ps.error = ''; } renderKansou(); break; }
      case 'resume': S.shootView = 'guide'; startWatch(); render(); break;
      case 'home': S.shootView = 'home'; S.sheet = false; render(); break;
      case 'next': goNext(); break;
      case 'prev': goPrev(); break;
      case 'skip': skipStep(); break;
      case 'new-pair': newPair(); saveSession(); renderGuide(true); break;
      case 'to-finish': {
        var np = null;  // 場所が無い対があっても止めない
        if (np) { S.session.cursor = { pair: np.no, step: 0, mode: 'step' }; saveSession(); S.shootView = 'guide'; render(); toast('対' + np.no + 'の場所を選んでください'); break; }
        S.confirmDiscard = false;
        S.session.cursor = { pair: S.session.cursor.pair, step: 0, mode: 'finish' }; saveSession(); S.shootView = 'guide'; render(); $('#view-guide').scrollTop = 0; break;
      }
      case 'finish': finishSession(); break;
      case 'steps': S.sheet = true; renderGuide(); break;
      case 'close-sheet': S.sheet = false; renderGuide(); break;
      case 'jump': S.sheet = false; S.session.cursor = { pair: +t.dataset.pair, step: +t.dataset.i, mode: 'step' }; saveSession(); renderGuide(true); break;
      case 'place': {
        var p = pairOf(S.session.cursor.pair); p.place = t.dataset.v; var fx = freshFix(); if (fx) p.location = fx;
        saveSession(); renderGuide();
        if (!fx && !DEMO) getPos(10000).then(function (pos) { p.location = pos; saveSession(); }).catch(function () {});
        break;
      }
      case 'animal': { var pa = pairOf(S.session.cursor.pair); if (pa) { pa.animal = t.dataset.v; saveSession(); renderGuide(); } break; }
      case 'pair-mode': { var pm = pairOf(S.session.cursor.pair); if (pm) applyPairKind(pm, t.dataset.v, null); break; }
      case 'single-side': { var ps2 = pairOf(S.session.cursor.pair); if (ps2) applyPairKind(ps2, 'side', t.dataset.v); break; }
      case 'pump':
        S.sendError = '';
        flushPairKansou().then(function () { pump('all'); if (S.tab === 'shoot' && S.shootView === 'done') renderDoneStatus(); });
        break;
      case 'ask-delete': S.confirmDelete = true; renderSend(); break;
      case 'ask-del-sess': S.confirmSess = t.dataset.id; render(); break;
      case 'cancel-del-sess': S.confirmSess = null; render(); break;
      case 'del-sess': deleteSession(t.dataset.id); break;
      case 'cancel-delete': S.confirmDelete = false; renderSend(); break;
      case 'delete-sent':
        dbAll('photos').then(function (all) {
          return Promise.all(all.filter(function (p) { return p.sent && !p.deleted; }).map(function (p) { p.blob = null; p.buf = null; p.deleted = true; return dbPut('photos', p); }));
        }).then(function () { S.confirmDelete = false; return loadSessionPhotos(); }).then(function () { toast('端末から消しました'); refreshCounts(); });
        break;
      case 'open-settings': S.tab = 'shoot'; S.shootView = 'settings'; render(); break;
      case 'close-settings': S.shootView = S.session ? 'guide' : S.done ? 'done' : 'home'; render(); break;
      case 'save-settings': saveSettings(); break;
      case 'test-settings': testSettings(); break;
      case 'reload-machi': loadMachi(); break;
      case 'k-ok': sendKansou(t.dataset.id, 'ok'); break;
      case 'k-fix': sendKansou(t.dataset.id, 'fix'); break;
      case 'k-fix-open': { var d = S.kdraft[t.dataset.id] || (S.kdraft[t.dataset.id] = {}); d.fixOpen = true; renderKansou(); break; }
      case 'k-again': delete S.kstate[t.dataset.id]; S.kansou.answered[t.dataset.id] = false; kvSet('kstate', S.kstate); renderKansou(); break;
      default: break;
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('input[type="file"][data-act]')) onCapture(t);
  });
  var draftTimer = null;
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'manual-name') {
      S.here.manual = t.value;
      var st = $('[data-act="start-manual"]'); if (st) st.disabled = !t.value.trim();
    } else if (t.id === 'art-title') {
      if (S.artDraft) S.artDraft.title = t.value;
    } else if (t.id === 'place-other' && S.session) {
      pairOf(S.session.cursor.pair).placeOther = t.value; saveSession();
    } else if (t.dataset && t.dataset.pk) {
      setPairKansou(t.dataset.sid, +t.dataset.pair, t.value);
    } else if (t.dataset && t.dataset.k) {
      var d = S.kdraft[t.dataset.id] || (S.kdraft[t.dataset.id] = {});
      d[t.dataset.k] = t.value;
      clearTimeout(draftTimer); draftTimer = setTimeout(function () { kvSet('kdraft', S.kdraft); }, 400);
    }
  });
  window.addEventListener('online', function () { renderStatus(); pump(); });
  window.addEventListener('offline', renderStatus);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pump();
    else { flushPairKansou(); micStop(); }
  });

  /* ---------- 起動 ---------- */
  function boot() {
    if (DEMO) $('#demo-band').hidden = false;
    if (!DEMO && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    Promise.all([kvGet('settings', null), kvGet('current', null), kvGet('kstate', {}), kvGet('kdraft', {}), kvGet('machi', null), kvGet('posts', null), kvGet('postedLocal', {})]).then(function (r) {
      if (r[5]) { S.posts.data = r[5].data; S.posts.posted = r[5].posted || {}; S.posts.fetchedAt = r[5].fetchedAt; }
      S.postedLocal = r[6] || {};
      if (r[0]) S.settings = r[0];
      S.kstate = r[2] || {}; S.kdraft = r[3] || {};
      if (r[4]) { S.kansou.data = r[4].data; S.kansou.answered = r[4].answered || {}; S.kansou.fetchedAt = r[4].fetchedAt; }
      return r[1] ? dbGet('sessions', r[1]) : null;
    }).then(function (s) {
      if (s && s.status === 'shooting') S.session = s;
      return loadSessionPhotos();
    }).then(function () {
      render(); refreshCounts(); pump();
    });
  }
  boot();
})();
