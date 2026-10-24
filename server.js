// 花间 · tiny server: serves the game + relays positions between phones. All rendering happens on the phones.
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const ZCACHE = new Map();   // file → { br, gz } so each file is compressed once
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const PEEK_KEY = process.env.PEEK_KEY || '';          // set this in Render → Environment so only you can read /stats
const PUB = path.join(__dirname, 'public');
const STATS_FILE = path.join(__dirname, 'stats.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.css': 'text/css' };

let stats = {};
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) { }
// ---- persistence: free Upstash Redis (survives Render restarts). Without the env vars → local file only.
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOK = process.env.UPSTASH_REDIS_REST_TOKEN, KEY = 'huajian_state';
let saveT = null;
const snapshot = () => JSON.stringify({ stats, clocks: Object.fromEntries(clocks), chats: Object.fromEntries(chats), lanterns: Object.fromEntries(lanterns), blankets: Object.fromEntries(blankets), bottles: Object.fromEntries(bottles), books: Object.fromEntries(books) });
const saveAll = () => { clearTimeout(saveT); saveT = setTimeout(async () => {
  const body = snapshot();
  fs.writeFile(STATS_FILE, JSON.stringify(stats), () => { });
  if (UP_URL) { try { await fetch(UP_URL + '/set/' + KEY, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOK }, body }); } catch (e) { console.log('save failed', e.message); } }
}, 2500); };
const saveStats = saveAll;
async function loadAll() {
  if (!UP_URL) return;
  try {
    const r = await fetch(UP_URL + '/get/' + KEY, { headers: { Authorization: 'Bearer ' + UP_TOK } }); const j = await r.json();
    if (!j.result) return; const d = JSON.parse(j.result);
    stats = d.stats || {};
    for (const [k, v] of Object.entries(d.clocks || {})) clocks.set(k, v);
    for (const [k, v] of Object.entries(d.chats || {})) chats.set(k, v);
    for (const [k, v] of Object.entries(d.lanterns || {})) lanterns.set(k, v);
    for (const [k, v] of Object.entries(d.blankets || {})) blankets.set(k, v);
    for (const [k, v] of Object.entries(d.bottles || {})) bottles.set(k, v);
    for (const [k, v] of Object.entries(d.books || {})) books.set(k, v);
    console.log('restored garden from Upstash');
  } catch (e) { console.log('load failed', e.message); }
}

