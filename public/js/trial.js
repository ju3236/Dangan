// 학급재판: 실시간 채팅 + 단간론파식 대화창 + 표정 스프라이트
import { $, $$, esc, emit, store, render as paint, toast, modal, isGM, charById, myChars, students, evidenceById, avatar, spriteOf, charSelectHTML, fmtTime, weakHTML, clueHTML, speakAs, lastSprite, download, ink, cvar, setCvar } from './core.js';

let shownId = null; // 무대에 표시 중인 메시지
let typing = null;
let sideTab = 'log';
let follow = true; // 새 메시지를 따라갈지

const STAGE_TYPES = ['say', 'point', 'showdown', 'narration', 'announce', 'shoot', 'skill'];

export function mount(el) {
  shownId = null;
  follow = true;
  el.innerHTML = `<div class="trial-room">
    <section class="court">
      <div class="seats" id="seats"></div>
      <div class="stage" id="stage">
        <div class="stage-bg"></div>
        <img class="stage-sprite hidden" id="stageSprite" alt="">
        <div class="stage-initial hidden" id="stageInitial"></div>
        <div class="textbox" id="textbox">
          <div class="nameplate" id="nameplate"></div>
          <div class="tb-text" id="tbText"></div>
          <div class="tb-nav"><button id="tbPrev" title="이전">◀</button><button id="tbNext" title="다음">▶</button><button id="tbLive" title="최신으로">LIVE</button></div>
        </div>
        <div class="climax-board hidden" id="climaxBoard"></div>
      </div>
    </section>
    <aside class="trial-side">
      <nav class="side-tabs" id="sideTabs">
        <button data-side="log">로그</button><button data-side="bullets">언령</button><button data-side="skills">스킬</button><button data-side="vote">투표</button>
      </nav>
      <div class="side-body" id="sideBody" data-keep-scroll="side"></div>
      <div class="sd-bar hidden" id="sdBar"></div>
      <form class="trial-input" id="tForm">
        <div class="ti-top" id="tiTop"></div>
        <div class="sprite-strip" id="spriteStrip"></div>
        <div class="row">
          <textarea id="tText" rows="3" placeholder="발언 입력 (Enter 전송 · Shift+Enter 줄바꿈)&#10;{중괄호}로 감싸면 약점이 됩니다"></textarea>
          <button class="btn pink">발언</button>
        </div>
      </form>
    </aside>
  </div>`;

  $('#tForm').onsubmit = (e) => {
    e.preventDefault();
    send();
  };
  $('#tText').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };
  $('#textbox').onclick = (e) => {
    if (e.target.closest('.tb-nav')) return;
    const ev = e.target.closest('[data-ev]');
    if (ev) return showClue(ev.dataset.ev);
    const w = e.target.closest('[data-weak]');
    if (w) return openShoot(w.dataset.weak);
    if (typing) finishTyping();
  };
  $('#climaxBoard').onclick = (e) => {
    const b = e.target.closest('[data-cx]');
    if (!b) return;
    const [act, v] = b.dataset.cx.split(':');
    if (act === 'place') emit('climax:place', { panelId: v });
    if (act === 'remove') emit('climax:remove', { index: +v });
    if (act === 'clear') emit('climax:clear');
    if (act === 'submit') emit('climax:submit');
    if (act === 'close') emit('climax:close');
  };
  $('#sdBar').onclick = async (e) => {
    const b = e.target.closest('[data-sd]');
    if (!b) return;
    const act = b.dataset.sd;
    if (act === 'next') emit('showdown:next');
    if (act === 'ok') emit('showdown:resolve', { ok: true });
    if (act === 'still') emit('showdown:resolve', { ok: false });
    if (act === 'end' && confirm('반론 쇼다운을 끝낼까요?')) emit('showdown:end');
  };
  $('#tbPrev').onclick = () => step(-1);
  $('#tbNext').onclick = () => step(1);
  $('#tbLive').onclick = () => {
    follow = true;
    showLatest();
  };
  $('#sideTabs').onclick = (e) => {
    const b = e.target.closest('[data-side]');
    if (!b) return;
    sideTab = b.dataset.side;
    renderSide(true);
  };
  showLatest(false);
}

export function unmount() {
  clearInterval(typing?.timer);
  typing = null;
}

export function render(el, name, args, what, payload) {
  if (!$('#stage')) return;
  if (what === 'trial:msg') {
    if (follow && STAGE_TYPES.includes(payload.type)) show(payload.id, true);
    renderSide(false, true);
    return;
  }
  if (what === 'trial:update') {
    if (payload.id === shownId && !typing) show(shownId, false);
    renderSide();
    return;
  }
  if (what === 'trial:log') {
    showLatest(false);
  }
  renderSeats();
  renderInput();
  renderSide();
  renderClimax();
  renderShowdown();
}

