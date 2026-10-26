// 단간론파 역극 클라이언트
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const socket = io();
let state = null;
let messages = [];
let shootTargetId = null;
let editingCharId = null;

// 브라우저마다 고정된 토큰 (같은 브라우저로 재접속하면 같은 사람으로 인식)
function getToken() {
  let t = null;
  try { t = localStorage.getItem('dgr_token'); } catch {}
  if (!t) {
    t = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('dgr_token', t); } catch {}
  }
  return t;
}
const token = getToken();
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

const PHASE_LABEL = { daily: '일상 파트', investigation: '조사 파트', trial: '학급재판', execution: '처형' };
const PHASE_COLOR = { daily: 'var(--daily)', investigation: 'var(--investigation)', trial: 'var(--trial)', execution: 'var(--execution)' };

// ---------- 로비 ----------
$('#nickname').value = store.get('dgr_nick') || '';
const urlCode = new URLSearchParams(location.search).get('room');
if (urlCode) $('#joinCode').value = urlCode;

function nick() {
  const n = $('#nickname').value.trim();
  if (!n) { $('#lobbyError').textContent = '닉네임을 입력하세요.'; return null; }
  store.set('dgr_nick', n);
  return n;
}
$('#createBtn').onclick = () => {
  const nickname = nick();
  if (!nickname) return;
  socket.emit('room:create', { token, nickname, title: $('#roomTitle').value.trim() }, onEnter);
};
$('#joinBtn').onclick = () => {
  const nickname = nick();
  if (!nickname) return;
  socket.emit('room:join', { token, nickname, code: $('#joinCode').value }, onEnter);
};
$('#joinCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('#joinBtn').click());

function onEnter(res) {
  if (res?.error) { $('#lobbyError').textContent = res.error; return; }
  store.set('dgr_room', res.code);
  history.replaceState(null, '', `?room=${res.code}`);
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
}

// 새로고침/재연결 시 자동 재입장
socket.on('connect', () => {
  const code = urlCode || store.get('dgr_room');
  const nickname = store.get('dgr_nick');
  if (code && nickname && (state || urlCode)) {
    socket.emit('room:join', { token, nickname, code }, (res) => {
      if (res?.error) { store.del('dgr_room'); return; }
      onEnter(res);
    });
  }
});

$('#leaveBtn').onclick = () => {
  store.del('dgr_room');
  location.href = location.pathname;
};
$('#roomCode').parentElement.onclick = () => {
  const url = `${location.origin}${location.pathname}?room=${state.code}`;
  navigator.clipboard?.writeText(url);
  toastSystem('초대 링크를 복사했습니다: ' + url);
};

// ---------- 수신 ----------
socket.on('joined', (data) => {
  messages = data.messages || [];
  renderLog();
});
socket.on('message', (m) => {
  messages.push(m);
  appendMessage(m, true);
});
socket.on('state', (s) => {
  state = s;
  renderAll();
});
socket.on('splash', showSplash);

// ---------- 렌더링 ----------
const charById = (id) => state?.characters.find((c) => c.id === id);
const myChars = () => state.characters.filter((c) => c.ownerId === state.me?.id || state.me?.isGM);

function avatarHTML(c, size) {
  const style = `--c:${c?.color || '#666'}${size ? `;width:${size}px;height:${size}px` : ''}`;
  if (c?.image) return `<img class="avatar" style="${style}" src="${esc(c.image)}" alt="">`;
  return `<div class="avatar" style="${style}">${esc((c?.name || '?').slice(0, 1))}</div>`;
}

function renderAll() {
  if (!state) return;
  const gm = state.me?.isGM;
  document.body.classList.toggle('is-gm', !!gm);
  $$('.gm-only:not(.tab):not(option)').forEach((el) => el.classList.toggle('hidden', !gm));
  $$('option.gm-only').forEach((o) => (o.hidden = o.disabled = !gm));
  if (!gm && $('#msgType').selectedOptions[0]?.disabled) $('#msgType').value = 'say';
  if (!gm && $('.tabs .active')?.dataset.tab === 'gm') switchTab('daily');

  $('#roomTitleView').textContent = state.title;
  $('#roomCode').textContent = state.code;
  $('#dayView').textContent = `${state.day}일째`;
  const pv = $('#phaseView');
  pv.textContent = PHASE_LABEL[state.phase];
  pv.className = 'phase-badge ' + state.phase;
  $('#locationView').textContent = state.location;
  document.title = `${state.title} — ${PHASE_LABEL[state.phase]}`;

  renderCharacters();
  renderPlayers();
  renderSpeakAs();
  renderDaily();
  renderInvestigation();
  renderTrial();
  renderGM();
}

function renderCharacters() {
  const list = $('#charList');
  if (!state.characters.length) {
    list.innerHTML = '<p class="hint">아직 캐릭터가 없습니다. “+ 캐릭터”로 만들어 보세요.</p>';
    return;
  }
  list.innerHTML = state.characters
    .map((c) => {
      const mine = c.ownerId === state.me?.id;
      return `<div class="char-item ${mine ? 'mine' : ''} ${c.alive ? '' : 'dead'}" style="--c:${c.color}" data-id="${c.id}">
        ${avatarHTML(c)}
        <div><div class="cname">${esc(c.name)}${c.npc ? ' <small class="hint">NPC</small>' : ''}</div>
        <div class="ctalent">${esc(c.talent)}</div></div></div>`;
    })
    .join('');
  list.querySelectorAll('.char-item').forEach((el) => (el.onclick = () => openChar(el.dataset.id)));
}

function renderPlayers() {
  $('#playerList').innerHTML = state.players
    .map((p) => {
      const c = charById(p.characterId);
      const crown = p.isGM
        ? ' 👑'
        : state.me?.isGM ? ` <button class="crown" data-id="${p.id}">GM 넘기기</button>` : '';
      return `<li><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.nickname)}${crown}
        ${c ? `<small class="hint">(${esc(c.name)})</small>` : ''}</li>`;
    })
    .join('');
  $$('#playerList .crown').forEach(
    (b) => (b.onclick = () => confirm('이 사람에게 GM을 넘길까요?') && socket.emit('gm:transfer', { playerId: b.dataset.id }))
  );
}

function renderSpeakAs() {
  const sel = $('#speakAs');
  const prev = sel.value;
  const chars = myChars();
  sel.innerHTML =
    `<option value="">(본인 닉네임)</option>` +
    chars.map((c) => `<option value="${c.id}">${esc(c.name)}${c.alive ? '' : ' ✝'}</option>`).join('');
  const want = prev && chars.some((c) => c.id === prev) ? prev : state.me?.characterId || '';
  sel.value = chars.some((c) => c.id === want) ? want : '';
}
$('#speakAs').onchange = (e) => {
  const c = charById(e.target.value);
  if (!c || c.ownerId === state.me.id) socket.emit('character:select', { id: e.target.value || null });
};

function renderDaily() {
  $('#locationList').innerHTML = state.locations
    .map((l) => `<span class="loc-chip ${l === state.location ? 'current' : ''} ${state.me?.isGM ? 'gm' : ''}" data-loc="${esc(l)}">${esc(l)}</span>`)
    .join('');
  if (state.me?.isGM) {
    $$('#locationList .loc-chip').forEach((el) => (el.onclick = () => socket.emit('gm:location', { location: el.dataset.loc })));
  }
  const c = charById(state.me?.characterId);
  $('#profileView').innerHTML = c
    ? `<b style="color:${c.color}">${esc(c.name)}</b> — ${esc(c.talent)}\n\n${esc(c.profile || '(프로필 없음)')}`
    : '<span class="hint">캐릭터를 선택하면 프로필이 표시됩니다. 학생 명부에서 다른 학생을 클릭하면 프로필을 볼 수 있어요.</span>';
}

function renderInvestigation() {
  $('#fileView').textContent = state.monokumaFile || '(아직 공개되지 않음)';
  $('#evCount').textContent = `${state.evidence.length}개`;
  $('#evList').innerHTML = state.evidence
    .slice()
    .reverse()
    .map(
      (e) => `<div class="ev"><div class="ev-name">${esc(e.name)}</div>
      ${e.desc ? `<div class="ev-desc">${esc(e.desc)}</div>` : ''}
      <div class="ev-meta"><span>📍${esc(e.location)} · ${esc(e.foundBy)}</span>
      <span><button data-edit="${e.id}">수정</button>${state.me?.isGM ? ` <button data-del="${e.id}">삭제</button>` : ''}</span></div></div>`
    )
    .join('');
  $$('#evList [data-edit]').forEach((b) => (b.onclick = () => editEvidence(b.dataset.edit)));
  $$('#evList [data-del]').forEach(
    (b) => (b.onclick = () => confirm('이 언령을 삭제할까요?') && socket.emit('evidence:delete', { id: b.dataset.del }))
  );
}

function editEvidence(id) {
  const e = state.evidence.find((x) => x.id === id);
  if (!e) return;
  const name = prompt('언령 이름', e.name);
  if (name === null) return;
  const desc = prompt('설명', e.desc);
  if (desc === null) return;
  socket.emit('evidence:update', { id, name, desc });
}

$('#evForm').onsubmit = (e) => {
  e.preventDefault();
  socket.emit('evidence:add', { name: $('#evName').value, desc: $('#evDesc').value });
  $('#evName').value = '';
  $('#evDesc').value = '';
};

// {약점} 표기를 강조 span으로
function statementHTML(text, id) {
  return esc(text).replace(/\{([^{}]+)\}/g, (_, w) => `<span class="weak" data-st="${id}">${w}</span>`);
}

function renderTrial() {
  const gm = state.me?.isGM;
  const st = state.trial.statements;
  $('#debate').innerHTML = st.length
    ? st
        .map((s) => {
          const c = charById(s.charId);
          return `<div class="statement ${s.broken ? 'broken' : ''}" style="--c:${c?.color || '#888'}">
          <div class="who">${esc(c?.name || '???')}</div>
          <div class="stext">${statementHTML(s.text, s.id)}</div>
          <div class="tools">
            <button data-shoot="${s.id}">🎯 언령 쏘기</button>
            ${gm ? `<button data-judge="${s.id}" data-ok="1">✔ 논파 성공</button><button data-judge="${s.id}" data-ok="">✘ 실패</button><button data-delst="${s.id}">삭제</button>` : ''}
            ${gm && s.answerId ? `<span>정답: ${esc(state.evidence.find((e) => e.id === s.answerId)?.name || '?')}</span>` : ''}
          </div></div>`;
        })
        .join('')
    : '<p class="hint">아직 발언이 없습니다.</p>';
  $$('#debate .weak, #debate [data-shoot]').forEach((el) => (el.onclick = () => openShoot(el.dataset.st || el.dataset.shoot)));
  $$('#debate [data-judge]').forEach((b) => (b.onclick = () => socket.emit('trial:judge', { statementId: b.dataset.judge, ok: !!b.dataset.ok })));
  $$('#debate [data-delst]').forEach((b) => (b.onclick = () => socket.emit('trial:deleteStatement', { id: b.dataset.delst })));

  const ans = $('#stAnswer');
  const prev = ans.value;
  ans.innerHTML = '<option value="">정답 언령 없음 (GM이 직접 판정)</option>' +
    state.evidence.map((e) => `<option value="${e.id}">정답: ${esc(e.name)}</option>`).join('');
  ans.value = prev;

  renderVote();
}

function renderVote() {
  const t = state.trial;
  const box = $('#votePanel');
  const candidates = state.characters.filter((c) => !c.npc);
  if (t.revealed && t.tally) {
    const max = Math.max(1, ...Object.values(t.tally));
    const rows = candidates
      .map((c) => ({ c, n: t.tally[c.id] || 0 }))
      .sort((a, b) => b.n - a.n);
    box.innerHTML = rows
      .map(
        ({ c, n }) => `<div class="vote-bar">${avatarHTML(c, 28)}<span class="name" style="color:${c.color}">${esc(c.name)}</span>
        <div class="bar" style="width:${(n / max) * 50 + (n ? 4 : 0)}%"></div><b>${n}</b></div>`
      )
      .join('');
    return;
  }
  if (!t.voting) {
    box.innerHTML = '<p class="hint">GM이 투표를 시작하면 여기서 투표할 수 있습니다.</p>';
    return;
  }
  box.innerHTML =
    `<p class="hint">투표 중… (${t.voteCount}명 투표함)</p><div class="vote-grid">` +
    candidates
      .map(
        (c) => `<button class="vote-card ${t.myVote === c.id ? 'selected' : ''}" data-vote="${c.id}" style="--c:${c.color}">
        ${avatarHTML(c)}${esc(c.name)}</button>`
      )
      .join('') +
    '</div>';
  $$('#votePanel [data-vote]').forEach((b) => (b.onclick = () => socket.emit('vote:cast', { charId: b.dataset.vote })));
}

$('#stForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#stText').value.trim();
  if (!text) return;
  socket.emit('trial:statement', { text, charId: $('#speakAs').value || null, answerId: $('#stAnswer').value || null });
  $('#stText').value = '';
};

