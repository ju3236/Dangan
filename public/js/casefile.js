// GM 사건 기획: 피해자/흑막 추첨 → 사건 파일(AI) → 메일 발송 → 단서 지급 → 시체 발견
import { $, $$, esc, emit, store, render as paint, toast, charById, avatar, weakHTML, fmtTime } from './core.js';

let viewingId = null; // 지난 사건 열람
let promptText = '';
let jsonSig = ''; // JSON 편집칸에 마지막으로 채운 사건 파일

export const gmNav = (active) => `<nav class="gm-nav">
  <a href="#/gm" class="${active === 'main' ? 'active' : ''}">진행 · 관리</a>
  <a href="#/gm/case" class="${active === 'case' ? 'active' : ''}">🔪 사건 기획</a>
</nav>`;

const students = () => store.state.characters.filter((c) => !c.npc);
const activeCase = () => {
  const cases = store.state.cases || [];
  return cases.find((c) => c.id === viewingId) || [...cases].reverse().find((c) => c.status !== 'closed') || null;
};

export function renderCase(el) {
  const s = store.state;
  const c = activeCase();
  const past = (s.cases || []).filter((x) => x.status === 'closed' || (x !== c && x.file)).reverse();
  paint(
    el,
    `<div class="case-page">
      ${gmNav('case')}
      <p class="spoiler-warn">⚠️ 이 화면에는 사건의 진상이 나옵니다. 화면 공유 중이라면 주의하세요.</p>
      ${c ? caseCard(c) : drawForm()}
      ${past.length ? `<section class="gm-card"><h2>지난 사건</h2>${past
        .map((x) => `<div class="row past-case"><b>${esc(x.file?.title || '(사건 파일 없음)')}</b><small>${x.day}일째 · 피해자 ${esc(charById(x.victimId)?.name || '?')} · 흑막 ${esc(charById(x.culpritId)?.name || '?')}</small>
          <span class="grow"></span><button class="btn tiny" data-view="${x.id}">보기</button><button class="btn tiny ghost" data-delcase="${x.id}">삭제</button></div>`)
        .join('')}</section>` : ''}
    </div>`
  );
  // 사건 파일이 바뀌었을 때만 JSON 편집칸을 새로 채운다 (편집 중인 내용 보존)
  const box = $('#caseJson', el);
  if (box && c?.file) {
    const json = JSON.stringify(c.file, null, 2);
    if (json !== jsonSig) {
      box.value = json;
      jsonSig = json;
    }
  }
  bind(el, c);
}

function drawForm() {
  const st = students().filter((c) => c.alive);
  const gmOwns = st.some((c) => c.ownerId === store.state.me.id);
  const opts = `<option value="">🎲 랜덤</option>${st.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}`;
  return `<section class="gm-card case-draw">
    <h2>새 사건 준비</h2>
    <p class="hint">피해자와 흑막을 추첨하고, AI로 사건 파일을 만든 뒤, 두 캐릭터의 학생수첩으로 비밀 메일을 보냅니다.</p>
    <div class="row wrap">
      <label>피해자<select id="dVictim">${opts}</select></label>
      <label>흑막<select id="dCulprit">${opts}</select></label>
      <label>난이도<select id="dDiff"><option>쉬움</option><option selected>보통</option><option>어려움</option></select></label>
    </div>
    <label class="chk"><input type="checkbox" id="dExGM" ${gmOwns ? 'checked' : ''}> 추첨에서 GM(나)의 캐릭터 제외</label>
    <label>사건에 바라는 점 (선택)<textarea id="dNotes" rows="2" placeholder="예: 밀실 트릭, 도서실이 배경, 동기는 과거의 비밀"></textarea></label>
    <button class="btn pink" id="drawBtn">🎲 피해자 · 흑막 추첨</button>
  </section>`;
}

function steps(c) {
  const st = [
    ['추첨', true],
    ['사건 파일', !!c.file],
    ['메일 발송', !!c.sentAt],
    ['시체 발견', !!c.bodyAt],
  ];
  return `<ol class="case-steps">${st.map(([l, done], i) => `<li class="${done ? 'done' : ''}">${i + 1}. ${l}</li>`).join('')}</ol>`;
}