// ---------- 클라이맥스 추리 판 ----------
// 섞인 컷을 눌러 순서대로 칸에 넣는다. 모두가 같은 판을 함께 움직인다
function renderClimax() {
  const box = $('#climaxBoard');
  const cx = store.state.trial.climax;
  if (!cx || cx.solved) {
    box.classList.add('hidden');
    if (cx?.solved && isGM()) {
      box.classList.remove('hidden');
      box.innerHTML = '<div class="cx-head"><b>클라이맥스 추리 완료!</b><button type="button" class="btn tiny" data-cx="close">판 닫기</button></div>';
    }
    return;
  }
  box.classList.remove('hidden');
  const byId = (id) => cx.panels.find((p) => p.id === id);
  const pool = cx.panels.filter((p) => !cx.slots.includes(p.id));
  box.innerHTML = `<div class="cx-head"><b>🧩 클라이맥스 추리</b><span class="hint">컷을 눌러 사건이 일어난 순서대로 채우세요. 모두가 같은 판을 함께 움직입니다.</span>
      ${cx.lastHits !== null ? `<span class="cx-hits">지난 시도: ${cx.lastHits}/${cx.panels.length}컷 정답</span>` : ''}
      ${isGM() ? '<button type="button" class="btn tiny ghost" data-cx="close">닫기</button>' : ''}</div>
    <ol class="cx-slots">${cx.panels
      .map((_, i) => {
        const p = byId(cx.slots[i]);
        return `<li class="${p ? 'filled' : ''}" ${p ? `data-cx="remove:${i}" title="눌러서 빼기"` : ''}><i>${i + 1}</i>${p ? esc(p.text) : ''}</li>`;
      })
      .join('')}</ol>
    <div class="cx-pool">${pool.map((p) => `<button type="button" class="cx-card" data-cx="place:${p.id}">${esc(p.text)}</button>`).join('') || '<span class="hint">모든 컷을 놓았습니다.</span>'}</div>
    <div class="row end"><button type="button" class="btn small ghost" data-cx="clear">다시 놓기</button>
      <button type="button" class="btn small pink" data-cx="submit" ${cx.slots.length === cx.panels.length ? '' : 'disabled'}>이게 사건의 전말이다!</button></div>`;
}

// ---------- 반론 쇼다운 ----------
function renderShowdown() {
  const bar = $('#sdBar');
  const sd = store.state.trial.showdown;
  if (!sd) return bar.classList.add('hidden');
  const a = charById(sd.attackerId);
  const t = charById(sd.targetId);
  const mine = a?.mine || isGM();
  bar.classList.remove('hidden');
  bar.innerHTML = `<div><b>⚔ 반론 쇼다운</b> <span style="${ink(a?.color)}">${esc(a?.name || '?')}</span> → <span style="${ink(t?.color)}">${esc(t?.name || '?')}</span> <small>대사 ${sd.index + 1}/${sd.total}</small></div>
    ${mine
      ? `<div class="row wrap">${sd.index + 1 < sd.total ? '<button type="button" class="btn tiny" data-sd="next">다음 대사 ▶</button>' : ''}
          <button type="button" class="btn tiny pink" data-sd="ok">베였다… 수긍한다 (BREAK)</button>
          <button type="button" class="btn tiny" data-sd="still">아직이야!</button>
          <button type="button" class="btn tiny ghost" data-sd="end">끝내기</button></div>`
      : '<div class="hint">대사의 주황색 약점을 눌러 언령으로 베어 주세요!</div>'}`;
}

function openShowdown() {
  const chars = myChars().filter((c) => c.alive);
  if (!chars.length) return toast('반론할 캐릭터가 없습니다.', 'error');
  const as = chars.find((c) => c.id === speakAs()) || chars[0];
  const targets = students().filter((c) => c.alive);
  const d = modal(`<h2>⚔ 반론하겠어!</h2>
    <p class="hint">상대의 주장에 1:1로 반론합니다. 대사를 한 줄에 하나씩, 2~4줄 정도 적어 주세요. 상대가 베어야 할 부분은 {중괄호}로 감싸요. 상대가 약점을 베면 수긍할지 버틸지는 당신이 정합니다.</p>
    <div class="row"><label class="grow">반론하는 캐릭터${charSelectHTML('sdA', as.id, { chars })}</label>
      <label class="grow">상대${charSelectHTML('sdT', (targets.find((c) => !c.mine) || targets.find((c) => c.id !== as.id))?.id, { chars: targets })}</label></div>
    <textarea id="sdLines" rows="5" placeholder="그 추리는 억지야!
나는 {그 시간에 식당에} 있었다고!
증거라도 있어?"></textarea>
    <div class="row end"><button class="btn small pink" id="sdGo">반론 시작</button></div>`);
  $('#sdGo', d).onclick = async () => {
    const lines = $('#sdLines', d).value.split('\n');
    if (await emit('showdown:start', { charId: $('#sdA', d).value, targetId: $('#sdT', d).value, lines })) d.close();
  };
}

