// เกมแข่งพิมพ์คำ ตามหมวด + ตัวอักษร  (ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
// รัน:  node server.js   แล้วเปิด http://localhost:3000 บนเครื่อง host
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const rooms = new Map();

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) out.push(a.address);
    }
  }
  return out;
}

function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}
const id = () => crypto.randomBytes(8).toString('hex');

// ---------- กติกาการตรวจคำ ----------
const LEADING_VOWELS = /^[เแโใไ]+/; // สระหน้าในภาษาไทย เช่น "เกม" ขึ้นต้นด้วย ก
function normalize(w) {
  return String(w || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}
function startsWithLetter(word, letter) {
  const L = normalize(letter);
  if (!L) return true;
  if (word.startsWith(L)) return true;
  return word.replace(LEADING_VOWELS, '').startsWith(L);
}

function computeResults(room) {
  // นับว่าแต่ละคำมีกี่คนตอบ (ไม่นับคำที่ host ตัดทิ้ง)
  const count = new Map();
  for (const p of room.players.values()) {
    for (const w of p.words) if (!room.rejected.has(w)) count.set(w, (count.get(w) || 0) + 1);
  }
  const players = [...room.players.values()].map(p => {
    let score = 0, unique = 0, shared = 0;
    const words = p.words.map(w => {
      const rejected = room.rejected.has(w);
      const n = count.get(w) || 0;
      const pts = rejected ? 0 : n === 1 ? 2 : 1;
      score += pts;
      if (!rejected) (n === 1 ? unique++ : shared++);
      return { word: w, pts, rejected, sharedWith: rejected ? 0 : n };
    });
    return { id: p.id, name: p.name, score, unique, shared, total: p.words.length, words };
  }).sort((a, b) => b.score - a.score || b.unique - a.unique || a.name.localeCompare(b.name, 'th'));
  let rank = 0, prev = null;
  players.forEach((p, i) => { if (p.score !== prev) { rank = i + 1; prev = p.score; } p.rank = rank; });
  const allWords = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'th'))
    .map(([word, n]) => ({ word, n }));
  return { players, allWords, rejected: [...room.rejected] };
}

// ---------- สถานะห้องที่ส่งให้แต่ละฝั่ง ----------
function publicState(room, forPid, isHost) {
  const base = {
    code: room.code, category: room.category, letter: room.letter, duration: room.duration,
    phase: room.phase, endsAt: room.endsAt, now: Date.now(),
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, count: p.words.length, online: p.clients.size > 0 })),
  };
  if (room.phase === 'review' && isHost) base.results = computeResults(room);
  if (room.phase === 'done') base.results = computeResults(room);
  if (room.phase === 'review' && !isHost) base.reviewing = true;
  if (forPid && room.players.has(forPid)) base.me = { id: forPid, words: room.players.get(forPid).words };
  return base;
}

function broadcast(room) {
  for (const res of room.hostClients) send(res, publicState(room, null, true));
  for (const p of room.players.values()) for (const res of p.clients) send(res, publicState(room, p.id, false));
}
function send(res, data) { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} }

function endRound(room) {
  if (room.phase !== 'playing') return;
  clearTimeout(room.timer);
  room.phase = 'review';
  room.endsAt = null;
  broadcast(room);
}