function person(c, role, caseObj) {
  const ch = charById(c);
  return `<div class="case-person ${role}" style="--c:${ch?.color || '#777'}">
    <span class="role">${role === 'victim' ? '피해자' : '흑막'}</span>
    ${avatar(ch, 64)}<b>${esc(ch?.name || '(삭제됨)')}</b><small>${esc(ch?.talent || '')}</small>
    ${caseObj.sentAt || caseObj.status === 'closed' ? '' : `<button class="btn tiny ghost" data-reroll="${role}">다시 뽑기</button>`}
  </div>`;
}

function caseCard(c) {
  const s = store.state;
  const f = c.file;
  const closed = c.status === 'closed';
  return `<section class="gm-card case-card">
    <div class="row wrap"><h2>${esc(f?.title || '사건 준비 중')}</h2><span class="grow"></span>${viewingId ? '<button class="btn tiny ghost" id="backCur">← 현재 사건으로</button>' : ''}</div>
    ${steps(c)}
    <div class="case-people">${person(c.victimId, 'victim', c)}<span class="vs">VS</span>${person(c.culpritId, 'culprit', c)}
      ${c.sentAt || closed ? '' : '<button class="btn tiny" data-reroll="both">둘 다 다시 뽑기</button>'}</div>
    ${!f ? makeFile(c) : fileView(c)}
    ${closed ? '' : `<div class="row wrap case-actions">
      ${f ? `<button class="btn ${c.sentAt ? 'ghost' : 'pink'}" id="sendMail">${c.sentAt ? `📩 메일 다시 보내기 (발송 ${fmtTime(c.sentAt)})` : '📩 흑막 · 피해자에게 메일 발송'}</button>
      <button class="btn ${c.bodyAt ? 'ghost' : 'red'}" id="caseBody" ${c.sentAt ? '' : 'disabled title="메일을 먼저 보내세요"'}>${c.bodyAt ? '🔔 시체 발견 완료' : '🔔 시체 발견 (피해자 사망 + 모노쿠마 파일 공지)'}</button>` : ''}
      <span class="grow"></span>
      <button class="btn small ghost" id="closeCase">${f ? '사건 종료' : '취소'}</button></div>`}
  </section>`;
}