function sendZ(req, res, key, data, type) {
  const ae = String(req.headers['accept-encoding'] || ''); let z = ZCACHE.get(key);
  if (!z || z.len !== data.length) { z = { len: data.length, br: zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }), gz: zlib.gzipSync(data, { level: 9 }) }; ZCACHE.set(key, z); }
  const h = { 'content-type': type, vary: 'Accept-Encoding', 'cache-control': 'no-cache' };
  if (/\bbr\b/.test(ae)) { h['content-encoding'] = 'br'; res.writeHead(200, h); return res.end(z.br); }
  if (/gzip/.test(ae)) { h['content-encoding'] = 'gzip'; res.writeHead(200, h); return res.end(z.gz); }
  res.writeHead(200, h); res.end(data);
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"ok":true,"mp":1}'); }
  if (u.pathname === '/photo' && req.method === 'POST') {          // album photos: too big for the websocket, kept under their own key
    let body = ''; req.on('data', d => { body += d; if (body.length > 900000) req.destroy(); });
    req.on('end', async () => {
      if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(body)) { res.writeHead(400); return res.end('bad'); }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      photos.set(id, body); await upSet('huajian_photo_' + id, body);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id }));
    }); return;
  }
  if (u.pathname.startsWith('/photo/')) {
    const id = u.pathname.slice(7).replace(/[^a-z0-9]/g, '');
    (async () => {
      let d = photos.get(id); if (!d) { d = await upGet('huajian_photo_' + id); if (d) photos.set(id, d); }
      if (!d) { res.writeHead(404); return res.end('gone'); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' }); res.end(Buffer.from(d.split(',')[1], 'base64'));
    })(); return;
  }
  if (u.pathname.startsWith('/tile/')) {   // shared world tiles: computed once on any phone, then everyone downloads them
    const key = u.pathname.slice(6); if (!/^(s-?\d{1,4}_-?\d{1,4}_\d{1,3}_)?\d_-?\d{1,7}_-?\d{1,7}$/.test(key))   /* ground tiles, and sky-island tiles (s<site>_<site>_<island>_ first) */ { res.writeHead(400); return res.end('bad'); }
    if (req.method === 'PUT') {
      const parts = []; let n = 0; req.on('data', d => { n += d.length; if (n > 3e6) req.destroy(); else parts.push(d); });
      req.on('end', () => { const buf = Buffer.concat(parts); let ok = false; try { const raw = zlib.inflateSync(buf); const mg = raw.readUInt32LE(0); ok = raw.length === 4 + 512 * 512 * 9 && (mg === 0x48554a33 || mg === 0x48554a34) || raw.length === 4 + 512 * 512 * 11 && mg === 0x48554a35; } catch (e) { }
        if (!ok) { res.writeHead(400); return res.end('bad'); } tilePut(key, buf); res.writeHead(200); res.end('ok'); }); return;
    }
    tileGet(key).then(b => { if (!b) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end(); } res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' }); res.end(b); }); return;
  }
  if (u.pathname === '/tr') {   // translation proxy: the phones only ever talk to this server (works from China too)
    const q = String(u.searchParams.get('q') || '').slice(0, 600), tl = /^(en|zh-CN|tr)$/.test(u.searchParams.get('tl')) ? u.searchParams.get('tl') : 'en';
    translate(q, tl).then(t => { res.writeHead(t ? 200 : 502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ t })); }); return;
  }
  if (u.pathname === '/stats') {
    if (PEEK_KEY && u.searchParams.get('key') !== PEEK_KEY) { res.writeHead(403); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(stats));
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  if (!fs.existsSync(PUB)) {                         // flat upload (no public/ folder): only ever serve index.html
    if (p === '/world0.bin') return fs.readFile(path.join(__dirname, 'world0.bin'), (err, data) => { if (err) { res.writeHead(404); return res.end('not found'); } return sendZ(req, res, 'world0', data, 'application/octet-stream'); });
    if (p === '/terrain.html') return fs.readFile(path.join(__dirname, 'terrain.html'), (err, data) => { if (err) { res.writeHead(404); return res.end('not found'); } return sendZ(req, res, 'terrain', data, TYPES['.html']); });
    const APP = { '/manifest.webmanifest': 'application/manifest+json', '/icon-180.png': 'image/png', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' };
    if (APP[p]) return fs.readFile(path.join(__dirname, p.slice(1)), (err, data) => { if (err) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'content-type': APP[p], 'cache-control': 'public, max-age=86400' }); res.end(data); });
    if (p !== '/index.html') { res.writeHead(404); return res.end('not found'); }
    return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => { if (err) { res.writeHead(404); return res.end('not found'); } return sendZ(req, res, 'index', data, TYPES['.html']); });
  }
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const rooms = new Map(); // room -> Set<ws>
const clocks = new Map(); // room -> { h0, t0 }  official time of day
const chats = new Map();  // room -> last 50 messages
const lanterns = new Map(); // room -> lanterns in the sky (kept up to 200)
const blankets = new Map(); // room -> picnic blanket or null
const bottles = new Map();  // room -> messages in bottles
const books = new Map();    // room -> shared memory book entries (photos live under their own keys)
const photos = new Map();   // id -> data URL (cache; Upstash is the real store)
const cleanItem = it => { if (!it || typeof it !== 'object') return undefined; const o = { k: String(it.k || '').slice(0, 10) };
  if (Number.isFinite(+it.sp)) o.sp = +it.sp; if (it.card) o.card = String(it.card).slice(0, 300);
  if (Array.isArray(it.fl)) o.fl = it.fl.slice(0, 24).map(f => ({ sp: +f.sp || 0, c: String(f.c || '').slice(0, 9) })); return o; };