// ---------- 무대 ----------
const stageMsgs = () => store.trial.filter((m) => STAGE_TYPES.includes(m.type));

function showLatest(animate = false) {
  const list = stageMsgs();
  if (list.length) show(list[list.length - 1].id, animate);
  else clearStage();
}

function step(d) {
  const list = stageMsgs();
  const i = list.findIndex((m) => m.id === shownId);
  const next = list[Math.min(Math.max(i + d, 0), list.length - 1)];
  if (!next) return;
  follow = next === list[list.length - 1];
  show(next.id, false);
}

function clearStage() {
  shownId = null;
  $('#stageSprite').classList.add('hidden');
  $('#stageInitial').classList.add('hidden');
  $('#nameplate').textContent = '';
  $('#nameplate').style.removeProperty('--c');
  $('#tbText').innerHTML = '<span class="hint">아직 발언이 없습니다. 재판을 시작해 주세요.</span>';
  $('#textbox').className = 'textbox';
}

function show(id, animate) {
  const m = store.trial.find((x) => x.id === id);
  if (!m) return;
  shownId = id;
  const c = charById(m.charId);
  const box = $('#textbox');
  box.className = `textbox ${m.type} ${m.kind || ''} ${m.broken ? 'broken' : ''}`;
  const plate = $('#nameplate');
  let name = c?.name || '';
  if (m.type === 'announce') name = '모노쿠마';
  if (m.type === 'narration') name = '';
  if (m.type === 'shoot') name = `${c?.name || ''} — ${m.kind === 'agree' ? '동의한다!' : '그건 틀렸어!'}`;
  if (m.type === 'skill') name = `${c?.name || ''} — 스킬 발동`;
  if (m.type === 'point') name = `논스톱 의논 — 논점 ${m.index}`;
  if (m.type === 'showdown') name = `${c?.name || ''} ⚔ 반론! (${m.line}/${m.total})`;
  if (m.type === 'shoot' && m.kind === 'cut') name = `${c?.name || ''} — 그 말, 베어 주겠어!`;
  plate.textContent = name;
  plate.classList.toggle('hidden', !name);
  setCvar(plate, m.type === 'announce' ? '#ffffff' : c?.color || '#ff3e8a');

  // 스프라이트: 캐릭터 발언이면 교체, 나레이션이면 이전 스프라이트를 흐리게 유지
  const img = $('#stageSprite');
  const ini = $('#stageInitial');
  const stage = $('#stage');
  if (m.type === 'announce') {
    img.classList.add('hidden');
    ini.classList.remove('hidden');
    ini.textContent = '🐻';
    ini.style.setProperty('--c', '#fff');
    stage.classList.remove('dim');
  } else if (c) {
    const s = spriteOf(c, m.spriteId);
    if (s) {
      if (img.getAttribute('src') !== s.img) img.src = s.img;
      img.classList.remove('hidden');
      ini.classList.add('hidden');
      if (animate) {
        img.classList.remove('enter');
        void img.offsetWidth;
        img.classList.add('enter');
      }
    } else {
      img.classList.add('hidden');
      ini.classList.remove('hidden');
      ini.textContent = c.name.slice(0, 1);
      setCvar(ini, c.color);
    }
    stage.classList.remove('dim');
    setCvar(stage, c.color);
  } else {
    stage.classList.add('dim');
  }
  $$('#seats .seat').forEach((s) => s.classList.toggle('speaking', s.dataset.id === m.charId));

  const full = textHTML(m);
  clearInterval(typing?.timer);
  typing = null;
  const el = $('#tbText');
  if (!animate) {
    el.innerHTML = full;
    return;
  }
  // 타자기 효과: 평문으로 한 글자씩 → 끝나면 약점 강조가 들어간 HTML로 교체
  const plain = m.text.replace(/[{}]/g, '');
  let i = 0;
  el.textContent = '';
  typing = {
    full,
    timer: setInterval(() => {
      i += plain.length > 120 ? 3 : 1;
      el.textContent = plain.slice(0, i);
      if (i >= plain.length) finishTyping();
    }, 28),
  };
}