// ---------- 언령 쏘기 ----------
function openShoot(id) {
  const s = state.trial.statements.find((x) => x.id === id);
  if (!s) return;
  if (!state.evidence.length) return alert('아직 입수한 언령이 없습니다. 조사 탭에서 언령을 추가하세요.');
  shootTargetId = id;
  $('#shootTarget').innerHTML = statementHTML(s.text, s.id);
  $('#bulletList').innerHTML = state.evidence
    .map(
      (e, i) => `<label class="bullet"><input type="radio" name="bullet" value="${e.id}" ${i === 0 ? 'checked' : ''}>
      <div><b>${esc(e.name)}</b><span>${esc(e.desc)}</span></div></label>`
    )
    .join('');
  $('#shootDialog').showModal();
}
function fire(kind) {
  const ev = $('#bulletList input:checked')?.value;
  if (!ev) return;
  socket.emit('trial:shoot', { statementId: shootTargetId, evidenceId: ev, charId: $('#speakAs').value || null, kind });
  $('#shootDialog').close();
}
$('#refuteBtn').onclick = () => fire('refute');
$('#agreeBtn').onclick = () => fire('agree');

// ---------- 로그 ----------
function messageHTML(m) {
  const c = charById(m.charId);
  const time = new Date(m.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  switch (m.type) {
    case 'say':
    case 'action':
      return `<div class="msg ${m.type}" style="--c:${c?.color || '#bbb'}">
        ${c ? avatarHTML(c) : ''}
        <div class="bubble"><div class="who">${esc(c?.name || m.author)}<small>${c ? esc(m.author) + ' · ' : ''}${esc(m.location)} · ${time}</small></div>
        <div class="text">${esc(m.text)}</div></div></div>`;
    case 'narration':
      return `<div class="msg narration"><div class="text">${esc(m.text)}</div></div>`;
    case 'announce':
      return `<div class="msg announce"><div class="bubble"><div class="who">${esc(m.author === '모노쿠마' || !m.author ? '모노쿠마' : '모노쿠마 방송')}<small>${time}</small></div><div class="text">${esc(m.text)}</div></div></div>`;
    case 'phase':
      return `<div class="msg phase" style="--pc:${PHASE_COLOR[m.phase] || '#fff'}"><div class="text">${esc(m.text)}</div></div>`;
    case 'shoot': {
      const res = { break: '▶ BREAK!!', miss: '▶ 튕겨났다…', pending: '' }[m.result] || '';
      return `<div class="msg shoot ${m.kind}" style="--c:${c?.color || '#fff'}">${c ? avatarHTML(c) : ''}
        <div class="bubble"><div class="who">${m.kind === 'agree' ? '동의한다!' : '그건 틀렸어!'}<span class="res ${m.result}">${res}</span></div>
        <div class="text">${esc(m.text)}</div></div></div>`;
    }
    default:
      return `<div class="msg ${esc(m.type)}"><span>${esc(m.text)}</span></div>`;
  }
}
function renderLog() {
  const log = $('#log');
  log.innerHTML = messages.map(messageHTML).join('');
  log.scrollTop = log.scrollHeight;
}
function appendMessage(m) {
  const log = $('#log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  log.insertAdjacentHTML('beforeend', messageHTML(m));
  if (atBottom) log.scrollTop = log.scrollHeight;
}
function toastSystem(text) {
  appendMessage({ type: 'system', text, ts: Date.now() });
}

// 캐릭터 정보가 바뀌면 로그의 이름/이미지도 다시 그린다
let lastCharSig = '';
socket.on('state', () => {
  const sig = JSON.stringify(state.characters.map((c) => [c.id, c.name, c.color, c.image.length, c.image.slice(-40)]));
  if (sig !== lastCharSig) {
    lastCharSig = sig;
    renderLog();
  }
});

// ---------- 채팅 ----------
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  // /r 20 같은 명령어로도 주사위
  const dice = text.match(/^\/(?:r|roll|주사위)\s*d?(\d+)?$/i);
  if (dice) socket.emit('dice', { sides: dice[1] || 6, charId: $('#speakAs').value || null });
  else socket.emit('message:send', { type: $('#msgType').value, text, charId: $('#speakAs').value || null });
  $('#chatInput').value = '';
};
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#chatForm').requestSubmit();
  }
});
$('#diceBtn').onclick = () => socket.emit('dice', { sides: $('#diceSides').value, charId: $('#speakAs').value || null });