// ---------- HTTP ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/info') return json(res, 200, { ips: lanIPs(), port: PORT });
  if (p === '/api/exists') {
    const r = rooms.get(url.searchParams.get('room'));
    const pid = url.searchParams.get('pid');
    return json(res, r && (!pid || r.players.has(pid)) ? 200 : 404, {});
  }

  if (p === '/api/events') {
    const room = rooms.get(url.searchParams.get('room'));
    if (!room) return json(res, 404, { error: 'ไม่พบห้อง' });
    const hostKey = url.searchParams.get('host');
    const pid = url.searchParams.get('pid');
    const isHost = hostKey && hostKey === room.hostKey;
    const player = pid && room.players.get(pid);
    if (!isHost && !player) return json(res, 403, { error: 'ไม่มีสิทธิ์' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no', // กันพร็อกซีของโฮสต์บัฟเฟอร์ข้อความ
    });
    room.lastActive = Date.now();
    res.write('retry: 2000\n\n');
    const set = isHost ? room.hostClients : player.clients;
    set.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); set.delete(res); broadcast(room); });
    broadcast(room);
    return;
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    const b = await body(req);
    const room = rooms.get(String(b.room || ''));
    const isHost = room && b.hostKey === room.hostKey;

    if (p === '/api/create') {
      const code = newCode();
      const r = {
        code, hostKey: id(), phase: 'lobby', endsAt: null, timer: null,
        category: String(b.category || 'ทั่วไป').slice(0, 60),
        letter: String(b.letter || '').trim().slice(0, 3),
        duration: Math.min(600, Math.max(15, Number(b.duration) || 60)),
        players: new Map(), hostClients: new Set(), rejected: new Set(), lastActive: Date.now(),
      };
      rooms.set(code, r);
      return json(res, 200, { room: code, hostKey: r.hostKey });
    }
    if (!room) return json(res, 404, { error: 'ไม่พบห้องนี้' });
    room.lastActive = Date.now();

    if (p === '/api/join') {
      const name = String(b.name || '').trim().slice(0, 20);
      if (!name) return json(res, 400, { error: 'กรุณาใส่ชื่อ' });
      // กลับเข้าห้องเดิมด้วย pid เดิมได้
      if (b.pid && room.players.has(b.pid)) return json(res, 200, { pid: b.pid });
      if ([...room.players.values()].some(x => x.name === name)) return json(res, 400, { error: 'ชื่อนี้มีคนใช้แล้ว' });
      if (room.phase !== 'lobby') return json(res, 400, { error: 'เกมเริ่มไปแล้ว รอรอบถัดไปนะ' });
      const pid = id();
      room.players.set(pid, { id: pid, name, words: [], clients: new Set() });
      broadcast(room);
      return json(res, 200, { pid });
    }

    if (p === '/api/word') {
      const pl = room.players.get(b.pid);
      if (!pl) return json(res, 403, { error: 'ไม่พบผู้เล่น' });
      if (room.phase !== 'playing') return json(res, 400, { error: 'ยังไม่อยู่ในช่วงเล่น' });
      const w = normalize(b.word);
      if (!w) return json(res, 400, { error: 'คำว่าง' });
      if (w.length > 40) return json(res, 400, { error: 'คำยาวเกินไป' });
      if (!startsWithLetter(w, room.letter)) return json(res, 400, { error: `ต้องขึ้นต้นด้วย "${room.letter}"` });
      if (pl.words.includes(w)) return json(res, 400, { error: 'คุณพิมพ์คำนี้ไปแล้ว' });
      pl.words.push(w);
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/unword') {
      const pl = room.players.get(b.pid);
      if (!pl || room.phase !== 'playing') return json(res, 400, { error: 'ลบไม่ได้' });
      pl.words = pl.words.filter(x => x !== b.word);
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    if (!isHost) return json(res, 403, { error: 'เฉพาะผู้สร้างห้อง' });

    if (p === '/api/settings' && room.phase !== 'playing') {
      if (b.category != null) room.category = String(b.category).slice(0, 60);
      if (b.letter != null) room.letter = String(b.letter).trim().slice(0, 3);
      if (b.duration != null) room.duration = Math.min(600, Math.max(15, Number(b.duration) || 60));
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/start') {
      if (room.players.size < 1) return json(res, 400, { error: 'ยังไม่มีผู้เล่น' });
      for (const pl of room.players.values()) pl.words = [];
      room.rejected.clear();
      room.phase = 'playing';
      room.endsAt = Date.now() + room.duration * 1000;
      room.timer = setTimeout(() => endRound(room), room.duration * 1000);
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/end') { endRound(room); return json(res, 200, { ok: true }); }
    if (p === '/api/reject') {
      const w = normalize(b.word);
      if (room.rejected.has(w)) room.rejected.delete(w); else room.rejected.add(w);
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/publish') { room.phase = 'done'; broadcast(room); return json(res, 200, { ok: true }); }
    if (p === '/api/lobby') { room.phase = 'lobby'; room.endsAt = null; broadcast(room); return json(res, 200, { ok: true }); }
    if (p === '/api/kick') {
      const pl = room.players.get(b.pid);
      room.players.delete(b.pid);
      if (pl) for (const c of pl.clients) { send(c, { kicked: true }); c.end(); }
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  // ไฟล์หน้าเว็บ
  let file = p === '/' ? '/host.html' : p === '/play' ? '/play.html' : p;
  const full = path.join(PUB, path.normalize(file));
  if (!full.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ล้างห้องที่ไม่มีใครใช้นานเกิน 3 ชั่วโมง (เซิร์ฟเวอร์ออนไลน์เปิดค้างไว้ได้นาน)
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, r] of rooms) {
    const connected = r.hostClients.size + [...r.players.values()].reduce((n, p) => n + p.clients.size, 0);
    if (!connected && (r.lastActive || 0) < cutoff) { clearTimeout(r.timer); rooms.delete(code); }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  เกมพร้อมแล้ว!  เปิดหน้าจอ host:  http://localhost:${PORT}`);
  for (const ip of lanIPs()) console.log(`  ผู้เล่นในวง Wi-Fi เดียวกันเข้าได้ที่:  http://${ip}:${PORT}/play`);
  console.log('');
});