function finishTyping() {
  if (!typing) return;
  clearInterval(typing.timer);
  $('#tbText').innerHTML = typing.full;
  typing = null;
}

function textHTML(m) {
  if (m.type === 'shoot') {
    const res = { break: '<b class="res break">BREAK!!</b>', miss: '<b class="res miss">튕겨났다…</b>', pending: '<b class="res pending">판정 대기</b>' }[m.result] || '';
    return `${clueHTML(m.text)} ${res}`;
  }
  if (m.type === 'say' || m.type === 'point' || m.type === 'showdown') return weakHTML(m.text, m.id, !m.broken, true);
  if (m.type === 'narration' || m.type === 'announce') return clueHTML(m.text);
  return esc(m.text);
}

// ---------- 증언대 좌석 ----------
function renderSeats() {
  const chars = store.state.characters.filter((c) => !c.npc);
  const cur = store.trial.find((m) => m.id === shownId);
  $('#seats').innerHTML = chars
    .map(
      (c) => `<div class="seat ${c.alive ? '' : 'dead'} ${cur?.charId === c.id ? 'speaking' : ''}" data-id="${c.id}" title="${esc(c.name)}" style="${cvar(c.color)}">
        ${avatar(c, 46)}<span>${esc(c.name)}</span></div>`
    )
    .join('');
}

// ---------- 입력 ----------
function renderInput() {
  const gm = isGM();
  const chars = myChars();
  const top = $('#tiTop');
  const type = $('#tType')?.value || 'say';
  const as = speakAs();
  paint(
    top,
    `${charSelectHTML('tAs', as, { chars })}
    <select id="tType">
      <option value="say">대사</option>
      <option value="ooc">OOC (캐릭터 밖)</option>
      ${gm ? '<option value="narration">나레이션 (GM)</option><option value="announce">모노쿠마 (GM)</option>' : ''}
    </select>
    ${gm ? `<select id="tAnswer" title="이 발언의 약점을 논파할 정답 언령"><option value="">정답 언령: 없음 (직접 판정)</option>${store.state.evidence.map((e) => `<option value="${e.id}">정답: ${esc(e.name)}</option>`).join('')}</select>` : ''}
    <button type="button" class="btn tiny ghost" id="tDice" title="주사위 d6">🎲</button>
    <button type="button" class="btn tiny" id="tShowdown" title="반론 쇼다운">⚔ 반론</button>
    <a class="btn tiny ghost" href="#/handbook/me">캐릭터 관리</a>`
  );
  $('#tType').value = type;
  $('#tAs').onchange = (e) => {
    speakAs(e.target.value);
    renderInput();
  };
  $('#tDice').onclick = () => emit('trial:dice', { sides: 6, charId: $('#tAs').value || null });
  $('#tShowdown').onclick = openShowdown;

  const c = charById($('#tAs').value);
  const strip = $('#spriteStrip');
  if (!chars.length) {
    strip.innerHTML = '<span class="hint">캐릭터가 없습니다. 학생수첩에서 캐릭터를 만들어 주세요.</span>';
    return;
  }
  const cur = lastSprite(c?.id) || c?.sprites?.[0]?.id;
  strip.innerHTML = c?.sprites?.length
    ? c.sprites
        .map((s, i) => `<button type="button" class="sprite-btn ${s.id === cur ? 'active' : ''}" data-sprite="${s.id}" title="${esc(s.label)} (Alt+${i + 1})"><img src="${esc(s.img)}" alt=""><span>${esc(s.label)}</span></button>`)
        .join('')
    : `<span class="hint">${esc(c?.name || '')}에게 표정 스프라이트가 없습니다. 학생수첩 → 캐릭터 수정에서 추가할 수 있어요.</span>`;
  $$('[data-sprite]', strip).forEach(
    (b) =>
      (b.onclick = () => {
        lastSprite(c.id, b.dataset.sprite);
        $$('[data-sprite]', strip).forEach((x) => x.classList.toggle('active', x === b));
      })
  );
}

// Alt+숫자로 표정 빠르게 바꾸기
document.addEventListener('keydown', (e) => {
  if (!e.altKey || !/^[1-9]$/.test(e.key) || !$('#spriteStrip')) return;
  const btn = $$('#spriteStrip [data-sprite]')[+e.key - 1];
  if (btn) {
    e.preventDefault();
    btn.click();
  }
});