function makeFile(c) {
  const s = store.state;
  return `<div class="row wrap">
      <label>난이도<select id="cDiff">${['쉬움', '보통', '어려움'].map((d) => `<option ${d === c.difficulty ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      <label class="grow">사건에 바라는 점<input id="cNotes" value="${esc(c.notes)}" placeholder="예: 밀실 트릭"></label>
    </div>
    <div class="make-grid">
      <div class="make-box">
        <h3>방법 1 · claude.ai로 만들기 (무료)</h3>
        <ol>
          <li><button class="btn small pink" id="copyPrompt">📋 사건 설계 요청문 복사</button>
            <details id="promptBox"><summary>요청문 직접 보기</summary><textarea id="promptView" rows="6" readonly data-fresh>${esc(promptText)}</textarea></details></li>
          <li><a href="https://claude.ai/new" target="_blank" rel="noopener" class="btn small">claude.ai 열기 ↗</a> 새 채팅에 붙여넣고 보내기</li>
          <li>Claude의 답변 전체를 복사해서 아래에 붙여넣기<textarea id="pasteCase" rows="5" placeholder="Claude가 준 JSON(코드 블록 포함)을 그대로 붙여넣으세요"></textarea>
            <button class="btn small pink" id="importCase">불러오기</button></li>
        </ol>
        <p class="hint">요청문에는 캐릭터 프로필, 친밀도, 최근 역극 기록, 추첨 결과가 들어 있어요. 결과가 마음에 안 들면 그 채팅에서 고쳐 달라고 한 뒤 다시 붙여넣으면 됩니다.</p>
      </div>
      ${s.caseAI ? `<div class="make-box">
        <h3>방법 2 · AI로 바로 생성</h3>
        <p class="hint">서버에 설정된 API 키로 바로 만듭니다. 1~3분 정도 걸려요.</p>
        <button class="btn pink" id="genCase" ${c.generating ? 'disabled' : ''}>${c.generating ? '⏳ 사건을 설계하는 중…' : '🤖 사건 파일 생성'}</button>
      </div>` : ''}
    </div>`;
}

function fileView(c) {
  const f = c.file;
  const evHolders = (i) => {
    const ev = store.state.evidence.find((e) => e.id === c.clueGiven?.[i]);
    return ev ? ev.holders.map((id) => charById(id)?.name).filter(Boolean) : [];
  };
  const kindCls = { 핵심: 'k-key', 보조: 'k-sub', 미스디렉션: 'k-red' };
  return `${c.warnings?.length ? `<div class="case-warn">⚠️ 점검 결과<ul>${c.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <div class="case-sections">
      <section><h3>사건 개요</h3><p class="pre">${esc(f.overview)}</p>
        <dl class="case-facts"><dt>동기</dt><dd>${esc(f.motive)}</dd><dt>수법</dt><dd>${esc(f.method)}</dd><dt>흉기</dt><dd>${esc(f.weapon)}</dd>
        <dt>현장</dt><dd>${esc(f.crimeScene)}</dd><dt>사망 시각</dt><dd>${esc(f.timeOfDeath)}</dd></dl></section>
      <section><h3>타임라인</h3><ul class="timeline">${f.timeline.map((t) => `<li><b>${esc(t.time)}</b> ${esc(t.event)}</li>`).join('')}</ul></section>
      <section><h3>모노쿠마 파일 <small>(시체 발견 때 공개)</small></h3><pre class="mk-file">${esc(f.monokumaFile)}</pre></section>
      <section><h3>비밀 메일</h3>
        <details><summary>🔪 흑막에게: ${esc(f.culpritMail.subject)}</summary><p class="pre">${esc(f.culpritMail.body)}</p></details>
        <details><summary>💀 피해자에게: ${esc(f.victimMail.subject)}</summary><p class="pre">${esc(f.victimMail.body)}</p></details>
      </section>
    </div>
    <section><h3>단서 (언령) <small>조사 글에 대한 답으로 지급하세요. 같은 단서는 같은 언령으로 묶입니다.</small></h3>
      <div class="clue-list">${f.clues
        .map((cl, i) => {
          const holders = evHolders(i);
          return `<div class="clue-row ${kindCls[cl.kind] || ''}">
            <div class="grow"><b>⚡ ${esc(cl.name)}</b> <span class="kind">${esc(cl.kind)}</span> <small>📍${esc(cl.location)}</small>
              <p>${esc(cl.desc)}</p><p class="how">🔎 ${esc(cl.howFound)}</p>
              ${holders.length ? `<p class="given">지급됨: ${esc(holders.join(', '))}</p>` : ''}</div>
            <details class="clue-give" id="cg-${i}"><summary>지급</summary>
              <div class="chks">${students().map((x) => `<label class="chk"><input type="checkbox" id="cg-${i}-${x.id}">${esc(x.name)}</label>`).join('')}</div>
              <button class="btn tiny pink" data-give="${i}">지급</button></details>
          </div>`;
        })
        .join('')}</div></section>
    <section><h3>재판 논점 <small>재판에서 발언할 때 「정답 언령」으로 지정하면 자동 판정됩니다.</small></h3>
      <ol class="trial-points">${f.trialPoints
        .map((t) => `<li><b>${esc(t.topic)}</b><div class="claim">“${weakHTML(t.falseClaim, '', false)}”</div><div>정답: <b class="ans">⚡ ${esc(t.answerClue)}</b> — ${esc(t.explanation)}</div></li>`)
        .join('')}</ol></section>
    <section><h3>GM 메모</h3><ul>${f.gmNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>
    <details class="json-edit" id="jsonBox"><summary>사건 파일 직접 수정 (JSON)</summary>
      <textarea id="caseJson" rows="14">${esc(JSON.stringify(f, null, 2))}</textarea>
      <div class="row"><button class="btn small pink" id="saveJson">저장</button><span class="hint">다른 결과로 통째로 바꾸려면 여기에 새 JSON을 붙여넣고 저장하세요.</span></div>
    </details>`;
}

function bind(el, c) {
  const on = (id, fn) => {
    const b = $('#' + id, el);
    if (b) b.onclick = fn;
  };
  $$('[data-view]', el).forEach((b) => (b.onclick = () => ((viewingId = b.dataset.view), renderCase(el), window.scrollTo(0, 0))));
  $$('[data-delcase]', el).forEach((b) => (b.onclick = () => confirm('이 사건 기록을 삭제할까요?') && emit('case:delete', { id: b.dataset.delcase })));
  on('backCur', () => ((viewingId = null), renderCase(el)));
  on('drawBtn', async () => {
    const res = await emit('case:draw', {
      victimId: $('#dVictim').value, culpritId: $('#dCulprit').value, difficulty: $('#dDiff').value,
      excludeGM: $('#dExGM').checked, notes: $('#dNotes').value,
    });
    if (res) {
      viewingId = null;
      promptText = '';
    }
  });
  if (!c) return;
  const id = c.id;
  $$('[data-reroll]', el).forEach((b) => {
    b.onclick = () => {
      if (c.file && !confirm('다시 뽑으면 지금 사건 파일이 지워집니다. 계속할까요?')) return;
      promptText = '';
      emit('case:reroll', { id, which: b.dataset.reroll });
    };
  });
  const saveSettings = () => emit('case:settings', { id, difficulty: $('#cDiff').value, notes: $('#cNotes').value });
  if ($('#cDiff', el)) $('#cDiff', el).onchange = saveSettings;
  if ($('#cNotes', el)) $('#cNotes', el).onchange = saveSettings;
  on('copyPrompt', async () => {
    await saveSettings();
    const res = await emit('case:prompt', { id });
    if (!res?.prompt) return;
    promptText = res.prompt;
    $('#promptView').value = promptText;
    try {
      await navigator.clipboard.writeText(promptText);
      toast('요청문을 복사했습니다. claude.ai 새 채팅에 붙여넣으세요.');
    } catch {
      $('#promptBox').open = true;
      $('#promptView').select();
      toast('자동 복사가 막혀 있어요. 아래 상자에서 직접 복사해 주세요.', 'error');
    }
  });
  on('importCase', async () => {
    const res = await emit('case:import', { id, text: $('#pasteCase').value });
    if (res) toast(res.warnings?.length ? `불러왔습니다. 점검 경고 ${res.warnings.length}개를 확인하세요.` : '사건 파일을 불러왔습니다.');
  });
  on('genCase', async () => {
    await saveSettings();
    const res = await emit('case:generate', { id });
    if (res) toast('사건 파일을 만들었습니다.');
  });
  on('saveJson', async () => {
    let file;
    try {
      file = JSON.parse($('#caseJson').value);
    } catch (e) {
      return toast('JSON 형식이 올바르지 않습니다: ' + e.message, 'error');
    }
    if (await emit('case:update', { id, file })) toast('저장했습니다.');
  });
  $$('[data-give]', el).forEach((b) => {
    b.onclick = async () => {
      const i = b.dataset.give;
      const charIds = $$(`[id^="cg-${i}-"]`, el).filter((x) => x.checked).map((x) => x.id.slice(`cg-${i}-`.length));
      if (await emit('case:clue', { id, index: +i, charIds })) $$(`[id^="cg-${i}-"]`, el).forEach((x) => (x.checked = false));
    };
  });
  on('sendMail', async () => {
    const v = charById(c.victimId)?.name;
    const k = charById(c.culpritId)?.name;
    if (confirm(`${k}에게 흑막 메일, ${v}에게 피해자 메일을 보낼까요?`)) await emit('case:send', { id });
  });
  on('caseBody', async () => {
    if (confirm(`${charById(c.victimId)?.name}을(를) 사망 처리하고 시체 발견 방송(모노쿠마 파일 포함)을 할까요?`)) await emit('case:body', { id });
  });
  on('closeCase', async () => {
    if (confirm(c.file ? '사건을 종료하고 지난 사건으로 보관할까요?' : '이 추첨을 취소할까요?')) {
      await emit(c.file ? 'case:close' : 'case:delete', { id });
      viewingId = null;
    }
  });
}
