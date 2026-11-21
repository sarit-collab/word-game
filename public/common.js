const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, data) {
  const r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'เกิดข้อผิดพลาด');
  return j;
}

function listen(params, onState, onGone) {
  const es = new EventSource('/api/events?' + new URLSearchParams(params));
  es.onmessage = e => onState(JSON.parse(e.data));
  es.onerror = async () => {
    // ห้องหายไป (เช่น เซิร์ฟเวอร์รีสตาร์ท) → แจ้งกลับ
    const r = await fetch('/api/exists?' + new URLSearchParams({ room: params.room, pid: params.pid || '' })).catch(() => null);
    if (r && r.status === 404) { es.close(); onGone && onGone(); }
  };
  return es;
}

// เวลาเหลือ (ชดเชยนาฬิกาเครื่องต่างกัน)
function makeClock() {
  let offset = 0, endsAt = null;
  return {
    sync(s) { offset = s.now - Date.now(); endsAt = s.endsAt; },
    left() { return endsAt ? Math.max(0, Math.ceil((endsAt - (Date.now() + offset)) / 1000)) : 0; },
  };
}
const fmt = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

function wordChip(w) {
  const cls = w.rejected ? 'x' : w.pts === 2 ? 'u' : 's';
  const tip = w.rejected ? 'ไม่ผ่าน' : w.pts === 2 ? 'ไม่ซ้ำใคร' : `ซ้ำกับอีก ${w.sharedWith - 1} คน`;
  return `<span class="w ${cls}" title="${tip}">${esc(w.word)}<span class="pts">+${w.pts}</span></span>`;
}

function renderResults(res, myId) {
  const ps = res.players;
  const top = [ps[1], ps[0], ps[2]];
  const podium = ps.length ? `<div class="podium">${top.map((p, i) => p ? `
    <div class="pod p${[2, 1, 3][i]}"><div>อันดับ ${p.rank}</div><div class="n">${esc(p.name)}</div><div class="s">${p.score}</div></div>` : '').join('')}</div>` : '';
  const table = `<table class="lb"><tr><th>#</th><th>ผู้เล่น</th><th>คำไม่ซ้ำ (+2)</th><th>คำซ้ำ (+1)</th><th>คะแนน</th></tr>
    ${ps.map(p => `<tr class="${p.id === myId ? 'me-row' : ''}"><td class="rank">${p.rank}</td><td>${esc(p.name)}</td>
      <td>${p.unique}</td><td>${p.shared}</td><td class="score">${p.score}</td></tr>`).join('')}</table>`;
  const detail = ps.map(p => `<div class="player-detail"><h3>${esc(p.name)} — ${p.score} คะแนน</h3>
    <div class="words">${p.words.map(wordChip).join('') || '<span class="muted">ไม่มีคำ</span>'}</div></div>`).join('');
  return `${podium}${table}
    <p class="legend muted"><span class="w u">ไม่ซ้ำ +2</span> <span class="w s">ซ้ำ +1</span> <span class="w x">ไม่ผ่าน 0</span></p>
    <h2 style="margin-top:20px">คำของแต่ละคน</h2>${detail}`;
}