async function send() {
  const text = $('#tText').value.trim();
  if (!text) return;
  const type = $('#tType').value;
  const charId = $('#tAs').value;
  const dice = text.match(/^\/(?:r|roll|주사위)\s*d?(\d+)?$/i);
  let ok;
  if (dice) ok = await emit('trial:dice', { sides: dice[1] || 6, charId });
  else
    ok = await emit('trial:say', {
      type, text, charId, spriteId: lastSprite(charId) || charById(charId)?.sprites?.[0]?.id || null,
      answerId: $('#tAnswer')?.value || null,
    });
  if (ok) {
    $('#tText').value = '';
    if ($('#tAnswer')) $('#tAnswer').value = '';
    follow = true;
  }
}

// ---------- 사이드 ----------
function renderSide(scrollTop = false, newMsg = false) {
  const body = $('#sideBody');
  if (!body) return;
  $$('#sideTabs [data-side]').forEach((b) => b.classList.toggle('active', b.dataset.side === sideTab));
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  if (!body.childElementCount) scrollTop = true;
  // GM에게만 「사건」 탭 (사건 파일의 재판 논점 참고용)
  const tabs = $('#sideTabs');
  if (isGM() && !$('[data-side=case]', tabs)) tabs.insertAdjacentHTML('beforeend', '<button data-side="case">사건</button>');
  if (!isGM()) {
    $('[data-side=case]', tabs)?.remove();
    if (sideTab === 'case') sideTab = 'log';
  }
  const html = { log: logHTML, bullets: bulletsHTML, skills: skillsHTML, vote: voteHTML, case: caseHTML }[sideTab]();
  paint(body, html);
  if (sideTab === 'log' && (scrollTop || (newMsg && atBottom))) body.scrollTop = body.scrollHeight;
  bindSide(body);
}

function logHTML() {
  const gm = isGM();
  if (!store.trial.length) return '<p class="hint">재판 로그가 비어 있습니다.</p>';
  return (
    store.trial
      .map((m) => {
        const c = charById(m.charId);
        const t = fmtTime(m.ts, false);
        switch (m.type) {
          case 'say':
            return `<div class="lg say ${m.id === shownId ? 'current' : ''} ${m.broken ? 'broken' : ''}" data-show="${m.id}" style="${cvar(c?.color || '#999')}">
              ${avatar(c, 30, m.spriteId)}<div><b>${esc(c?.name || '?')}</b> <small>${t}</small>${gm && m.answerId ? ` <small class="ans">정답: ${esc(evidenceById(m.answerId)?.name || '?')}</small>` : ''}
              <div>${weakHTML(m.text, m.id, !m.broken, true)}</div></div></div>`;
          case 'point':
            return `<div class="lg point ${m.id === shownId ? 'current' : ''} ${m.broken ? 'broken' : ''}" data-show="${m.id}">
              <b>🗯 논점 ${m.index} · ${esc(m.topic)}</b> <small>${t}</small>${gm && m.answerName ? ` <small class="ans">정답: ${esc(m.answerName)}</small>` : ''}
              <div><div>${weakHTML(m.text, m.id, !m.broken, true)}</div></div></div>`;
          case 'showdown': {
            const tg = charById(m.targetId);
            return `<div class="lg showdown ${m.id === shownId ? 'current' : ''} ${m.broken ? 'broken' : ''}" data-show="${m.id}" style="${cvar(c?.color || '#f33')}">
              ${avatar(c, 30)}<div><b>⚔ ${esc(c?.name || '?')}</b> <small>→ ${esc(tg?.name || '?')} · ${m.line}/${m.total} · ${t}</small>
              <div>${weakHTML(m.text, m.id, !m.broken, true)}</div></div></div>`;
          }
          case 'ooc':
            return `<div class="lg ooc" data-show-none><b>${esc(m.author)}</b> <small>OOC ${t}</small> ${clueHTML(m.text)}</div>`;
          case 'narration':
            return `<div class="lg narration" data-show="${m.id}">${clueHTML(m.text)}</div>`;
          case 'announce':
            return `<div class="lg announce" data-show="${m.id}"><b>📺 모노쿠마</b> ${clueHTML(m.text)}</div>`;
          case 'shoot': {
            const res = { break: 'BREAK!!', miss: '튕겨났다…', pending: '판정 대기' }[m.result];
            return `<div class="lg shoot ${m.kind} ${m.result}" data-show="${m.id}" style="${cvar(c?.color || '#f80')}">
              <b>${esc(c?.name || '')} — ${{ agree: '동의한다!', cut: '그 말, 베어 주겠어!' }[m.kind] || '그건 틀렸어!'}</b> <span class="res">${res}</span>
              <div>${clueHTML(m.text)}</div>
              ${gm && m.result === 'pending' && m.kind !== 'cut' ? `<div class="row"><button class="btn tiny" data-judge="${m.id}" data-ok="1">✔ 논파 성공</button><button class="btn tiny ghost" data-judge="${m.id}">✘ 실패</button></div>` : ''}</div>`;
          }
          case 'skill':
            return `<div class="lg skill" data-show="${m.id}" style="${cvar(c?.color || '#a6f')}"><b>✨ ${esc(c?.name || '')} 스킬 발동</b><div>${esc(m.text)}</div></div>`;
          case 'phase':
            return `<div class="lg phase">${esc(m.text)}</div>`;
          default:
            return `<div class="lg sys">${esc(m.text)}</div>`;
        }
      })
      .join('') +
    `<div class="row end log-tools"><button class="btn tiny ghost" id="saveLog">로그 저장</button>${gm ? '<button class="btn tiny ghost" id="clearLog">로그 비우기</button>' : ''}</div>`
  );
}