const cleanEntry = (e, ws) => ({ u: String(e.u || '').slice(0, 64), k: String(e.k || '').slice(0, 30), c: String(e.c || 'moment').slice(0, 10),
  who: ws.who, name: ws.name, to: e.to ? String(e.to).slice(0, 30) : undefined, txt: String(e.txt || '').slice(0, 500), w: e.w ? String(e.w).slice(0, 500) : undefined,
  at: Math.min(Date.now(), +e.at || Date.now()), ph: e.ph ? String(e.ph).slice(0, 24) : undefined, it: cleanItem(e.it), v: Number.isFinite(+e.v) ? +e.v : undefined });
function addBook(ws, e) {
  const a = books.get(ws.room) || []; if (!e.u || a.some(x => x.u === e.u)) return null;
  a.push(e); a.sort((x, y) => x.at - y.at); while (a.length > 600) a.shift(); books.set(ws.room, a); return e;
}
const trCache = new Map();
async function translate(q, tl) {
  if (!q.trim()) return '';
  const key = tl + '|' + q; if (trCache.has(key)) return trCache.get(key);
  let t = '';
  try {   // 1) Google's public translate endpoint
    const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=' + tl + '&q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(6000) });
    const j = await r.json(); t = (j[0] || []).map(x => x[0]).join('');
  } catch (e) { }
  if (!t) try {   // 2) MyMemory as a fallback
    const sl = /[\u3400-\u9fff]/.test(q) ? 'zh-CN' : 'en'; if (sl === tl) return q;
    const r = await fetch('https://api.mymemory.translated.net/get?langpair=' + sl + '|' + tl + '&q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(6000) });
    const j = await r.json(); t = (j.responseData && j.responseData.translatedText) || '';
  } catch (e) { }
  if (t) { trCache.set(key, t); if (trCache.size > 2000) trCache.delete(trCache.keys().next().value); }
  return t;
}
async function upSet(key, val) { if (UP_URL) try { await fetch(UP_URL + '/set/' + key, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOK }, body: val }); } catch (e) { console.log('photo save failed', e.message); } }
/* world tile cache: RAM for the hot ones, Upstash (in ≤480 KB pieces) for the rest, oldest-used dropped past the budget */
const TMEM = new Map(), TMEM_MAX = 70, TBUDGET = 140e6; let tIdx = null, tIdxT = null;
async function tCleanOld() {   // tiles in the older format: free their space
  for (const [ix, px] of [['huajian_tidx', 'huajian_t_'], ['huajian_tidx3', 'huajian_t3_']]) try { const j = await upGet(ix); if (!j) continue; const o = JSON.parse(j); for (const [k, v] of Object.entries(o)) for (let q = 0; q < v.n; q++) await upDel(px + k + '_' + q); await upDel(ix); console.log('cleared old tiles', ix); } catch (e) { }
}
async function tIndex() { if (tIdx) return tIdx; tIdx = {}; tCleanOld(); try { const j = await upGet('huajian_tidx4'); if (j) tIdx = JSON.parse(j); } catch (e) { } return tIdx; }
const tIdxSave = () => { clearTimeout(tIdxT); tIdxT = setTimeout(() => upSet('huajian_tidx4', JSON.stringify(tIdx)), 5000); };
function tMem(key, buf) { TMEM.delete(key); TMEM.set(key, buf); while (TMEM.size > TMEM_MAX) TMEM.delete(TMEM.keys().next().value); }
const tik = key => 'r19' + key;   // exact-arithmetic world (every device computes the same bits): no older copies are reused   // the 2 m level changed (soil and bedrock) and 0.5 m is new: their old copies are not reused
async function tilePut(key, buf) {
  key = tik(key);
  if (TMEM.has(key)) return; tMem(key, buf); if (!UP_URL) return;
  const idx = await tIndex(); if (idx[key]) return;
  const b64 = buf.toString('base64'), n = Math.ceil(b64.length / 480000);
  for (let q = 0; q < n; q++) await upSet('huajian_t4_' + key + '_' + q, b64.slice(q * 480000, (q + 1) * 480000));
  idx[key] = { n, s: b64.length, t: Date.now() };
  let tot = 0; for (const v of Object.values(idx)) tot += v.s;
  while (tot > TBUDGET) { const [ok, ov] = Object.entries(idx).sort((a, b) => a[1].t - b[1].t)[0]; for (let q = 0; q < ov.n; q++) upDel('huajian_t4_' + ok + '_' + q); tot -= ov.s; delete idx[ok]; }
  tIdxSave();
}
async function tileGet(key) {
  key = tik(key);
  const m = TMEM.get(key); if (m) { tMem(key, m); return m; }
  if (!UP_URL) return null; const idx = await tIndex(), e = idx[key]; if (!e) return null;
  let b64 = ''; for (let q = 0; q < e.n; q++) { const p = await upGet('huajian_t4_' + key + '_' + q); if (!p) return null; b64 += p; }
  const buf = Buffer.from(b64, 'base64'); tMem(key, buf); if (Date.now() - e.t > 3600e3) { e.t = Date.now(); tIdxSave(); } return buf;
}
async function upDel(key) { if (UP_URL) try { await fetch(UP_URL + '/del/' + key, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOK } }); } catch (e) { } }
async function upGet(key) { if (!UP_URL) return null; try { const j = await (await fetch(UP_URL + '/get/' + key, { headers: { Authorization: 'Bearer ' + UP_TOK } })).json(); return j.result || null; } catch (e) { return null; } }
const DAY_MS = 12 * 60 * 1000;
const clockOf = room => { if (!clocks.has(room)) clocks.set(room, { h0: 18.85, t0: Date.now(), dayMs: DAY_MS }); return clocks.get(room); };
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const others = (ws, m) => { const r = rooms.get(ws.room); if (r) for (const o of r) if (o !== ws) send(o, m); };
const pickHost = room => { const r = rooms.get(room); if (!r || !r.size) return; const h = [...r][0]; for (const o of r) o.host = o === h; for (const o of r) send(o, { t: 'host', id: h.id }); };

