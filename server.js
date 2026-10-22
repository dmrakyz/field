// 花间 · tiny server: serves the game + relays positions between phones. All rendering happens on the phones.
const http = require('http'), fs = require('fs'), path = require('path');
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
const snapshot = () => JSON.stringify({ stats, clocks: Object.fromEntries(clocks), chats: Object.fromEntries(chats), lanterns: Object.fromEntries(lanterns), blankets: Object.fromEntries(blankets), bottles: Object.fromEntries(bottles) });
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
    console.log('restored garden from Upstash');
  } catch (e) { console.log('load failed', e.message); }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"ok":true,"mp":1}'); }
  if (u.pathname === '/stats') {
    if (PEEK_KEY && u.searchParams.get('key') !== PEEK_KEY) { res.writeHead(403); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(stats));
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  if (!fs.existsSync(PUB)) {                         // flat upload (no public/ folder): only ever serve index.html
    const APP = { '/manifest.webmanifest': 'application/manifest+json', '/icon-180.png': 'image/png', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' };
    if (APP[p]) return fs.readFile(path.join(__dirname, p.slice(1)), (err, data) => { if (err) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'content-type': APP[p], 'cache-control': 'public, max-age=86400' }); res.end(data); });
    if (p !== '/index.html') { res.writeHead(404); return res.end('not found'); }
    return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => { if (err) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'content-type': TYPES['.html'] }); res.end(data); });
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
      const r = rooms.get(ws.room); r.add(ws);
      send(ws, { t: 'welcome', clock: clockOf(ws.room), chat: chats.get(ws.room) || [], lanterns: lanterns.get(ws.room) || [], blanket: blankets.get(ws.room) || null, bottles: (bottles.get(ws.room) || []).filter(b => !b.read), now: Date.now(), id: ws.id, host: r.size === 1, peers: [...r].filter(o => o !== ws).map(o => ({ id: o.id, name: o.name, who: o.who, s: o.last })) });
      if (r.size === 1) ws.host = true;
      others(ws, { t: 'join', id: ws.id, name: ws.name, who: ws.who });
      return;
    }
    if (m.t === 'ping') return send(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (!ws.room) return;
    if (m.t === 'clock') { const c = { h0: ((+m.h % 24) + 24) % 24, t0: Date.now(), dayMs: DAY_MS }; clocks.set(ws.room, c); saveAll(); const r = rooms.get(ws.room); if (r) for (const o of r) send(o, { t: 'clock', clock: c }); return; }
    if (m.t === 'lantern' && m.l) {
      const l = { x: +m.l.x || 0, y: +m.l.y || 0, z: +m.l.z || 0, who: String(m.l.who || ''), name: ws.name, at: Date.now() };
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
    const r = rooms.get(ws.room); if (!r) return;
    r.delete(ws); others(ws, { t: 'leave', id: ws.id });
    if (!r.size) rooms.delete(ws.room); else if (ws.host) pickHost(ws.room);
  });
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 25000);
loadAll().finally(() => server.listen(PORT, () => console.log('花间 listening on', PORT, UP_URL ? '(saving to Upstash)' : '(no Upstash: memory only)')));
