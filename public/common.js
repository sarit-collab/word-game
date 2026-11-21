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

const REASON = { dict: 'ไม่มีในพจนานุกรม และไม่มีใครโหวตให้ผ่าน', vote: 'เพื่อนโหวตไม่ผ่าน', host: 'host ตัดสินไม่ผ่าน' };
function wordChip(w) {
  const cls = w.rejected ? 'x' : w.pts === 2 ? 'u' : 's';
  const tip = w.rejected ? REASON[w.reason] || 'ไม่ผ่าน' : w.pts === 2 ? 'ไม่ซ้ำใคร' : `ซ้ำกับอีก ${w.sharedWith - 1} คน`;
  return `<span class="w ${cls}" title="${tip}">${esc(w.word)}<span class="pts">+${w.pts}</span></span>`;
}

function dictTag(d) {
  if (d === true) return '<span class="tag ok">📖 มีในพจนานุกรม</span>';
  if (d === false) return '<span class="tag warn">⚠ ไม่พบในพจนานุกรม</span>';
  return '<span class="tag">ยังตรวจพจนานุกรมไม่ได้</span>';
}

// บัตรโหวต: mode = 'player' (ปุ่มโหวต) หรือ 'host' (ปุ่มตัดสิน)
function renderBallot(list, mode) {
  if (!list.length) return '<p class="muted">ไม่มีใครส่งคำเลย</p>';
  const OV = { null: 'ตามโหวต', no: '✗ บังคับไม่ผ่าน', ok: '✓ บังคับผ่าน' };
  return list.map(b => {
    let ctl = '';
    if (mode === 'host') {
      ctl = `<button class="secondary sm" data-ov="${esc(b.word)}">${OV[b.override]}</button>`;
    } else if (b.mine) {
      ctl = '<span class="tag">คำของคุณ</span>';
    } else {
      ctl = `<div class="vbtns"><button class="vb ${b.myVote === true ? 'on-yes' : ''}" data-vote="${esc(b.word)}" data-ok="1">👍 ผ่าน</button>`
        + `<button class="vb ${b.myVote === false ? 'on-no' : ''}" data-vote="${esc(b.word)}" data-ok="0">👎 ไม่ผ่าน</button></div>`;
    }
    const tally = b.override ? 'host ตัดสิน' : b.voters ? `👍 ${b.yes} · 👎 ${b.no}` : 'ไม่มีคนโหวต';
    return `<div class="vrow ${b.pass ? 'pass' : 'fail'}">
      <div class="vmain"><b class="vword">${esc(b.word)}</b>
        <div class="tags">${dictTag(b.dict)}${b.n > 1 ? `<span class="tag">ตอบ ${b.n} คน</span>` : ''}<span class="tag">${tally}</span>
          <span class="pill ${b.pass ? 'p-ok' : 'p-no'}">${b.pass ? 'ผ่าน' : 'ไม่ผ่าน'}</span></div></div>
      ${ctl}</div>`;
  }).join('');
}

function renderResults(res, myId) {
  const ps = res.players;
  const top = [ps[1], ps[0], ps[2]];
  const podium = ps.length ? `<div class="podium">${top.map((p, i) => p ? `
    <div class="pod p${[2, 1, 3][i]}"><div>อันดับ ${p.rank}</div><div class="n">${esc(p.name)}</div><div class="s">${p.score}</div></div>` : '').join('')}</div>` : '';
  const table = `<div class="tscroll"><table class="lb"><tr><th>#</th><th>ผู้เล่น</th><th>ไม่ซ้ำ (+2)</th><th>ซ้ำ (+1)</th><th>ไม่ผ่าน</th><th>คะแนน</th></tr>
    ${ps.map(p => `<tr class="${p.id === myId ? 'me-row' : ''}"><td class="rank">${p.rank}</td><td>${esc(p.name)}</td>
      <td>${p.unique}</td><td>${p.shared}</td><td>${p.failed}</td><td class="score">${p.score}</td></tr>`).join('')}</table></div>`;
  const detail = ps.map(p => `<div class="player-detail"><h3>${esc(p.name)} — ${p.score} คะแนน</h3>
    <div class="words">${p.words.map(wordChip).join('') || '<span class="muted">ไม่มีคำ</span>'}</div></div>`).join('');
  return `${podium}${table}
    <p class="legend muted"><span class="w u">ไม่ซ้ำ +2</span> <span class="w s">ซ้ำ +1</span> <span class="w x">ไม่ผ่าน 0</span> · แตะค้างที่คำเพื่อดูเหตุผล</p>
    <h2 style="margin-top:20px">คำของแต่ละคน</h2>${detail}`;
}