wss.on('connection', ws => {
  ws.id = Math.random().toString(36).slice(2, 9); ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'hello') {
      ws.room = String(m.room || 'garden').slice(0, 40); ws.name = String(m.name || '?').slice(0, 30); ws.who = m.who;
      if (!rooms.has(ws.room)) rooms.set(ws.room, new Set());
      const r = rooms.get(ws.room);
      for (const o of [...r]) if (o.who && o.who === ws.who) { send(o, { t: 'kicked' }); r.delete(o); others(o, { t: 'leave', id: o.id }); o.room = null; try { o.close(); } catch (e) { } }   // same person reconnected → old one is a ghost
      r.add(ws);
      send(ws, { t: 'welcome', clock: clockOf(ws.room), chat: chats.get(ws.room) || [], lanterns: lanterns.get(ws.room) || [], blanket: blankets.get(ws.room) || null, bottles: (bottles.get(ws.room) || []).filter(b => !b.read), book: books.get(ws.room) || [], now: Date.now(), id: ws.id, host: r.size === 1, peers: [...r].filter(o => o !== ws).map(o => ({ id: o.id, name: o.name, who: o.who, s: o.last })) });
      if (r.size === 1) ws.host = true;
      others(ws, { t: 'join', id: ws.id, name: ws.name, who: ws.who });
      return;
    }
    if (m.t === 'ping') return send(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (!ws.room) return;
    if (m.t === 'clock') { const c = { h0: ((+m.h % 24) + 24) % 24, t0: Date.now(), dayMs: DAY_MS }; clocks.set(ws.room, c); saveAll(); const r = rooms.get(ws.room); if (r) for (const o of r) send(o, { t: 'clock', clock: c }); return; }
    if (m.t === 'lantern' && m.l) {
      const l = { x: +m.l.x || 0, y: +m.l.y || 0, z: +m.l.z || 0, who: String(m.l.who || ''), name: ws.name, at: Date.now() }; if (m.l.w) l.w = String(m.l.w).slice(0, 140);
      const a = lanterns.get(ws.room) || []; a.push(l); while (a.length > 200) a.shift(); lanterns.set(ws.room, a); saveAll();
      const r = rooms.get(ws.room); if (r) for (const o of r) send(o, { t: 'lantern', l }); return;
    }
    if (m.t === 'blanket') { const b = m.b ? { x: +m.b.x, y: +m.b.y, z: +m.b.z, yaw: +m.b.yaw, who: String(m.b.who || '') } : null; blankets.set(ws.room, b); saveAll(); const r = rooms.get(ws.room); if (r) for (const o of r) send(o, { t: 'blanket', b }); return; }
    if (m.t === 'bottle') {
      const b = { id: Date.now() % 1e9 + Math.floor(Math.random() * 1000), name: ws.name, who: ws.who, txt: String(m.txt || '').slice(0, 400), at: Date.now(), read: false };
      if (!b.txt.trim()) return;
      const a = bottles.get(ws.room) || []; a.push(b); while (a.length > 60) a.shift(); bottles.set(ws.room, a); saveAll();
      return others(ws, { t: 'ev', e: 'bottle', b });
    }
    if (m.t === 'book') {
      const list = (Array.isArray(m.es) ? m.es : [m.e]).slice(0, 120).filter(Boolean), added = [];
      for (const e of list) { const x = addBook(ws, cleanEntry(e, ws)); if (x) added.push(x); }
      if (added.length) { saveAll(); const r = rooms.get(ws.room); if (r) for (const o of r) send(o, { t: 'book', es: added }); }
      return;
    }
    if (m.t === 'bottleRead') { const a = bottles.get(ws.room) || []; const b = a.find(x => x.id === m.id); if (b && b.who !== ws.who) { b.read = true; saveAll(); } return; }
    if (m.t === 'chat') {
      const msg = { t: 'chat', id: ws.id, name: ws.name, who: ws.who, txt: String(m.txt || '').slice(0, 300), at: Date.now() };
      if (!msg.txt.trim()) return;
      const h = chats.get(ws.room) || []; h.push(msg); while (h.length > 50) h.shift(); chats.set(ws.room, h); saveAll();
      const r = rooms.get(ws.room); if (r) for (const o of r) send(o, msg); return;
    }
    if (m.t === 'state') { ws.last = m; m.id = ws.id; return others(ws, m); }
    if (m.t === 'stats') { stats[ws.name] = { d: m.d, at: new Date().toISOString() }; saveStats(); m.id = ws.id; return others(ws, m); }
    if (m.t === 'time' && !ws.host) return;                      // only the host keeps the clock
    m.id = ws.id; others(ws, m);                                    // time / warp / event
  });
  ws.on('close', () => {
    const r = rooms.get(ws.room); if (!r || !r.has(ws)) return;
    r.delete(ws); others(ws, { t: 'leave', id: ws.id });
    if (!r.size) rooms.delete(ws.room); else if (ws.host) pickHost(ws.room);
  });
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 25000);
loadAll().finally(() => server.listen(PORT, () => console.log('花间 listening on', PORT, UP_URL ? '(saving to Upstash)' : '(no Upstash: memory only)')));