function caseHTML() {
  const c = [...(store.state.cases || [])].reverse().find((x) => (x.file || x.hasFile) && x.status !== 'closed');
  if (!c) return '<p class="hint">진행 중인 사건 파일이 없습니다. GM → 사건 기획에서 만들 수 있어요.</p>';
  const used = c.pointsUsed || 0;
  const total = c.pointsTotal ?? c.file?.trialPoints.length ?? 0;
  const finale = `<div class="row wrap finale-btns">
      <button class="btn small" data-climax ${store.state.trial.climax && !store.state.trial.climax.solved ? 'disabled' : ''}>🧩 클라이맥스 추리 시작</button>
      <button class="btn small red" data-exec ${c.revealed || !c.sealed ? '' : 'disabled title="투표 결과 공개 후에 할 수 있어요"'}>⚡ 오시오키 시작</button></div>`;
  const next = `<button class="btn small pink" data-nextpoint="${c.id}" ${used >= total ? 'disabled' : ''}>🗯 다음 논점 내기 (${used}/${total})</button>${finale}`;
  if (c.sealed && !c.revealed)
    return `<h4>🔒 봉인된 사건</h4>
      <p class="hint">GM도 정답을 모르는 상태예요. 「다음 논점 내기」를 누르면 사건 파일의 틀린 주장이 논스톱 의논으로 나오고, 맞는 언령을 쏘면 자동으로 BREAK 판정됩니다.</p>
      ${next}
      <p class="hint">모든 논점이 끝나면 투표 탭에서 투표를 시작하세요. 결과 공개 때 모노쿠마가 정답 여부와 흑막을 발표합니다.</p>`;
  const f = c.file;
  return `<h4>🔪 ${esc(f.title)}</h4>
    <p class="hint">흑막: ${esc(charById(c.culpritId)?.name || '?')} · 피해자: ${esc(charById(c.victimId)?.name || '?')}</p>
    <p class="hint">발언할 때 「정답 언령」을 고르면 자동 판정됩니다. 아래 논점을 직접 발언하거나, 버튼으로 차례대로 낼 수 있어요.</p>
    ${next}
    ${f.trialPoints
      .map((t, i) => `<div class="tp-card"><b>${i + 1}. ${esc(t.topic)}</b><div class="claim">“${weakHTML(t.falseClaim, '', false)}”</div>
        <div>정답 ⚡ <b>${esc(t.answerClue)}</b>${store.state.evidence.some((e) => e.name === t.answerClue) ? '' : ' <small class="warn">(아직 지급 안 됨)</small>'}</div>
        <small>${esc(t.explanation)}</small>
        <button class="btn tiny" data-usepoint="${i}">발언칸에 넣기</button></div>`)
      .join('')}
    <h4>GM 메모</h4><ul class="gm-notes">${f.gmNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
}

function bulletsHTML() {
  const chars = myChars().filter((c) => c.bullets);
  if (!chars.length) return '<p class="hint">내 캐릭터가 없습니다.</p>';
  return `<p class="hint">로그나 대화창의 <span class="weak">주황색 약점</span>을 누르면 언령을 쏠 수 있어요.</p>` +
    chars
      .map(
        (c) => `<h4 style="${ink(c.color)}">${esc(c.name)} <small>${c.bullets.length}개</small></h4>
        ${c.bullets.map((id) => evidenceById(id)).filter(Boolean).map((e) => `<div class="bullet-card"><b>⚡ ${esc(e.name)}</b><p>${clueHTML(e.desc)}</p></div>`).join('') || '<p class="hint">언령 없음</p>'}`
      )
      .join('');
}

function skillsHTML() {
  const chars = myChars().filter((c) => c.mine || isGM());
  return (
    chars
      .map(
        (c) => `<h4 style="${ink(c.color)}">${esc(c.name)}</h4>
        ${c.skills.map((s) => {
          const left = s.maxUses > 0 ? s.maxUses - s.used : null;
          return `<div class="skill-card"><div><b>✨ ${esc(s.name)}</b> <small>${left === null ? '무제한' : `남은 횟수 ${left}/${s.maxUses}`}</small><p>${esc(s.desc)}</p></div>
            <button class="btn tiny pink" data-skill="${c.id}:${s.id}" ${left === 0 ? 'disabled' : ''}>발동</button></div>`;
        }).join('') || '<p class="hint">스킬 없음</p>'}`
      )
      .join('') || '<p class="hint">내 캐릭터가 없습니다.</p>'
  );
}

function voteHTML() {
  const t = store.state.trial;
  const gm = isGM();
  const cands = students();
  let html = '';
  if (gm) {
    html += `<div class="row wrap"><button class="btn tiny pink" id="vOpen">투표 시작</button><button class="btn tiny" id="vReveal">결과 공개</button><button class="btn tiny ghost" id="vReset">초기화</button></div>`;
  }
  if (t.tally && (t.revealed || gm)) {
    const max = Math.max(1, ...Object.values(t.tally));
    html += `<h4>${t.revealed ? '투표 결과' : `현재 집계 (GM만 보임) · ${t.voteCount}표`}</h4>` +
      cands
        .map((c) => ({ c, n: t.tally[c.id] || 0 }))
        .sort((a, b) => b.n - a.n)
        .map(({ c, n }) => `<div class="vote-bar">${avatar(c, 28)}<span class="name" style="${ink(c.color)}">${esc(c.name)}</span><div class="bar" style="width:${(n / max) * 55}%"></div><b>${n}</b></div>`)
        .join('');
  }
  if (t.voting) {
    const voters = myChars().filter((c) => !c.npc && c.alive && (c.mine || gm));
    html += `<h4>투표하기 <small>(${t.voteCount}표 들어옴)</small></h4>` +
      (voters
        .map(
          (v) => `<div class="voter"><span style="${ink(v.color)}">${esc(v.name)}</span> →
          <select data-voter="${v.id}"><option value="">선택…</option>${cands.map((c) => `<option value="${c.id}" ${t.myVotes[v.id] === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          ${t.myVotes[v.id] ? '✔' : ''}</div>`
        )
        .join('') || '<p class="hint">투표할 수 있는 내 캐릭터가 없습니다.</p>');
  } else if (!t.revealed) html += '<p class="hint">GM이 투표를 시작하면 여기서 캐릭터별로 투표할 수 있습니다.</p>';
  return html;
}