// ---------- 탭 ----------
function switchTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name || (name === 'gm' && !state?.me?.isGM)));
}
$$('.tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
let lastPhase = null;
socket.on('state', (s) => {
  // 페이즈가 바뀌면 해당 탭으로 자동 이동 (GM 탭을 보는 중이면 유지)
  if (s.phase !== lastPhase) {
    const cur = $('.tabs .active')?.dataset.tab;
    if (lastPhase !== null && cur !== 'gm') switchTab(s.phase === 'execution' ? 'trial' : s.phase);
    lastPhase = s.phase;
  }
});

// ---------- 캐릭터 편집 ----------
function openChar(id, npc = false) {
  const c = id ? charById(id) : null;
  const canEdit = !c || c.ownerId === state.me.id || state.me.isGM;
  editingCharId = c?.id || null;
  $('#charForm').dataset.npc = npc ? '1' : '';
  $('#charDialogTitle').textContent = c ? (canEdit ? '캐릭터 수정' : '학생 프로필') : npc ? 'NPC 만들기' : '새 캐릭터';
  $('#cName').value = c?.name || '';
  $('#cTalent').value = c?.talent || '';
  $('#cImg').value = c?.image?.startsWith('data:') ? '' : c?.image || '';
  $('#cImgPreview').src = c?.image || '';
  $('#cImgPreview').dataset.data = c?.image?.startsWith('data:') ? c.image : '';
  $('#cColor').value = c?.color || '#ff3e8a';
  $('#cProfile').value = c?.profile || '';
  $$('#charForm input, #charForm textarea').forEach((el) => (el.disabled = !canEdit));
  $('#cSave').classList.toggle('hidden', !canEdit);
  $('#cDelete').classList.toggle('hidden', !c || !canEdit);
  // GM용 생존 토글
  let aliveBtn = $('#cAlive');
  if (!aliveBtn) {
    aliveBtn = document.createElement('button');
    aliveBtn.type = 'button';
    aliveBtn.id = 'cAlive';
    aliveBtn.className = 'btn small';
    $('#cDelete').after(aliveBtn);
  }
  aliveBtn.classList.toggle('hidden', !c || !state.me.isGM);
  if (c) {
    aliveBtn.textContent = c.alive ? '사망 처리' : '되살리기';
    aliveBtn.onclick = () => {
      socket.emit('character:alive', { id: c.id, alive: !c.alive });
      $('#charDialog').close();
    };
  }
  $('#charDialog').showModal();
}
$('#newCharBtn').onclick = () => openChar(null);
$('#npcBtn').onclick = () => openChar(null, true);
$('#cImg').oninput = (e) => {
  $('#cImgPreview').src = e.target.value;
  $('#cImgPreview').dataset.data = '';
};
$('#cImgFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const data = await resizeImage(file, 320);
  $('#cImgPreview').src = data;
  $('#cImgPreview').dataset.data = data;
  $('#cImg').value = '';
};
function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(cv.toDataURL('image/webp', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
$('#charForm').onsubmit = (e) => {
  if (e.submitter?.value !== 'save') return;
  socket.emit('character:save', {
    id: editingCharId,
    npc: !!$('#charForm').dataset.npc,
    name: $('#cName').value,
    talent: $('#cTalent').value,
    image: $('#cImgPreview').dataset.data || $('#cImg').value.trim(),
    color: $('#cColor').value,
    profile: $('#cProfile').value,
  });
};
$('#cDelete').onclick = () => {
  if (editingCharId && confirm('정말 삭제할까요?')) {
    socket.emit('character:delete', { id: editingCharId });
    $('#charDialog').close();
  }
};

// ---------- GM ----------
function renderGM() {
  if (!state.me?.isGM) return;
  // 편집 중인 입력값을 덮어쓰지 않도록 포커스가 없을 때만 채운다
  const fill = (sel, v) => document.activeElement !== $(sel) && ($(sel).value = v);
  fill('#locEdit', state.locations.join(', '));
  fill('#fileEdit', state.monokumaFile);
  fill('#titleEdit', state.title);
}
$$('[data-phase]').forEach((b) => (b.onclick = () => socket.emit('gm:phase', { phase: b.dataset.phase })));
$('#bodyBtn').onclick = () => socket.emit('gm:body');
$('#dayPrev').onclick = () => socket.emit('gm:day', { delta: -1 });
$('#dayNext').onclick = () => socket.emit('gm:day', { delta: 1 });
$('#locSave').onclick = () => socket.emit('gm:locations', { locations: $('#locEdit').value.split(',') });
$('#fileSave').onclick = () => socket.emit('gm:file', { text: $('#fileEdit').value });
$('#voteOpen').onclick = () => socket.emit('vote:open');
$('#voteReveal').onclick = () => socket.emit('vote:reveal');
$('#voteReset').onclick = () => socket.emit('vote:reset');
$('#stClear').onclick = () => confirm('논스톱 의논 발언을 모두 지울까요?') && socket.emit('trial:clear');
$('#titleSave').onclick = () => socket.emit('gm:title', { title: $('#titleEdit').value });
$('#clearLogBtn').onclick = () => confirm('로그를 전부 지울까요? 되돌릴 수 없습니다.') && socket.emit('gm:clearLog');
$('#exportBtn').onclick = () =>
  socket.emit('gm:export', null, (data) => download(`dangan-${state.code}-backup.json`, JSON.stringify(data, null, 2), 'application/json'));
$('#importFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm('현재 방 내용을 백업 파일로 덮어씁니다. 계속할까요?')) return;
    socket.emit('gm:import', { data }, (res) => res?.error && alert(res.error));
  } catch {
    alert('올바른 백업 파일이 아닙니다.');
  }
  e.target.value = '';
};

// 로그를 읽기 좋은 텍스트로 저장 (누구나)
$('#exportLogBtn').onclick = () => {
  const lines = messages.map((m) => {
    const c = charById(m.charId);
    const who = c?.name || m.author || '';
    const t = new Date(m.ts).toLocaleString('ko-KR');
    switch (m.type) {
      case 'say': return `[${t}] [${m.location}] ${who}: 「${m.text}」`;
      case 'action': return `[${t}] [${m.location}] * ${who} ${m.text}`;
      case 'narration': return `\n${m.text}\n`;
      case 'announce': return `[${t}] 📺 모노쿠마: ${m.text}`;
      case 'phase': return `\n==================== ${m.text} ====================\n`;
      default: return `[${t}] ${m.text}`;
    }
  });
  download(`dangan-${state.code}-log.txt`, `${state.title}\n\n` + lines.join('\n'), 'text/plain');
};
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 연출 ----------
let splashTimer = null;
function showSplash({ kind, name, color }) {
  const words = {
    refute: `${name ? `<small>${esc(name)}</small>` : ''}그건 틀렸어!`,
    agree: `${name ? `<small>${esc(name)}</small>` : ''}동의한다!`,
    break: 'BREAK!!',
    miss: '<small>튕겨났다…</small>',
    body: '시체가<br>발견되었습니다!',
    daily: '<small>DAILY LIFE</small>일상 파트',
    investigation: '<small>DEADLY LIFE</small>수사 개시',
    trial: '<small>CLASS TRIAL</small>학급재판 개정!',
    execution: '<small>PUNISHMENT TIME</small>오시오키',
    vote: '<small>VOTE</small>투표 타임!',
  };
  if (!words[kind]) return;
  const el = $('#splash');
  el.className = 'splash ' + kind;
  el.innerHTML = `<div class="word" ${color ? `style="--sc:${esc(color)}"` : ''}>${words[kind]}</div>`;
  clearTimeout(splashTimer);
  splashTimer = setTimeout(() => el.classList.add('hidden'), kind === 'break' || kind === 'miss' ? 1300 : 1700);
}
