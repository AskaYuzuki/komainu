/* 狛犬図鑑 app.js
   データは window.KOMAINU_DATA（1ファイル版）か data/*.json（通常版）から読む。
   下部タブ：さがす／地図／神社／ギャラリー（最初は神社）（狛犬の一覧は「さがす」の結果として出す）。 */
(function () {
  'use strict';

  var STYLE_OFM = 'https://tiles.openfreemap.org/styles/liberty';
  var GSI_TILES = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
  var TABS = ['search', 'map', 'shrines', 'gallery'];
  var FILTER_KEYS = [
    { key: 'animal', dict: 'animals', label: '生き物' },
    { key: 'regionalType', dict: 'regionalTypes', label: '様式・地域による型' },
    { key: 'pose', dict: 'poses', label: 'ポーズ' },
    { key: 'material', dict: 'materials', label: '素材' },
    { key: 'sculptorId', dict: 'sculptors', label: '作者' }
  ];
  var UNKNOWN = { animal: 'komainu', regionalType: 'other', pose: 'other', material: 'other', sculptorId: 'unknown' };

  var D = { site: {}, taxonomy: {}, shrines: [] };
  var ALL = [];           // 狛犬を平らにした一覧 {k, s}
  var BY_ID = {};
  var state = {
    tab: 'shrines',
    filters: { animal: [], regionalType: [], pose: [], material: [], sculptorId: [] },
    group: 'komainu',     // さがすの並べ方：komainu | shrine
    query: '',
    detail: null          // {type:'shrine'|'komainu', id, focus}
  };

  /* ---------- 小道具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function has(v) { return v != null && String(v).trim() !== ''; }
  function norm(s) {
    // 全角半角をそろえ、カタカナをひらがなに、空白と中黒を除く
    s = String(s || '').normalize('NFKC').toLowerCase();
    s = s.replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); });
    return s.replace(/[\s・・　]/g, '');
  }
  function dict(name) { return (D.taxonomy && D.taxonomy[name]) || []; }
  // 絞り込み用の辞書。「不明・その他」がなければ足す（分類が空の狛犬の行き先）
  function filterDict(f) {
    var d = dict(f.dict).slice(), u = UNKNOWN[f.key];
    if (!d.some(function (t) { return t.id === u; })) d.push({ id: u, name: f.key === 'sculptorId' ? '不明' : '不明・その他' });
    return d;
  }
  function term(name, id) {
    var d = dict(name);
    for (var i = 0; i < d.length; i++) if (d[i].id === id) return d[i];
    return null;
  }
  function termName(name, id) {
    var t = term(name, id);
    if (t) return t.name;
    return String(id || '').indexOf('name:') === 0 ? String(id).slice(5) : '';
  }
  function filterTermName(f, id) {
    var t = filterDict(f).filter(function (x) { return x.id === id; })[0];
    return t ? t.name : termName(f.dict, id) || id;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 保存できない環境 */ } }
  function yearText(y) {
    if (!y) return '';
    var w = has(y.wareki) ? y.wareki : '', s = has(y.seireki) ? String(y.seireki) : '';
    if (w && s) return w + '（' + s + '年）';
    return w || (s ? s + '年' : '');
  }

  /* ---------- 生き物（狛犬以外の神使など） ---------- */
  // animal が無ければ狛犬。呼び名は括弧書きを外した短い形（「狛犬（獅子・狛犬）」→「狛犬」）
  function animalId(k) { return has(k.animal) ? k.animal : 'komainu'; }
  function isKomainu(k) { return animalId(k) === 'komainu'; }
  function animalWord(k) {
    var id = animalId(k);
    if (id === 'komainu') return '狛犬';
    if (id === 'other') return '像';
    var t = term('animals', id);
    return t ? t.name.replace(/[（(].*$/, '') : '像';
  }
  // 神社（や一覧）にいる生き物をまとめた呼び名：全部狛犬→狛犬、全部同じ→その名、まじる→狛犬・神使
  function groupWord(ks) {
    var w = {}, list = [];
    ks.forEach(function (k) { var x = animalWord(k); if (!w[x]) { w[x] = 1; list.push(x); } });
    if (!list.length) return '狛犬';
    if (list.length === 1) return list[0] === '像' ? '神使' : list[0];
    return w['狛犬'] ? '狛犬・神使' : '神使';
  }

  /* ---------- 写真：記録（record）と作品（art） ---------- */
  function photosOf(k) { return (k.photos || []).filter(function (p) { return p && has(p.src); }); }
  function isArt(p) { return p.kind === 'art'; }
  function artOf(k) {
    var a = photosOf(k).filter(isArt);
    // 代表（cover）を先頭に
    return a.filter(function (p) { return p.cover; }).concat(a.filter(function (p) { return !p.cover; }));
  }
  function recordsOf(k) { return photosOf(k).filter(function (p) { return !isArt(p); }); }
  function thumbOf(k) { var ic = photosOf(k).filter(function (p) { return p.icon; })[0]; return ic || recordsOf(k)[0] || artOf(k)[0] || null; }      // 一覧用：見分けやすい記録写真を優先
  function heroOf(k) { return artOf(k)[0] || recordsOf(k)[0] || null; }       // 表紙用：作品写真を優先
  function shrineCover(s) {
    var ks = s.komainu || [], i, a;
    if (ks[0]) { a = photosOf(ks[0]).filter(function (p) { return p.icon; })[0]; if (a) return a; }   // 最初の狛犬にアイコン写真があればそれを神社タブにも使う
    for (i = 0; i < ks.length; i++) { a = artOf(ks[i]); if (a[0] && a[0].cover) return a[0]; }
    for (i = 0; i < ks.length; i++) { a = heroOf(ks[i]); if (a) return a; }
    return null;
  }
  function imgTag(p, alt, cls, lazy) {
    if (!p) return '<span class="noimg' + (cls ? ' ' + cls : '') + '" role="img" aria-label="写真は準備中">写真は準備中</span>';
    // focus：四角く切るときに残す位置（左右%・上下%）。指定がなければ上寄せ（狛犬の顔が切れないように）
    var fp = p.focus ? ' style="object-position:' + (+p.focus[0]) + '% ' + (+p.focus[1]) + '%"' : '';
    return '<img' + (cls ? ' class="' + cls + '"' : '') + (lazy ? ' loading="lazy"' : '') + ' src="' + esc(p.src) + '" alt="' + esc(alt) + '"' + fp + '>';
  }
  function hasPlan(s) { return !!(s && s.layout && Array.isArray(s.layout.items) && s.layout.items.length); }

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
    insta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none"/></svg>',
    map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 3.5h9l3 3V20.5H6z"/><path d="M9 10h6M9 14h6"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  /* ---------- データ ---------- */
  function loadData() {
    if (window.KOMAINU_DATA) return Promise.resolve(window.KOMAINU_DATA);
    function get(p) { return fetch(p, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(p); return r.json(); }); }
    return Promise.all([get('data/site.json').catch(function () { return {}; }), get('data/taxonomy.json'), get('data/shrines.json')])
      .then(function (a) { return { site: a[0], taxonomy: a[1], shrines: a[2] }; });
  }
  function index() {
    ALL = []; BY_ID = {};
    D.shrines.forEach(function (s) {
      (s.komainu || []).forEach(function (k) { var e = { k: k, s: s }; ALL.push(e); BY_ID[k.id] = e; });
    });
  }
  function shrineById(id) { for (var i = 0; i < D.shrines.length; i++) if (D.shrines[i].id === id) return D.shrines[i]; return null; }
  function isSampleData() { return D.shrines.some(function (s) { return s.sample; }); }

  /* ---------- 絞り込み ---------- */
  function activeCount() { var n = 0; FILTER_KEYS.forEach(function (f) { n += state.filters[f.key].length; }); return n; }
  function rawStyles(k) {
    return Array.isArray(k.regionalTypes) ? k.regionalTypes.filter(Boolean) : (k.regionalType ? [k.regionalType] : []);
  }
  // 様式は複数登録できる（regionalTypes 配列）。空なら「不明・その他」
  function styles(k) { var a = rawStyles(k); return a.length ? a : ['other']; }
  function vals(e, key) {
    var k = e.k;
    if (key === 'animal') return [animalId(k)];
    if (key === 'regionalType') return styles(k);
    if (key === 'sculptorId') return [k.sculptorId || (has(k.sculptor) ? 'name:' + k.sculptor : 'unknown')];
    return [has(k[key]) ? k[key] : 'other'];
  }
  function styleNames(k) { return rawStyles(k).map(function (id) { return termName('regionalTypes', id); }).filter(Boolean).join('・'); }
  function matches(e, skipKey) {
    return FILTER_KEYS.every(function (f) {
      if (f.key === skipKey) return true;
      var sel = state.filters[f.key];
      if (!sel.length) return true;
      return vals(e, f.key).some(function (v) { return sel.indexOf(v) >= 0; });
    });
  }
  function matchesQuery(e) {
    var nq = norm(state.query);
    if (!nq) return true;
    var k = e.k, s = e.s, sc = term('sculptors', k.sculptorId), an = term('animals', animalId(k));
    return [s.name, s.kana, s.prefecture, s.city, k.label, k.sculptor, sc && sc.name, sc && sc.kana, an && an.name, an && an.kana]
      .some(function (x) { return x && norm(x).indexOf(nq) >= 0; });
  }
  function filtered() { return ALL.filter(function (e) { return matches(e); }); }
  function searched() { return ALL.filter(function (e) { return matches(e) && matchesQuery(e); }); }
  function clearFilters() { FILTER_KEYS.forEach(function (f) { state.filters[f.key] = []; }); saveFilters(); }
  function toggleFilter(key, id) {
    var a = state.filters[key], i = a.indexOf(id);
    if (i >= 0) a.splice(i, 1); else a.push(id);
    saveFilters();
  }
  function saveFilters() { lsSet('komainu.filters', JSON.stringify(state.filters)); }
  function restore() {
    try {
      var f = JSON.parse(lsGet('komainu.filters') || 'null');
      if (f) FILTER_KEYS.forEach(function (x) { if (Array.isArray(f[x.key])) state.filters[x.key] = f[x.key]; });
    } catch (e) { /* 無視 */ }
    if (lsGet('komainu.group') === 'shrine') state.group = 'shrine';
  }

  /* ---------- 画面の切り替え ---------- */
  function setHash(h) {
    try { history.replaceState(null, '', h ? '#' + h : location.pathname + location.search); } catch (e) { /* 無視 */ }
  }
  var stack = [];
  function go(tab, detail, push) {
    state.tab = tab; state.detail = detail || null;
    if (push !== false) stack.push({ tab: tab, detail: state.detail });
    render();
    setHash(detail ? (detail.type === 'shrine' ? 's-' : 'k-') + detail.id : tab);
  }
  function back() {
    stack.pop();
    var prev = stack[stack.length - 1];
    if (prev) { state.tab = prev.tab; state.detail = prev.detail; render(); setHash(prev.detail ? (prev.detail.type === 'shrine' ? 's-' : 'k-') + prev.detail.id : prev.tab); }
    else go(state.tab, null);
  }
  function fromHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (/^s-/.test(h) && shrineById(h.slice(2))) return { tab: 'shrines', detail: { type: 'shrine', id: h.slice(2) } };
    if (/^k-/.test(h) && BY_ID[h.slice(2)]) return { tab: 'search', detail: { type: 'komainu', id: h.slice(2) } };
    if (h === 'list') return { tab: 'search', detail: null };   // 旧版のリンク
    if (TABS.indexOf(h) >= 0) return { tab: h, detail: null };
    return null;
  }

  function render() {
    document.querySelectorAll('.tabs button').forEach(function (b) {
      if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    TABS.concat('detail').forEach(function (v) { $('#view-' + v).hidden = true; });
    if (state.detail) {
      var v = $('#view-detail'); v.hidden = false;
      if (state.detail.type === 'shrine') renderShrine(v, shrineById(state.detail.id), state.detail.focus);
      else renderKomainu(v, BY_ID[state.detail.id]);
      v.scrollTop = 0;
      return;
    }
    $('#view-' + state.tab).hidden = false;
    if (state.tab === 'search') renderSearch();
    if (state.tab === 'shrines') renderShrines();
    if (state.tab === 'gallery') renderGallery();
    if (state.tab === 'map') renderMap();
  }

  /* ---------- 神社の一覧（タブ） ---------- */
  function shrineRow(s) {
    var n = (s.komainu || []).length, art = 0;
    (s.komainu || []).forEach(function (k) { art += artOf(k).length; });
    return '<li><button class="s-row" type="button" data-shrine="' + esc(s.id) + '">' +
      '<span class="s-ph">' + imgTag(shrineCover(s), '', '', true) + '</span>' +
      '<span class="s-tx"><span class="kana">' + esc(s.kana) + '</span><span class="nm">' + esc(s.name) + '</span>' +
      '<span class="meta">' + esc((s.prefecture || '') + (s.city || '')) + '</span>' +
      '<span class="s-facts"><span>' + n + '対</span>' + (art ? '<span>作品 ' + art + '枚</span>' : '') +
      '<span class="' + (hasPlan(s) ? 'ok' : 'wait') + '">' + (hasPlan(s) ? '見取り図あり' : '見取り図は準備中') + '</span></span></span>' +
      '<span class="go" aria-hidden="true">' + ICON.next + '</span></button></li>';
  }
  function renderShrines() {
    var v = $('#view-shrines'), pref = [], by = {};
    D.shrines.forEach(function (s) { var p = s.prefecture || 'その他'; if (!by[p]) { by[p] = []; pref.push(p); } by[p].push(s); });
    var html = '<div class="pad"><div class="list-head"><div class="count"><b>' + D.shrines.length + '</b>社　<b>' + ALL.length + '</b>対</div>' +
      '<span class="meta">神社を押すと見取り図が開きます</span></div>';
    pref.forEach(function (p) {
      html += '<section class="pref"><h2 class="pref-h">' + esc(p) + '</h2><ul class="s-list">' + by[p].map(shrineRow).join('') + '</ul></section>';
    });
    if (!D.shrines.length) html += '<div class="empty"><p>神社はまだ登録されていません。</p></div>';
    v.innerHTML = html + aboutBlock() + '</div>';
  }

  /* ---------- さがす（狛犬の一覧） ---------- */
  function activeChips() {
    var out = '';
    FILTER_KEYS.forEach(function (f) {
      state.filters[f.key].forEach(function (id) {
        var nm = filterTermName(f, id);
        out += '<button class="chip removable" type="button" data-rm="' + f.key + '|' + esc(id) + '" aria-label="' + esc(nm) + ' の条件を外す">' + esc(nm) + '</button>';
      });
    });
    return out ? '<div class="chips-active">' + out + '</div>' : '';
  }
  function card(e, hideShrine) {
    var k = e.k;
    var sub = [isKomainu(k) ? '' : animalWord(k), styleNames(k), termName('poses', k.pose)].filter(Boolean).join('、');
    return '<div class="card"><button class="card-main" type="button" data-k="' + esc(k.id) + '">' +
      '<span class="ph">' + imgTag(thumbOf(k), e.s.name + ' ' + k.label + 'の' + animalWord(k), '', true) + '<span class="no">' + esc(k.no) + '</span>' +
      (artOf(k).length ? '<span class="art-mark">作品</span>' : '') + '</span>' +
      '<span class="t">' + esc(k.label) + '</span>' + (sub ? '<span class="s">' + esc(sub) + '</span>' : '') + '</button>' +
      (hideShrine ? '' : '<button class="card-shrine" type="button" data-shrine="' + esc(e.s.id) + '">' + esc(e.s.name) + '</button>') + '</div>';
  }
  function renderSearch() {
    var v = $('#view-search');
    if (!$('#q', v)) {
      v.innerHTML = '<div class="pad"><label class="field" for="q"><span class="sr">神社・場所・作者でさがす</span>' + ICON.search +
        '<input id="q" type="search" autocomplete="off" enterkeyhint="search" placeholder="神社名・県名・作者（例：つくば、スワ）"></label>' +
        '<div id="s-body"></div>' + aboutBlock() + '</div>';
      var inp = $('#q', v);
      inp.value = state.query;
      inp.addEventListener('input', function () { state.query = inp.value; drawSearch(); });
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') inp.blur(); });
    }
    drawSearch();
  }
  function drawSearch() {
    var list = searched(), n = activeCount(), narrowed = n || has(state.query.trim());
    var html = '<div class="list-head"><div class="count"><b>' + list.length + '</b>対' + (narrowed ? '<span class="meta">（全' + ALL.length + '対のうち）</span>' : '') + '</div>' +
      '<button class="btn' + (n ? ' primary' : '') + '" type="button" id="open-filter">' + ICON.filter + '分類で絞る' + (n ? '（' + n + '）' : '') + '</button></div>' +
      '<div class="seg" role="group" aria-label="並べ方"><button type="button" data-group="komainu" aria-pressed="' + (state.group === 'komainu') + '">' + (ALL.every(function (e) { return isKomainu(e.k); }) ? '狛犬ごと' : '1対ずつ') + '</button>' +
      '<button type="button" data-group="shrine" aria-pressed="' + (state.group === 'shrine') + '">神社ごと</button></div>' + activeChips();
    if (!list.length) {
      html += '<div class="empty"><p>' + (has(state.query.trim()) ? '「' + esc(state.query.trim()) + '」' : 'この組み合わせ') + 'に合う' + groupWord(ALL.map(function (e) { return e.k; })) + 'はまだいません。条件をひとつ外すと見つかるかもしれません。</p><button class="btn" type="button" data-clear>条件をすべて外す</button></div>';
    } else if (state.group === 'shrine') {
      var order = [], by = {};
      list.forEach(function (e) { if (!by[e.s.id]) { by[e.s.id] = []; order.push(e.s); } by[e.s.id].push(e); });
      html += order.map(function (s) {
        return '<section class="group"><button class="group-h" type="button" data-shrine="' + esc(s.id) + '"><span><span class="nm">' + esc(s.name) + '</span><span class="meta">' + esc(s.prefecture || '') + '　' + by[s.id].length + '対</span></span><span class="go">見取り図' + ICON.next + '</span></button>' +
          '<div class="grid">' + by[s.id].map(function (e) { return card(e, true); }).join('') + '</div></section>';
      }).join('');
    } else {
      html += '<div class="grid">' + list.map(function (e) { return card(e); }).join('') + '</div>';
    }
    $('#s-body').innerHTML = html;
  }
  function aboutBlock() {
    var ig = D.site.instagram || {};
    return '<div class="about"><span>' + esc(D.site.about || '') + '</span>' +
      (has(ig.url) ? '<a href="' + esc(ig.url) + '" target="_blank" rel="noopener">Instagramのアカウントを開く</a>' : '<span>Instagramのアカウントは準備中です。</span>') + '</div>';
  }

  /* ---------- 絞り込みシート ---------- */
  function openSheet() {
    var bd = document.createElement('div'); bd.className = 'sheet-backdrop';
    var sh = document.createElement('div'); sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.setAttribute('aria-label', '分類で絞る');
    document.body.appendChild(bd); document.body.appendChild(sh);
    function close() { bd.remove(); sh.remove(); render(); }
    function draw() {
      var body = FILTER_KEYS.map(function (f) {
        var items = filterDict(f);
        return '<fieldset><legend>' + f.label + '</legend><div class="chips">' + items.map(function (t) {
          var on = state.filters[f.key].indexOf(t.id) >= 0;
          var cnt = ALL.filter(function (e) { return vals(e, f.key).indexOf(t.id) >= 0 && matches(e, f.key); }).length;
          if (!cnt && !on && t.id === UNKNOWN[f.key] && !dict(f.dict).some(function (x) { return x.id === t.id; })) return '';
          return '<button class="chip' + (cnt || on ? '' : ' zero') + '" type="button" aria-pressed="' + on + '" data-f="' + f.key + '|' + esc(t.id) + '">' + esc(t.name) + ' <span class="n">' + cnt + '</span></button>';
        }).join('') + '</div></fieldset>';
      }).join('');
      var n = filtered().length;
      sh.innerHTML = '<div class="sheet-head"><h2 class="h2">分類で絞る</h2><button class="link-btn" type="button" data-close>閉じる</button></div>' +
        '<div class="sheet-body">' + body + '<p class="hint">分類が分からないものは「不明・その他」に入ります。狐など狛犬以外の生き物は、型とポーズでは「不明・その他」に入ります。</p></div>' +
        '<div class="sheet-foot"><button class="btn" type="button" data-reset>すべて外す</button><button class="btn primary" type="button" data-close>' + n + '対を見る</button></div>';
    }
    draw();
    sh.addEventListener('click', function (ev) {
      var t = ev.target.closest('button'); if (!t) return;
      if (t.dataset.f) { var p = t.dataset.f.split('|'); toggleFilter(p[0], p[1]); draw(); }
      else if ('reset' in t.dataset) { clearFilters(); draw(); }
      else if ('close' in t.dataset) close();
    });
    bd.addEventListener('click', close);
    document.addEventListener('keydown', function onKey(ev) { if (ev.key === 'Escape') { document.removeEventListener('keydown', onKey); if (sh.isConnected) close(); } });
    var first = sh.querySelector('.chip'); if (first) first.focus();
  }

  /* ---------- 見取り図（JSONからSVG） ---------- */
  // opt.focus：強調する狛犬のid。opt.mini：狛犬の頁に出す小さな図（文字なし・押せない）
  function planSVG(s, opt) {
    opt = opt || {};
    var L = s.layout || {};
    var W = L.width || 300, H = L.height || 360, out = [];
    var sorted = (L.items || []).slice().sort(function (a, b) { return (a.type === 'sando' ? 0 : 1) - (b.type === 'sando' ? 0 : 1); });
    sorted.forEach(function (it) {
      var x = +it.x || 0, y = +it.y || 0, w = +it.w || 0, h = +it.h || 0, lab = it.label || '';
      var cx = x + w / 2, txt = '';
      switch (it.type) {
        case 'sando':
          if (Array.isArray(it.points) && it.points.length > 1) {
            // 折れ線の参道（points：[[x,y],...]）
            var d = 'M' + it.points.map(function (q) { return (+q[0] || 0) + ' ' + (+q[1] || 0); }).join(' L');
            out.push('<path class="p-sando-edge" d="' + d + '"/><path class="p-sando-line" d="' + d + '"/>');
            txt = null;
          } else out.push('<rect class="p-sando" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"/>');
          break;
        case 'area':
          // 図の中の区画（離れた場所を1枚にまとめるとき）。枠と見出し
          out.push('<rect class="p-area" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="6"/>');
          if (!opt.mini && lab) out.push('<text class="p-area-t" x="' + (x + 8) + '" y="' + (y + 15) + '">' + esc(lab) + '</text>');
          txt = null;
          break;
        case 'gap':
          // 区画の間を省略した印（波線）
          var my = y + h / 2, wv = '';
          for (var gx = x + 6; gx < x + w - 6; gx += 12) wv += (wv ? ' ' : 'M' + gx + ' ' + my + ' ') + 'q3 -4 6 0 q3 4 6 0';
          out.push('<path class="p-gap" d="' + wv + '"/>');
          if (!opt.mini && lab) out.push('<text class="p-gap-t" x="' + (x + w / 2) + '" y="' + (my - 7) + '" text-anchor="middle">' + esc(lab) + '</text>');
          txt = null;
          break;
        case 'north':
          // deg：北の向き（時計回りの角度。90＝北が右）。矢印を回す
          var nd = +it.deg || 0;
          out.push('<g class="p-north"' + (nd ? ' transform="rotate(' + nd + ' ' + x + ' ' + (y + 8) + ')"' : '') + '><path d="M' + x + ' ' + (y + 2) + ' l5 12 l-5 -3 l-5 3 z"/></g>');
          txt = opt.mini ? null : [x, y + 26, 'middle'];
          break;
        case 'spot':
          out.push('<circle class="p-spot" cx="' + (x + w / 2) + '" cy="' + (y + h / 2) + '" r="' + Math.max(3, Math.min(w, h) / 2) + '"/>');
          txt = [cx, y + h + 12, 'middle'];
          break;
        case 'building':
          out.push('<rect class="p-build p-dash" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="1"/>');
          txt = [cx, y + h + 14, 'middle'];
          break;
        case 'torii':
          // 笠木・貫・二本の柱
          out.push('<g aria-label="鳥居"><path class="p-torii" d="M' + (x - 4) + ' ' + y + ' Q' + cx + ' ' + (y + 5) + ' ' + (x + w + 4) + ' ' + y + '"/>' +
            '<path class="p-torii" d="M' + (x + 6) + ' ' + (y + h * .35) + ' H' + (x + w - 6) + '"/>' +
            '<path class="p-torii" d="M' + (x + w * .22) + ' ' + (y + 2) + ' V' + (y + h) + 'M' + (x + w * .78) + ' ' + (y + 2) + ' V' + (y + h) + '"/></g>');
          txt = [x + w + 8, y + h * .7, 'start'];
          break;
        case 'haiden': case 'honden':
          out.push('<rect class="' + (it.type === 'honden' ? 'p-build-deep' : 'p-build') + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="2"/>');
          out.push('<path class="p-line" d="M' + (x + 6) + ' ' + (y + 6) + ' L' + (x + w - 6) + ' ' + (y + h - 6) + 'M' + (x + w - 6) + ' ' + (y + 6) + ' L' + (x + 6) + ' ' + (y + h - 6) + '" opacity=".25"/>');
          txt = [cx, y + h / 2 + 4, 'middle', true];
          break;
        case 'massha':
          out.push('<rect class="p-build" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="2"/>');
          out.push('<path class="p-line" d="M' + (x - 3) + ' ' + (y + 6) + ' L' + cx + ' ' + (y - 6) + ' L' + (x + w + 3) + ' ' + (y + 6) + '"/>');
          txt = [cx, y + h + 14, 'middle'];
          break;
        case 'gate':
          out.push('<rect class="p-build" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"/>');
          out.push('<rect class="p-sando" x="' + (cx - 14) + '" y="' + y + '" width="28" height="' + h + '"/>');
          txt = [x + w + 6, y + h / 2 + 4, 'start'];
          break;
        case 'chozuya':
          out.push('<rect class="p-build" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="2"/>');
          out.push('<rect class="p-water" x="' + (x + 6) + '" y="' + (y + 7) + '" width="' + Math.max(0, w - 12) + '" height="' + Math.max(0, h - 14) + '" rx="2"/>');
          txt = [cx, y + h + 14, 'middle'];
          break;
        case 'tree':
          out.push('<circle class="p-tree" cx="' + cx + '" cy="' + (y + h / 2) + '" r="' + (Math.min(w, h) / 2) + '"/>');
          txt = [cx, y + h + 13, 'middle'];
          break;
        case 'label':
          txt = [x, y, 'middle'];
          break;
        default:
          out.push('<rect class="p-build" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"/>');
          txt = [cx, y + h + 14, 'middle'];
      }
      if (txt && it.labelSide === 'left') txt = [x - 6, y + h / 2 + 4, 'end'];
      else if (txt && it.labelSide === 'right') txt = [x + w + 6, y + h / 2 + 4, 'start'];
      if (!opt.mini && lab && txt) out.push('<text x="' + txt[0] + '" y="' + txt[1] + '" text-anchor="' + txt[2] + '"' + (txt[3] ? ' style="fill:var(--ink)"' : '') + '>' + esc(lab) + '</text>');
    });
    var marks = [], focusMark = '';
    (s.komainu || []).forEach(function (k) {
      if (!k.pos) return;
      var f = opt.focus === k.id, dim = opt.focus && !f;
      var r = opt.mini ? (f ? 24 : 10) : (f ? 15 : 12);
      var g = '<g class="p-mk' + (f ? ' focus' : '') + (dim ? ' dim' : '') + '"' +
        (opt.mini ? '' : ' tabindex="0" role="link" data-k="' + esc(k.id) + '" aria-label="' + esc(k.no + '番 ' + k.label + 'の' + animalWord(k)) + '"') + '>' +
        (f ? '<circle class="ring" cx="' + k.pos.x + '" cy="' + k.pos.y + '" r="' + (r + (opt.mini ? 12 : 8)) + '"/>' : '') +
        '<circle class="d" cx="' + k.pos.x + '" cy="' + k.pos.y + '" r="' + r + '"/>' +
        (!opt.mini || f ? '<text x="' + k.pos.x + '" y="' + (k.pos.y + (opt.mini ? 9 : 4)) + '" text-anchor="middle"' + (opt.mini ? ' style="font-size:26px"' : '') + '>' + esc(k.no) + '</text>' : '') + '</g>';
      if (f) focusMark = g; else marks.push(g);
    });
    return '<svg class="plan' + (opt.mini ? ' mini' : '') + '" viewBox="-10 -10 ' + (W + 20) + ' ' + (H + 20) + '" role="img" aria-label="' + esc(s.name) + 'の見取り図">' +
      out.join('') + marks.join('') + focusMark + '</svg>';
  }

  /* ---------- 全画面の写真ビューア ---------- */
  // items: [{src, title, caption, meta, k}]
  function openViewer(items, start) {
    if (!items.length) return;
    var opener = document.activeElement;
    var el = document.createElement('div');
    el.className = 'viewer'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', '写真を大きく見る');
    el.innerHTML = '<div class="v-top"><span class="v-count" aria-live="polite"></span><button class="v-close" type="button" data-vclose aria-label="閉じる">' + ICON.close + '</button></div>' +
      '<div class="v-strip">' + items.map(function (it) {
        return '<figure class="v-slide"><div class="v-img"><img src="' + esc(it.src) + '" alt="' + esc(it.title || it.caption || '') + '" loading="lazy"></div>' +
          '<figcaption>' + (has(it.title) ? '<span class="v-title">' + esc(it.title) + '</span>' : '') +
          (has(it.meta) ? '<span class="v-meta">' + esc(it.meta) + '</span>' : '') +
          (it.k ? '<button class="btn" type="button" data-k="' + esc(it.k) + '">この' + esc(it.word || '狛犬') + 'を見る' + ICON.next + '</button>' : '') + '</figcaption></figure>';
      }).join('') + '</div>' +
      (items.length > 1 ? '<button class="v-nav prev" type="button" data-vstep="-1" aria-label="前の写真">' + ICON.back + '</button><button class="v-nav next" type="button" data-vstep="1" aria-label="次の写真">' + ICON.next + '</button>' : '');
    document.body.appendChild(el);
    var strip = $('.v-strip', el), cur = start || 0;
    function at() { return Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth)); }
    function count() { cur = at(); $('.v-count', el).textContent = (cur + 1) + ' / ' + items.length; }
    function to(i) { i = Math.max(0, Math.min(items.length - 1, i)); strip.scrollTo({ left: i * strip.clientWidth, behavior: 'smooth' }); }
    strip.scrollLeft = cur * strip.clientWidth; count();
    strip.addEventListener('scroll', count, { passive: true });
    function close() { document.removeEventListener('keydown', onKey); el.remove(); if (opener && opener.focus) opener.focus(); }
    function onKey(ev) {
      if (ev.key === 'Escape') close();
      else if (ev.key === 'ArrowRight') to(at() + 1);
      else if (ev.key === 'ArrowLeft') to(at() - 1);
    }
    document.addEventListener('keydown', onKey);
    el.addEventListener('click', function (ev) {
      var t = ev.target.closest('button'); if (!t) return;
      if ('vclose' in t.dataset) close();
      else if (t.dataset.vstep) to(at() + (+t.dataset.vstep));
      else if (t.dataset.k) close();   // 本体の操作で狛犬の頁へ進む
    });
    $('.v-close', el).focus();
  }
  function artItems(list) {
    var out = [];
    list.forEach(function (e) {
      artOf(e.k).forEach(function (p) {
        out.push({ src: p.src, title: p.title, caption: p.caption, cover: !!p.cover, meta: e.s.name + '　' + e.k.no + ' ' + e.k.label, k: e.k.id, word: animalWord(e.k), e: e });
      });
    });
    return out;
  }

  /* ---------- ギャラリー（作品写真だけ） ---------- */
  var galleryItems = [];
  function renderGallery() {
    var v = $('#view-gallery');
    galleryItems = artItems(ALL);
    var html = '<div class="pad gallery-pad"><div class="gal-head"><h2 class="h2">作品写真</h2><span class="meta">' + galleryItems.length + '枚　押すと大きく見られます</span></div>';
    if (!galleryItems.length) html += '<div class="empty"><p>作品写真はまだありません。写真の kind を "art" にすると、ここに並びます。</p></div>';
    else html += '<div class="masonry">' + galleryItems.map(function (it, i) {
      return '<button class="g-item" type="button" data-gal="' + i + '"><img loading="lazy" src="' + esc(it.src) + '" alt="' + esc(it.title || it.meta) + '">' +
        '<span class="g-cap">' + (has(it.title) ? '<span class="g-t">' + esc(it.title) + '</span>' : '') + '<span class="g-s">' + esc(has(it.title) && it.title.indexOf(it.e.s.name) === 0 ? it.e.k.label : it.e.s.name) + '</span></span></button>';   // 題が神社名なので、下の行は場所
    }).join('') + '</div>';
    v.innerHTML = html + '</div>';
  }

  /* ---------- 神社の頁 ---------- */
  function renderShrine(v, s, focus) {
    if (!s) { v.innerHTML = '<div class="pad"><p>この神社は見つかりませんでした。</p></div>'; return; }
    var ks = s.komainu || [], gw = groupWord(ks);
    var placed = ks.filter(function (k) { return k.pos; }).length;
    var plan = hasPlan(s)
      ? '<div class="plan-wrap" id="plan">' + planSVG(s, { focus: focus }) + '<p class="plan-legend">番号を押すと、その場所の' + gw + 'が開きます。' +
        (placed < ks.length ? '位置が未登録の' + gw + 'は図に出ていません。' : '') + '</p></div>'
      : '<div class="plan-empty" id="plan"><b>見取り図は準備中</b><span>境内の配置がまとまったら、ここに' + gw + 'の場所を番号で示します。</span></div>';
    // 写真一覧：その神社のすべての対の写真（作品も記録も）。対の番号順、各対の中はデータの並び順
    var all = [];
    ks.slice().sort(function (a, b) { return (+a.no || 0) - (+b.no || 0); }).forEach(function (k) {
      photosOf(k).forEach(function (p) {
        all.push({ src: p.src, title: p.title || p.caption || (isArt(p) ? '作品写真' : '記録写真'), side: p.side, meta: s.name + '　' + k.no + ' ' + k.label, k: k.id, word: animalWord(k) });
      });
    });
    var html = '<div class="pad"><button class="back" type="button" data-back>' + ICON.back + 'もどる</button>' +
      '<div class="shrine-head"><span class="kana">' + esc(s.kana) + '</span><h2 class="h2">' + esc(s.name) + '</h2>' +
      '<span class="meta">' + esc((s.prefecture || '') + (s.city || '')) + (has(s.visited) ? '　参拝 ' + esc(s.visited) : '') + '</span></div>' +
      '<h3 class="h3">境内の見取り図</h3>' + plan +
      '<section class="section"><h3 class="h3">この神社の' + gw + '　' + ks.length + '対</h3><div class="k-list">' +
      ks.map(function (k) {
        var sub = [isKomainu(k) ? '' : animalWord(k), styleNames(k), termName('poses', k.pose), termName('materials', k.material)].filter(Boolean).join('、');
        return '<button class="k-row' + (focus === k.id ? ' on' : '') + '" type="button" data-k="' + esc(k.id) + '">' + imgTag(thumbOf(k), '', '', true) +
          '<span><span class="t"><span class="num">' + esc(k.no) + '</span>' + esc(k.label) + '</span>' + (sub ? '<br><span class="s">' + esc(sub) + '</span>' : '') + '</span></button>';
      }).join('') + '</div></section>';
    if (all.length) {
      html += '<section class="section"><h3 class="h3">写真一覧　' + all.length + '枚</h3><div class="thumbs">' + all.map(function (it, i) {
        return '<button type="button" data-sart="' + i + '" aria-label="' + esc(it.title + 'を大きく見る') + '"><img loading="lazy" src="' + esc(it.src) + '" alt="">' +
          (it.side === '阿' || it.side === '吽' ? '<span class="side">' + esc(it.side) + '</span>' : '') + '</button>';
      }).join('') + '</div></section>';
    }
    var links = '';
    if (has(s.noteUrl)) links += '<a class="btn" href="' + esc(s.noteUrl) + '" target="_blank" rel="noopener">' + ICON.note + 'noteの参拝記を読む</a>';
    if (s.lat != null && s.lng != null) links += '<button class="btn" type="button" data-showmap="' + esc(s.id) + '">' + ICON.map + '地図で見る</button>';
    if (links) html += '<section class="section"><div class="cta-row">' + links + '</div></section>';
    v.innerHTML = html + '</div>';
    v._art = all;
  }

  /* ---------- 狛犬の頁 ---------- */
  function wherePlan(s, k) {
    var ok = hasPlan(s) && k.pos;
    return '<button class="where" type="button" data-shrine="' + esc(s.id) + '" data-focus="' + esc(k.id) + '">' +
      '<span class="where-plan' + (ok ? '' : ' wait') + '">' + (ok ? planSVG(s, { focus: k.id, mini: true }) : '<span>見取り図は<br>準備中</span>') + '</span>' +
      '<span class="where-tx"><span class="kana">境内のどこにいるか</span>' +
      '<span class="nm">' + esc(s.name) + '</span>' +
      '<span class="meta">' + (ok ? '<span class="num">' + esc(k.no) + '</span>' + esc(k.label) : (hasPlan(s) ? 'この' + animalWord(k) + 'の位置は未登録です' : '神社の頁で' + groupWord(s.komainu || []) + 'の一覧が見られます')) + '</span>' +
      '<span class="where-go">' + (hasPlan(s) ? '大きな見取り図へ' : '神社の頁へ') + ICON.next + '</span></span></button>';
  }
  function renderKomainu(v, e) {
    if (!e) { v.innerHTML = '<div class="pad"><p>この狛犬は見つかりませんでした。</p></div>'; return; }
    var k = e.k, s = e.s, art = artOf(k), recs = recordsOf(k);
    var word = animalWord(k), alt = s.name + ' ' + k.label + 'の' + word;
    var hero = '', recSection = '';

    if (art.length) {
      hero = '<div class="art-strip' + (art.length === 1 ? ' single' : '') + '" id="photos">' + art.map(function (p, i) {
        return '<figure><button type="button" data-hero="' + i + '" aria-label="' + esc((p.title || '作品写真') + 'を全画面で見る') + '"><img src="' + esc(p.src) + '" alt="' + esc(p.title || alt) + '"' + (i ? ' loading="lazy"' : '') + '></button>' +
          (has(p.title) || p.cover ? '<figcaption>' + (has(p.title) ? esc(p.title) : '') + (p.cover ? '<span class="cover-tag">代表</span>' : '') + '</figcaption>' : '') + '</figure>';
      }).join('') + '</div>';
      if (recs.length) {
        recSection = '<section class="section"><h3 class="h3">記録写真　' + recs.length + '枚</h3><div class="thumbs">' + recs.map(function (p, i) {
          return '<button type="button" data-rec="' + i + '" aria-label="' + esc((p.caption || '記録写真') + 'を大きく見る') + '"><img loading="lazy" src="' + esc(p.src) + '" alt="">' +
            (p.side === '阿' || p.side === '吽' ? '<span class="side">' + esc(p.side) + '</span>' : '') + '</button>';
        }).join('') + '</div></section>';
      }
    } else if (recs.length) {
      // 作品写真がなければ記録写真を上に（1枚でも成り立つ）
      hero = '<div class="photos' + (recs.length === 1 ? ' single' : '') + '" id="photos">' + recs.map(function (p, i) {
        return '<figure><button type="button" data-rec="' + i + '" class="ph" aria-label="' + esc((p.caption || '記録写真') + 'を大きく見る') + '"><img src="' + esc(p.src) + '" alt="' + esc(p.caption || alt) + '"' + (i ? ' loading="lazy"' : '') + '>' +
          (p.side === '阿' || p.side === '吽' ? '<span class="side">' + esc(p.side) + '</span>' : '') + '</button>' +
          (has(p.caption) ? '<figcaption>' + esc(p.caption) + '</figcaption>' : '') + '</figure>';
      }).join('') + '</div>';
    } else {
      hero = '<div class="photos single"><figure><span class="ph">' + imgTag(null) + '</span></figure></div>';
    }
    var nHero = art.length || recs.length;
    var dots = nHero > 1 ? '<div class="dots" aria-hidden="true">' + Array.apply(null, Array(nHero)).map(function (_, i) { return '<span' + (i ? '' : ' class="on"') + '></span>'; }).join('') + '</div>' : '';

    // 来歴：分かる項目だけ
    var facts = '';
    var fb = k.factBasis || {}, kd = function (f) { return fb[f] === 'kuden' ? ' <span class="bt kuden">口伝</span>' : ''; };
    if (has(k.sculptor)) facts += '<dt>作者</dt><dd>' + (has(k.sculptorId) ? '<button type="button" data-bysculptor="' + esc(k.sculptorId) + '">' + esc(k.sculptor) + '</button>' : esc(k.sculptor)) + kd('sculptor') + '</dd>';
    var yt = yearText(k.year); if (yt) facts += '<dt>奉納年</dt><dd>' + esc(yt) + kd('year') + '</dd>';
    if (has(k.donor)) facts += '<dt>奉納者</dt><dd>' + esc(k.donor) + kd('donor') + '</dd>';
    var srcs = (Array.isArray(k.sources) ? k.sources : []).filter(function (x) { return x && (has(x.title) || has(x.url)); });
    var srcHtml = srcs.length ? '<p class="sources">出典：' + srcs.map(function (x) {
      var t = esc(has(x.title) ? x.title : x.url);
      return has(x.url) && /^https?:\/\//.test(x.url) ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + t + '</a>' : t;
    }).join('、') + '</p>' : '';
    // 来歴（lore）：段落ごとに「出典」「口伝による」「現地で確認」を付ける（あすかさん 10/27：確証のない話も載せ、見分けられるように）
    function refLinks(rs) {
      return (rs || []).filter(function (x) { return x && (has(x.title) || has(x.url)); }).map(function (x) {
        var t = esc(has(x.title) ? x.title : x.url);
        return has(x.url) && /^https?:\/\//.test(x.url) ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + t + '</a>' : t;
      }).join('、');
    }
    var lore = Array.isArray(k.lore) ? k.lore.filter(function (x) { return x && has(x.text); }) : [];
    var loreHtml = lore.map(function (x) {
      var b = '', r = refLinks(x.refs);
      if (x.basis === 'source') b = '<span class="bt">出典</span>' + (r || '');
      else if (x.basis === 'kuden') b = '<span class="bt kuden">口伝による</span>' + (r ? '<span class="ref">もとにした話：' + r + '</span>' : '');
      else if (x.basis === 'site') b = '<span class="bt site">現地で確認</span>';
      return '<div class="lore"><p class="prose">' + esc(x.text) + '</p>' + (b ? '<p class="basis">' + b + '</p>' : '') + '</div>';
    }).join('');
    if (lore.length) loreHtml = '<p class="lore-key">「出典」は案内板・銘・公式の資料など確かなもの、「口伝による」は言い伝えやネットの情報など確かめられていない話です。</p>' + loreHtml;
    var hist = (facts ? '<dl class="facts">' + facts + '</dl>' : '') + (lore.length ? loreHtml : (has(k.history) ? '<p class="prose">' + esc(k.history) + '</p>' : '') + srcHtml);

    // 分類：登録されている項目だけ（空は出さない）
    var tagPairs = (isKomainu(k) ? [] : [['animal', 'animals', animalId(k)]]).concat(rawStyles(k).map(function (id) { return ['regionalType', 'regionalTypes', id]; }))
      .concat([['pose', 'poses', k.pose], ['material', 'materials', k.material]]);
    var tags = tagPairs.map(function (p) {
      var id = p[2]; if (!has(id)) return '';
      var nm = termName(p[1], id); if (!nm) return '';
      return '<button class="chip" type="button" data-only="' + p[0] + '|' + esc(id) + '">' + esc(nm) + '</button>';
    }).join('');

    var sib = s.komainu || [], idx = sib.indexOf(k);
    var prev = sib[idx - 1], next = sib[idx + 1];
    var ig = has(k.instagramUrl)
      ? '<a class="btn primary" href="' + esc(k.instagramUrl) + '" target="_blank" rel="noopener">' + ICON.insta + 'Instagramの投稿を見る</a>'
      : '<span class="btn is-off" aria-disabled="true">' + ICON.insta + 'Instagramの投稿は準備中</span>';
    var acct = D.site.instagram && has(D.site.instagram.url) ? '<a class="btn" href="' + esc(D.site.instagram.url) + '" target="_blank" rel="noopener">アカウントを開く</a>' : '';
    var g0 = geoOf(e);
    if (g0) acct += '<button class="btn" type="button" data-showmap="' + esc(s.id) + '" data-geo="' + esc(pointKey(g0, s)) + '">' + ICON.map + '地図で見る</button>';

    v.innerHTML = '<div class="pad"><button class="back" type="button" data-back>' + ICON.back + 'もどる</button>' +
      hero + dots +
      '<div class="k-title"><span class="meta"><button type="button" data-shrine="' + esc(s.id) + '">' + esc(s.name) + '</button>　' + esc(s.prefecture || '') + '</span>' +
      '<h2 class="h2"><span class="num">' + esc(k.no) + '</span>' + esc(k.label) + 'の' + esc(word) + '</h2></div>' +
      '<section class="section first">' + wherePlan(s, k) + '</section>' +
      (tags ? '<section class="section"><div class="tags">' + tags + '</div></section>' : '') +
      (hist ? '<section class="section"><h3 class="h3">来歴</h3>' + hist + '</section>' : '') +
      (has(k.asukaNote) ? '<section class="section"><h3 class="h3">明日香の感想</h3><div class="note-box">' + esc(k.asukaNote) + '</div></section>' : '') +
      recSection +
      '<section class="section"><div class="cta-row">' + ig + acct + '</div>' +
      (sib.length > 1 ? '<div class="pager">' +
        (prev ? '<button class="btn" type="button" data-k="' + esc(prev.id) + '">' + esc(prev.no) + ' ' + esc(prev.label) + '</button>' : '<span></span>') +
        (next ? '<button class="btn" type="button" data-k="' + esc(next.id) + '">' + esc(next.no) + ' ' + esc(next.label) + '</button>' : '<span></span>') + '</div>' : '') +
      '</section></div>';

    v._art = art.map(function (p) { return { src: p.src, title: p.title, meta: s.name + '　' + k.no + ' ' + k.label }; });
    v._rec = recs.map(function (p) { return { src: p.src, title: p.caption || '記録写真', meta: s.name + '　' + k.no + ' ' + k.label }; });

    var strip = $('#photos', v);
    if (strip && nHero > 1) strip.addEventListener('scroll', function () {
      var mid = strip.scrollLeft + strip.clientWidth / 2, best = 0, bd = 1e9;
      Array.prototype.forEach.call(strip.children, function (f, j) {
        var d = Math.abs(f.offsetLeft + f.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = j; }
      });
      v.querySelectorAll('.dots span').forEach(function (d, j) { d.classList.toggle('on', j === best); });
    }, { passive: true });
  }

  /* ---------- 地図 ---------- */
  var map = null, markers = [], mapMode = 'ofm', mapReady = false, fallbackTimer = null, focusShrine = null, focusPoint = null;
  // 位置：狛犬に geo（lat/lng）があればそれ、無ければ神社の位置。同じ位置の狛犬は1つの印にまとめる
  function geoOf(e) {
    var g = e.k.geo;
    if (g && g.lat != null && g.lng != null) return { lat: +g.lat, lng: +g.lng, name: g.name || '', approx: !!g.approx };
    if (e.s.lat != null && e.s.lng != null) return { lat: +e.s.lat, lng: +e.s.lng, name: '', approx: !!e.s.geoApprox };
    return null;
  }
  function pointKey(g, s) { return s.id + '@' + g.lat + ',' + g.lng; }
  function shrinesInFilter() {
    var by = {}, out = [];
    filtered().forEach(function (e) {
      var g = geoOf(e); if (!g) return;
      var key = pointKey(g, e.s);
      if (!by[key]) { by[key] = { key: key, s: e.s, n: 0, ks: [], lat: g.lat, lng: g.lng, name: g.name, approx: g.approx }; out.push(by[key]); }
      by[key].n++; by[key].ks.push(e.k);
    });
    return out;
  }
  function gsiStyle() {
    return {
      version: 8,
      sources: { gsi: { type: 'raster', tiles: [GSI_TILES], tileSize: 256, maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>' } },
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e6ebe4' } }, { id: 'gsi', type: 'raster', source: 'gsi' }]
    };
  }
  function setMapNote(t) { var n = $('#map-note'); if (!n) return; n.textContent = t || ''; n.hidden = !t; }
  function switchBase(mode, auto) {
    if (!map) return;
    mapMode = mode;
    clearTimeout(fallbackTimer);
    map.setStyle(mode === 'gsi' ? gsiStyle() : STYLE_OFM);
    var b = $('#base-btn'); if (b) b.textContent = mode === 'gsi' ? 'OpenFreeMapにする' : '地理院地図にする';
    setMapNote(auto ? 'OpenFreeMapが読めないため、国土地理院の標準地図に切り替えました。' : '');
    lsSet('komainu.base', mode);
    if (mode === 'gsi') watchGsi();
  }
  function watchGsi() {
    // 地理院タイルも届かない環境（Artifactなど）では、印だけ出ていることを伝える
    var loaded = false;
    function ok(ev) { if (ev && ev.sourceId === 'gsi' && ev.isSourceLoaded) loaded = true; }
    map.on('sourcedata', ok);
    setTimeout(function () {
      map.off('sourcedata', ok);
      if (!loaded && mapMode === 'gsi') setMapNote('背景地図を読み込めませんでした。神社の印だけ表示しています。');
    }, 7000);
  }
  // 印の写真：その位置の狛犬（対）の代表写真（cover）。無ければ表紙用の写真
  function pointCover(x) {
    var cv = null;
    x.ks.forEach(function (k) { if (!cv) { var a = artOf(k)[0]; if (a && a.cover) cv = a; } });
    return cv || (x.ks[0] && heroOf(x.ks[0])) || shrineCover(x.s);
  }
  function pointLabel(x) { return x.s.name + (x.name ? ' ' + x.name : '') + '、' + x.n + '対'; }
  // 写真の丸い印。members：まとめた位置の一覧（1つなら普通の印、2つ以上なら「写真＋件数」のまとまり）
  function pinEl(members) {
    var x = members[0], n = 0;
    members.forEach(function (m) { n += m.n; });
    // 印は小さなサムネイル（thumb）。無ければ代表写真
    var tk = null; members.forEach(function (m) { m.ks.forEach(function (k) { if (!tk && has(k.thumb)) tk = k; }); });
    var cv = tk ? { src: tk.thumb } : pointCover(x), el = document.createElement('button');
    el.type = 'button';
    el.className = 'pin' + (members.length > 1 ? ' cluster' : '') +
      (members.some(function (m) { return m.key === focusPoint; }) ? ' on' : '');
    el.dataset.pts = members.map(function (m) { return m.key; }).join('|');
    el.innerHTML = (cv ? '<img src="' + esc(cv.src) + '" alt="" draggable="false">' : '<span class="pin-noimg" aria-hidden="true"></span>') +
      (n > 1 ? '<span class="cnt" aria-hidden="true">' + n + '</span>' : '');
    var lab = members.length > 1
      ? members.length + 'か所・' + n + '対（' + members.map(function (m) { return m.s.name + (m.name ? ' ' + m.name : ''); }).join('、') + '）。押すと拡大します'
      : pointLabel(x);
    el.setAttribute('aria-label', lab);
    return { el: el, label: lab };
  }
  // 画面上で近い印をまとめる（拡大すると離れる）
  var PIN_GAP = 50;
  function clusterPoints(list, toPx) {
    var groups = [];
    list.forEach(function (x) {
      var p = toPx(x), hit = null;
      for (var i = 0; i < groups.length && !hit; i++) {
        var g = groups[i];
        if (Math.abs(g.px - p.x) < PIN_GAP && Math.abs(g.py - p.y) < PIN_GAP) hit = g;
      }
      if (hit) hit.members.push(x); else groups.push({ px: p.x, py: p.y, members: [x] });
    });
    return groups;
  }
  function openCluster(members) {
    if (!map) { showMapCard(members[0]); return; }
    var b = new maplibregl.LngLatBounds();
    members.forEach(function (m) { b.extend([m.lng, m.lat]); });
    if (map.getZoom() >= 16) { showMapCard(members[0]); return; }
    map.fitBounds(b, { padding: { top: 110, bottom: 170, left: 70, right: 70 }, maxZoom: 17, duration: 500 });
  }
  function drawMarkers() {
    markers.forEach(function (m) { m.remove(); }); markers = [];
    var list = shrinesInFilter();
    if (!map) { drawFallbackMap(list); return; }
    clusterPoints(list, function (x) { return map.project([x.lng, x.lat]); }).forEach(function (g) {
      var m = g.members, pe = pinEl(m), c = m[0];
      if (m.length > 1) {
        var lng = 0, lat = 0; m.forEach(function (y) { lng += y.lng; lat += y.lat; });
        c = { lng: lng / m.length, lat: lat / m.length };
      }
      pe.el.addEventListener('click', function (ev) { ev.stopPropagation(); if (m.length > 1) openCluster(m); else showMapCard(m[0]); });
      markers.push(new maplibregl.Marker({ element: pe.el }).setLngLat([c.lng, c.lat]).addTo(map));
      pe.el.setAttribute('aria-label', pe.label);   // MapLibre が上書きするので付け直す
    });
    var cnt = $('#map-count'); if (cnt) cnt.textContent = shrineCount(list) + '社を表示' + (activeCount() ? '（絞り込み中）' : '');
  }
  function shrineCount(list) { var o = {}; list.forEach(function (x) { o[x.s.id] = 1; }); return Object.keys(o).length; }
  function fitTo(list) {
    if (!map || !list.length) return;
    if (list.length === 1) { map.easeTo({ center: [list[0].lng, list[0].lat], zoom: 12 }); return; }
    var b = new maplibregl.LngLatBounds();
    list.forEach(function (x) { b.extend([x.lng, x.lat]); });
    map.fitBounds(b, { padding: { top: 90, bottom: 140, left: 50, right: 50 }, maxZoom: 9, duration: 0 });
  }
  function showMapCard(x) {
    var s = x.s, n = x.n;
    focusPoint = x.key; focusShrine = s.id;
    var box = $('#map-card'), cv = pointCover(x);
    var one = x.ks.length === 1 && (s.komainu || []).length > 1 ? x.ks[0] : null;   // 神社の中の一部の狛犬だけの印
    box.hidden = false;
    box.innerHTML = '<img src="' + esc(cv ? cv.src : '') + '" alt=""><div><span class="kana">' + esc(s.kana) + '</span><h3 class="h3">' + esc(s.name) + (x.name ? '<small class="sub"> ' + esc(x.name) + '</small>' : '') + '</h3>' +
      '<span class="meta">' + esc((s.prefecture || '') + (s.city || '')) + '　' + n + '対' + (x.approx ? '　位置はおおよそ' : '') + '</span><div class="row">' +
      (one ? '<button class="btn primary" type="button" data-k="' + esc(one.id) + '">' + esc(one.no + ' ' + one.label) + 'の' + animalWord(one) + 'を見る</button>' : '') +
      '<button class="btn' + (one ? '' : ' primary') + '" type="button" data-shrine="' + esc(s.id) + '">見取り図' + (one ? '' : 'と' + groupWord(s.komainu || []) + 'を見る') + '</button></div></div>' +
      '<button class="close" type="button" aria-label="閉じる" data-closecard>' + '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    document.querySelectorAll('.pin').forEach(function (p) { p.classList.toggle('on', (p.dataset.pts || '').split('|').indexOf(x.key) >= 0); });
  }
  function initMap() {
    var v = $('#view-map');
    v.innerHTML = '<div id="map" aria-label="神社の地図"></div>' +
      '<p class="map-note" id="map-note" hidden></p>' +
      '<div class="map-tools"><button class="btn" type="button" id="base-btn">地理院地図にする</button>' +
      '<button class="btn" type="button" data-openfilter>' + ICON.filter + '絞り込み</button><span class="btn is-off" id="map-count" aria-live="polite"></span></div>' +
      '<div class="map-card" id="map-card" hidden></div>';
    if (typeof maplibregl === 'undefined') { map = null; drawMarkers(); return; }
    var startMode = lsGet('komainu.base') === 'gsi' ? 'gsi' : 'ofm';
    mapMode = startMode;
    try {
      map = new maplibregl.Map({
        container: 'map', style: startMode === 'gsi' ? gsiStyle() : STYLE_OFM,
        center: [137.6, 36.3], zoom: 4.6, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false
      });
    } catch (err) { map = null; drawMarkers(); return; }
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    $('#base-btn').textContent = startMode === 'gsi' ? 'OpenFreeMapにする' : '地理院地図にする';
    $('#base-btn').addEventListener('click', function () { switchBase(mapMode === 'gsi' ? 'ofm' : 'gsi'); });
    map.on('error', function (ev) {
      // スタイル本体が読めないときだけ自動で地理院へ
      if (mapMode === 'ofm' && !map.isStyleLoaded() && !(ev && ev.sourceId)) switchBase('gsi', true);
    });
    if (startMode === 'ofm') fallbackTimer = setTimeout(function () { if (mapMode === 'ofm' && !map.isStyleLoaded()) switchBase('gsi', true); }, 6000);
    else watchGsi();
    map.on('load', function () { mapReady = true; });
    map.on('zoomend', drawMarkers);   // 拡大・縮小のたびに、近い印をまとめ直す
    map.on('click', function () { $('#map-card').hidden = true; focusShrine = null; focusPoint = null; document.querySelectorAll('.pin.on').forEach(function (p) { p.classList.remove('on'); }); });
    fitTo(shrinesInFilter());
    drawMarkers();
  }
  function drawFallbackMap(list) {
    // MapLibre自体が読めないときの簡易図（経緯度をそのまま平面に）。印は写真。重なる印は輪に並べて離す
    var el = $('#map'); if (!el) return;
    var minLng = 128, maxLng = 146, minLat = 30, maxLat = 46;
    if (list.length) {   // 印のある範囲に寄せる（周りに1度ずつ余白）
      minLng = Math.min.apply(null, list.map(function (x) { return x.lng; })) - 1; maxLng = Math.max.apply(null, list.map(function (x) { return x.lng; })) + 1;
      minLat = Math.min.apply(null, list.map(function (x) { return x.lat; })) - 1; maxLat = Math.max.apply(null, list.map(function (x) { return x.lat; })) + 1;
    }
    el.className = 'map-fallback';
    var W = el.clientWidth || 360, H = el.clientHeight || 600;
    var sc = Math.min(W / (maxLng - minLng), H / (maxLat - minLat)), ox = (W - sc * (maxLng - minLng)) / 2, oy = (H - sc * (maxLat - minLat)) / 2;
    function toPx(x) { return { x: ox + (x.lng - minLng) * sc, y: oy + (maxLat - x.lat) * sc }; }
    el.innerHTML = '';
    clusterPoints(list, toPx).forEach(function (g) {
      var m = g.members, r = m.length > 1 ? Math.max(32, 56 * m.length / (2 * Math.PI)) : 0;
      m.forEach(function (x, i) {
        var pe = pinEl([x]), a = -Math.PI / 2 + i * 2 * Math.PI / m.length;
        var px = Math.min(W - 28, Math.max(28, g.px + r * Math.cos(a))), py = Math.min(H - 28, Math.max(28, g.py + r * Math.sin(a)));
        pe.el.style.left = px.toFixed(1) + 'px'; pe.el.style.top = py.toFixed(1) + 'px';
        pe.el.addEventListener('click', function (ev) { ev.stopPropagation(); showMapCard(x); });
        el.appendChild(pe.el);
      });
    });
    setMapNote('地図の部品を読み込めませんでした。神社の位置だけを簡易表示しています。');
    var b = $('#base-btn'); if (b) b.hidden = true;
    var c = $('#map-count'); if (c) c.textContent = shrineCount(list) + '社を表示';
  }
  function renderMap() {
    if (!$('#map')) initMap();
    else { drawMarkers(); if (map) map.resize(); }
    if (focusShrine && map) {
      var pts = shrinesInFilter().filter(function (y) { return y.s.id === focusShrine; });
      var x = pts.filter(function (y) { return y.key === focusPoint; })[0] || pts[0];
      if (x) { map.jumpTo({ center: [x.lng, x.lat], zoom: focusPoint ? 13 : 11 }); drawMarkers(); showMapCard(x); }
      else { var s = shrineById(focusShrine); if (s && s.lat != null) map.jumpTo({ center: [s.lng, s.lat], zoom: 11 }); }
    }
  }

  /* ---------- 操作 ---------- */
  function onClick(ev) {
    if (ev.target.closest('.sheet')) return;
    var t = ev.target.closest('[data-k],[data-shrine],[data-back],[data-rm],[data-clear],[data-bysculptor],[data-only],[data-group],[data-showmap],[data-closecard],[data-openfilter],[data-gal],[data-hero],[data-rec],[data-sart],#open-filter,.tabs button');
    if (!t) return;
    var inViewer = t.closest('.viewer');
    if (inViewer && !t.dataset.k) return;   // ビューアの中の操作はビューアが受け持つ
    var d = t.dataset, v = $('#view-detail');
    if (t.matches('.tabs button')) { stack = []; go(d.tab, null); if (d.tab === 'search') setTimeout(function () { var q = $('#q'); if (q && !state.query) q.focus(); }, 30); return; }
    if (t.id === 'open-filter' || 'openfilter' in d) { openSheet(); return; }
    if (d.gal != null) { openViewer(galleryItems, +d.gal); return; }
    if (d.hero != null) { openViewer(v._art || [], +d.hero); return; }
    if (d.rec != null) { openViewer(v._rec || [], +d.rec); return; }
    if (d.sart != null) { openViewer(v._art || [], +d.sart); return; }
    if (d.k) { go(state.tab, { type: 'komainu', id: d.k }); return; }
    if (d.shrine) { go(state.tab, { type: 'shrine', id: d.shrine, focus: d.focus || null }); if (d.focus) setTimeout(function () { var p = $('#plan'); if (p) p.scrollIntoView({ block: 'start' }); }, 0); return; }
    if ('back' in d) { back(); return; }
    if (d.rm) { var p = d.rm.split('|'); toggleFilter(p[0], p[1]); render(); return; }
    if ('clear' in d) { clearFilters(); state.query = ''; var qi = $('#q'); if (qi) qi.value = ''; render(); return; }
    if (d.group) { state.group = d.group; lsSet('komainu.group', d.group); drawSearch(); return; }
    if (d.bysculptor) {
      clearFilters(); state.filters.sculptorId = [d.bysculptor]; saveFilters();
      state.query = ''; var q2 = $('#q'); if (q2) q2.value = '';
      stack = []; go('search', null); return;
    }
    if (d.only) {
      var q = d.only.split('|'); clearFilters(); state.filters[q[0]] = [q[1]]; saveFilters();
      state.query = ''; var q3 = $('#q'); if (q3) q3.value = '';
      stack = []; go('search', null); return;
    }
    if (d.showmap) { focusShrine = d.showmap; focusPoint = d.geo || null; stack = []; go('map', null); return; }
    if ('closecard' in d) { $('#map-card').hidden = true; focusShrine = null; focusPoint = null; return; }
  }
  function onKey(ev) {
    var g = ev.target.closest && ev.target.closest('.p-mk[data-k]');
    if (g && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); go(state.tab, { type: 'komainu', id: g.dataset.k }); }
  }

  function boot() {
    loadData().then(function (data) {
      D.site = data.site || {}; D.taxonomy = data.taxonomy || {}; D.shrines = data.shrines || [];
      index(); restore();
      $('#sample-band').hidden = !isSampleData();
      var ig = D.site.instagram || {};
      var igBtn = $('#ig-account');
      if (has(ig.url)) { igBtn.href = ig.url; igBtn.hidden = false; }
      var start = fromHash();
      if (start) { state.tab = start.tab; stack = [{ tab: start.tab, detail: start.detail }]; state.detail = start.detail; render(); }
      else go('shrines', null);
    }).catch(function (err) {
      $('#view-shrines').hidden = false;
      $('#view-shrines').innerHTML = '<div class="pad"><p>データを読み込めませんでした。data/ フォルダに shrines.json と taxonomy.json があるか確かめてください。</p><p class="meta">' + esc(err && err.message) + '</p></div>';
    });
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    if ('serviceWorker' in navigator && !window.KOMAINU_DATA && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        // アプリを開き直したとき・画面に戻ったときに更新を確かめる
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reg.update().catch(function () {}); });
      }).catch(function () { /* 登録できない環境 */ });
      // 新しい版に切り替わったら1回だけ読み直す
      var hadController = !!navigator.serviceWorker.controller, reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController || reloaded) { hadController = true; return; }
        reloaded = true; location.reload();
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