function bindSide(body) {
  $$('[data-show]', body).forEach(
    (d) =>
      (d.onclick = (e) => {
        const ev = e.target.closest('[data-ev]');
        if (ev) return showClue(ev.dataset.ev);
        const w = e.target.closest('[data-weak]');
        if (w) return openShoot(w.dataset.weak);
        if (e.target.closest('button')) return;
        follow = false;
        show(d.dataset.show, false);
        $$('.lg.current', body).forEach((x) => x.classList.remove('current'));
        d.classList.add('current');
      })
  );
  $$('[data-show-none] [data-ev]', body).forEach((x) => (x.onclick = () => showClue(x.dataset.ev)));
  $$('[data-nextpoint]', body).forEach((b) => (b.onclick = () => emit('case:point', { id: b.dataset.nextpoint })));
  $$('[data-climax]', body).forEach((b) => (b.onclick = () => confirm('클라이맥스 추리를 시작할까요?') && emit('climax:start')));
  $$('[data-exec]', body).forEach((b) => (b.onclick = () => confirm('흑막의 오시오키를 시작할까요? (흑막은 사망 처리됩니다)') && emit('execution:start')));
  $$('[data-usepoint]', body).forEach((b) => {
    b.onclick = () => {
      const c = [...(store.state.cases || [])].reverse().find((x) => x.file?.trialPoints && x.status !== 'closed');
      const t = c.file.trialPoints[+b.dataset.usepoint];
      $('#tText').value = t.falseClaim;
      const ev = store.state.evidence.find((e) => e.name === t.answerClue);
      if (ev && $('#tAnswer')) $('#tAnswer').value = ev.id;
      $('#tText').focus();
    };
  });
  $$('[data-judge]', body).forEach((b) => (b.onclick = () => emit('trial:judge', { msgId: b.dataset.judge, ok: !!b.dataset.ok })));
  $$('[data-skill]', body).forEach((b) => {
    b.onclick = async () => {
      const [charId, skillId] = b.dataset.skill.split(':');
      if (confirm('스킬을 발동할까요?')) await emit('skill:use', { charId, skillId });
    };
  });
  $$('[data-voter]', body).forEach((s) => (s.onchange = () => s.value && emit('vote:cast', { voterId: s.dataset.voter, targetId: s.value })));
  const on = (id, fn) => $('#' + id, body) && ($('#' + id, body).onclick = fn);
  on('vOpen', () => emit('vote:open'));
  on('vReveal', () => emit('vote:reveal'));
  on('vReset', () => emit('vote:reset'));
  on('clearLog', () => confirm('재판 로그를 모두 지울까요? (먼저 로그 저장을 권장)') && emit('trial:clear'));
  on('saveLog', saveLog);
}

