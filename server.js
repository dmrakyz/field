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
let saveT = null;
const saveStats = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(STATS_FILE, JSON.stringify(stats), () => { }), 2000); };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"ok":true,"mp":1}'); }
  if (u.pathname === '/stats') {
    if (PEEK_KEY && u.searchParams.get('key') !== PEEK_KEY) { res.writeHead(403); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(stats));
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  if (!fs.existsSync(PUB)) {                         // flat upload (no public/ folder): only ever serve index.html
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
      send(ws, { t: 'welcome', clock: clockOf(ws.room), chat: chats.get(ws.room) || [], lanterns: lanterns.get(ws.room) || [], blanket: blankets.get(ws.room) || null, now: Date.now(), id: ws.id, host: r.size === 1, peers: [...r].filter(o => o !== ws).map(o => ({ id: o.id, name: o.name, who: o.who, s: o.last })) });
      if (r.size === 1) ws.host = true;
      others(ws, { t: 'join', id: ws.id, name: ws.name, who: ws.who });
      return;
    }
    if (m.t === 'ping') return send(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (!ws.room) return;
    if (m.t === 'clock') { const c = { h0: ((+m.h % 24) + 24) % 24, t0: Date.now(), dayMs: DAY_MS }; clocks.set(ws.room, c); const r = rooms.get(ws.room); if (r) for (const o of r) send(o, { t: 'clock', clock: c }); return; }
    if (m.t === 'lantern' && m.l) {
      const l = { x: +m.l.x || 0, y: +m.l.y || 0, z: +m.l.z || 0, who: String(m.l.who || ''), name: ws.name, at: Date.now() };
      const a = lanterns.get(ws.room) || []; a.push(l); while (a.length > 200) a.shift(); lanterns.set(ws.room, a);
      const r = rooms.get(ws.room); if (r) for (const o of r) send(o, { t: 'lantern', l }); return;
    }
    if (m.t === 'blanket') { const b = m.b ? { x: +m.b.x, y: +m.b.y, z: +m.b.z, yaw: +m.b.yaw, who: String(m.b.who || '') } : null; blankets.set(ws.room, b); const r = rooms.get(ws.room); if (r) for (const o of r) send(o, { t: 'blanket', b }); return; }
    if (m.t === 'chat') {
      const msg = { t: 'chat', id: ws.id, name: ws.name, who: ws.who, txt: String(m.txt || '').slice(0, 300), at: Date.now() };
      if (!msg.txt.trim()) return;
      const h = chats.get(ws.room) || []; h.push(msg); while (h.length > 50) h.shift(); chats.set(ws.room, h);
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
server.listen(PORT, () => console.log('花间 listening on', PORT));