function saveLog() {
  const lines = store.trial.map((m) => {
    const c = charById(m.charId);
    const t = new Date(m.ts).toLocaleString('ko-KR');
    switch (m.type) {
      case 'say': return `[${t}] ${c?.name || '?'}: 「${m.text.replace(/[{}]/g, '')}」`;
      case 'ooc': return `[${t}] (OOC) ${m.author}: ${m.text}`;
      case 'narration': return `\n${m.text}\n`;
      case 'announce': return `[${t}] 📺 모노쿠마: ${m.text}`;
      case 'phase': return `\n========== ${m.text} ==========\n`;
      case 'shoot': return `[${t}] ${c?.name || ''} — ${m.kind === 'agree' ? '동의한다!' : '그건 틀렸어!'} ${m.text} [${m.result}]`;
      case 'skill': return `[${t}] ✨ ${c?.name || ''} 스킬 발동 ${m.text}`;
      default: return `[${t}] ${m.text}`;
    }
  });
  download(`dangan-${store.state.code}-trial-log.txt`, `${store.state.title} 학급재판 로그\n\n${lines.join('\n')}`);
}

// ---------- 언령 쏘기 ----------
function openShoot(msgId) {
  const m = store.trial.find((x) => x.id === msgId);
  if (!m) return;
  const shooters = myChars().filter((c) => c.bullets?.length);
  if (!shooters.length) return toast('언령을 가진 내 캐릭터가 없습니다.', 'error');
  const def = shooters.find((c) => c.id === speakAs()) || shooters[0];
  const d = modal(`<h2>언령 장전</h2>
    <p class="shoot-target">${weakHTML(m.text, '', false)}</p>
    <label class="lbl">쏘는 캐릭터</label>${charSelectHTML('shooter', def.id, { chars: shooters })}
    <div class="bullet-pick" id="bulletPick"></div>
    <div class="row end">${m.type === 'showdown'
      ? '<button class="btn small pink" id="cutBtn">⚔ 그 말, 베어 주겠어!</button>'
      : '<button class="btn small" id="agreeBtn">동의한다!</button><button class="btn small pink" id="refuteBtn">그건 틀렸어!</button>'}</div>`);
  const fill = () => {
    const c = charById($('#shooter', d).value);
    $('#bulletPick', d).innerHTML = c.bullets
      .map((id) => evidenceById(id))
      .filter(Boolean)
      .map((e, i) => `<label class="bullet-opt"><input type="radio" name="bl" value="${e.id}" ${i === 0 ? 'checked' : ''}><div><b>⚡ ${esc(e.name)}</b><span>${esc(e.desc)}</span></div></label>`)
      .join('');
  };
  fill();
  $('#shooter', d).onchange = fill;
  const fire = async (kind) => {
    const ev = $('input[name=bl]:checked', d)?.value;
    if (!ev) return;
    if (await emit('trial:shoot', { msgId, charId: $('#shooter', d).value, evidenceId: ev, kind })) d.close();
  };
  if ($('#cutBtn', d)) $('#cutBtn', d).onclick = () => fire('cut');
  else {
    $('#refuteBtn', d).onclick = () => fire('refute');
    $('#agreeBtn', d).onclick = () => fire('agree');
  }
}

// ---------- 단서 팝업 ----------
// 대사 속 언령 이름을 누르면 그 언령의 설명을 보여준다
function showClue(id) {
  const e = evidenceById(id);
  if (!e) return;
  const holders = myChars().filter((c) => c.bullets?.includes(id));
  modal(`<div class="clue-pop">
    <div class="clue-tag">⚡ 언령 (말탄환)</div>
    <h2>${esc(e.name)}</h2>
    <p class="clue-desc">${esc(e.desc || '설명 없음')}</p>
    <div class="hint">${e.day}일째${e.location ? ` · 📍${esc(e.location)}` : ''}${holders.length ? ` · 보유: ${holders.map((c) => esc(c.name)).join(', ')}` : e.presented ? ' · 학급재판에서 공개됨' : ''}</div>
  </div>`);
}
