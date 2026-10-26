// GM 관리 화면
import { $, $$, esc, emit, store, render as paint, toast, modal, isGM, charById, avatar, uploadImage, download, PHASES, ink } from './core.js';
import { openEditor, openProfile } from './chars.js';
import { renderCase, gmNav } from './casefile.js';
import { soundAdminHTML, bindSoundAdmin } from './audio.js';
import { cafeImportHTML, bindCafeImport } from './cafeimport.js';

let shopRows = null; // 편집 중인 매점 상품 id 목록 (null이면 서버 상태 그대로)
let backups = null; // 자동 백업 목록 (열었을 때만 불러온다)
let editingLore = null; // 수정 중인 지난 이야기 id
const BACKUP_REASON = {
  auto: '자동', manual: '직접', 'before-import': '불러오기 직전', 'before-restore': '되돌리기 직전',
  'before-clear': '재판 로그 비우기 직전', 'before-case-delete': '사건 삭제 직전', 'before-char-delete': '캐릭터 삭제 직전', 'before-cafe-import': '카페 글 가져오기 직전',
};

export function render(el, name, args, what) {
  if (what && what.startsWith('trial')) return;
  if (!isGM()) {
    el.innerHTML = '<p class="hint pad">GM만 볼 수 있는 화면입니다.</p>';
    return;
  }
  if (args?.[0] === 'case') return renderCase(el);
  const s = store.state;
  const chars = s.characters;
  const checks = (prefix, checked = []) =>
    chars.map((c) => `<label class="chk"><input type="checkbox" id="${prefix}-${c.id}" ${checked.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('');
  if (!shopRows) shopRows = s.shop.items.map((i) => i.id);
  const itemOf = (id) => s.shop.items.find((i) => i.id === id) || { id, name: '', desc: '', icon: '🎁', price: 1, stock: null, gacha: true };

  paint(
    el,
    `${gmNav('main')}<div class="gm">
    <section class="gm-card"><h2>진행</h2>
      <div class="phase-btns">${Object.entries(PHASES).map(([k, l]) => `<button class="btn ${s.phase === k ? 'pink' : ''}" data-phase="${k}">${l}</button>`).join('')}</div>
      <div class="row wrap time-btns"><span>지금: <b>${{ morning: '☀️ 아침', day: '🌤 낮', night: '🌙 야간' }[s.timeOfDay]}</b></span>
        <button class="btn small" data-time="morning" data-next="1">☀️ 아침 방송 (다음 날)</button>
        <button class="btn small" data-time="day">🌤 낮</button>
        <button class="btn small" data-time="night">🌙 야간 방송</button>
        <button class="btn small pink" id="motiveBtn">📼 동기 발표</button></div>
      <div class="row wrap"><button class="btn small" data-day="-1">◀ 전날</button><b>${s.day}일째</b><button class="btn small" data-day="1">다음 날 ▶</button>
        <button class="btn small" id="skillReset">스킬 횟수 초기화</button></div>
      <h3>시체 발견</h3>
      <textarea id="bodyText" rows="2" placeholder="공지 내용 (비우면 기본 문구) — 공지 게시판에 올라가고 조사 파트로 전환됩니다."></textarea>
      <button class="btn red small" id="bodyBtn">🔔 시체 발견 방송</button>
      <h3>모노쿠마 방송</h3>
      <div class="row"><input id="announceText" placeholder="예: 오전 7시입니다! 기상 시간이에요~" class="grow"><button class="btn small" id="announceBtn">방송</button></div>
    </section>

    <section class="gm-card"><h2>캐릭터 관리</h2>
      <table class="gm-table"><thead><tr><th>캐릭터</th><th>플레이어</th><th>메달</th><th>상태</th><th></th></tr></thead><tbody>
      ${chars
        .map(
          (c) => `<tr><td><button class="link" data-prof="${c.id}">${avatar(c, 28)} ${esc(c.name)}</button>${c.npc ? ' <small>NPC</small>' : ''}</td>
          <td><select data-owner="${c.id}">${s.players.map((p) => `<option value="${p.id}" ${p.id === c.ownerId ? 'selected' : ''}>${esc(p.nickname)}</option>`).join('')}</select></td>
          <td class="coins">🪙${c.coins} <input type="number" id="coin-${c.id}" value="5" class="num"><button class="btn tiny" data-coin="${c.id}">지급</button></td>
          <td><button class="btn tiny ${c.alive ? '' : 'red'}" data-alive="${c.id}">${c.alive ? '생존' : '사망'}</button></td>
          <td><button class="btn tiny ghost" data-edit="${c.id}">수정</button></td></tr>`
        )
        .join('') || '<tr><td colspan="5" class="hint">캐릭터 없음</td></tr>'}
      </tbody></table>
      <div class="row wrap"><button class="btn small pink" id="newStudent">+ 학생 만들기</button><button class="btn small" id="newNpc">+ NPC 만들기</button></div>
      <p class="hint">학생 만들기에서 플레이어를 고르면 친구 캐릭터도 대신 만들어 줄 수 있어요. 기존 캐릭터는 「수정」으로 고치고, 플레이어 칸에서 주인을 바꿀 수 있습니다.</p>
    </section>

    <section class="gm-card"><h2>언령 관리</h2>
      <p class="hint">게시판 댓글의 「보상 지급」으로도 언령을 줄 수 있어요. 여기서는 직접 만들고, 누가 가졌는지 바꿀 수 있습니다.</p>
      <div class="stack">
        <div class="row"><input id="evName" placeholder="언령 이름" class="grow" maxlength="60"><select id="evLoc"><option value="">장소</option>${s.locations.map((l) => `<option>${esc(l)}</option>`).join('')}</select></div>
        <textarea id="evDesc" rows="2" placeholder="설명"></textarea>
        <div class="chks">${checks('evto')}</div>
        <button class="btn small pink" id="evCreate">언령 만들기</button>
      </div>
      <div class="ev-admin">${s.evidence
        .slice()
        .reverse()
        .map(
          (e) => `<details id="evd-${e.id}"><summary><b>⚡ ${esc(e.name)}</b> <small>${e.day}일째 ${esc(e.location || '')} · 보유 ${e.holders.length}명</small></summary>
          <p>${esc(e.desc)}</p><div class="chks">${checks('h-' + e.id, e.holders)}</div>
          <div class="row"><button class="btn tiny pink" data-holders="${e.id}">보유자 저장</button><button class="btn tiny" data-evedit="${e.id}">수정</button><button class="btn tiny red" data-evdel="${e.id}">삭제</button></div></details>`
        )
        .join('')}</div>
    </section>

    <section class="gm-card"><h2>아이템 지급</h2>
      <div class="row"><input id="itIcon" value="🎁" class="icon-input" maxlength="8"><input id="itName" placeholder="아이템 이름" class="grow" maxlength="60"></div>
      <input id="itDesc" placeholder="설명">
      <div class="chks">${checks('itto')}</div>
      <button class="btn small pink" id="itGrant">지급</button>
    </section>

    <section class="gm-card wide"><h2>자유시간 · 친밀도</h2>
      <div class="ft-settings">
        ${[['ticketsPerDay', '하루 티켓'], ['eventPoints', '자유시간 1회'], ['giftPoints', '선물'], ['likedPoints', '좋아하는 선물'], ['dislikedPoints', '싫어하는 선물'], ['levelPoints', '레벨당 점수'], ['maxLevel', '최대 레벨']]
          .map(([k, l]) => `<label>${l}<input type="number" id="ft-${k}" value="${s.freeTime[k]}" class="num"></label>`)
          .join('')}
        <label class="chk"><input type="checkbox" id="ft-bondReward" ${s.freeTime.bondReward ? 'checked' : ''}> 최대 레벨 보상 (유대 스킬 + 메일)</label>
        <button class="btn small pink" id="ftSave">설정 저장</button>
      </div>
      <div class="row wrap"><b>티켓</b>${students().map((c) => `<span class="ticket-chip">${esc(c.name)} <b>${c.tickets}</b><button data-tk="${c.id}:1">+</button><button data-tk="${c.id}:-1">−</button></span>`).join('')}
        <button class="btn tiny" id="ftRefill">전원 충전</button></div>
      <p class="hint">다음 날로 넘기면 티켓이 자동으로 충전됩니다.</p>
      <div class="row wrap">친밀도 조정 ${charOpts('affA')} ♥ ${charOpts('affB', 1)} <input type="number" id="affDelta" value="5" class="num"><button class="btn tiny pink" id="affApply">적용</button></div>
      ${affinityMatrix()}
    </section>

    <section class="gm-card wide"><h2>매점 관리</h2>
      <div class="row"><label>모노모노 머신 가격 <input type="number" id="gachaPrice" value="${s.shop.gachaPrice}" class="num"></label></div>
      <table class="gm-table shop-edit"><thead><tr><th>아이콘</th><th>이름</th><th>설명</th><th>가격</th><th>재고<br><small>(빈칸=무한)</small></th><th>머신</th><th></th></tr></thead><tbody>
      ${shopRows
        .map((id) => {
          const i = itemOf(id);
          return `<tr><td><input id="si-icon-${id}" value="${esc(i.icon)}" class="icon-input" maxlength="8"></td>
            <td><input id="si-name-${id}" value="${esc(i.name)}" maxlength="60"></td>
            <td><input id="si-desc-${id}" value="${esc(i.desc)}"></td>
            <td><input id="si-price-${id}" type="number" value="${i.price}" class="num"></td>
            <td><input id="si-stock-${id}" type="number" value="${i.stock ?? ''}" class="num"></td>
            <td><input id="si-gacha-${id}" type="checkbox" ${i.gacha ? 'checked' : ''}></td>
            <td><button class="btn tiny ghost" data-rmitem="${id}">✕</button></td></tr>`;
        })
        .join('')}
      </tbody></table>
      <div class="row"><button class="btn small" id="addItem">+ 상품 추가</button><button class="btn small pink" id="saveShop">매점 저장</button></div>
    </section>

    <section class="gm-card"><h2>학원 설정</h2>
      <div class="row"><label class="grow">방 제목<input id="setTitle" value="${esc(s.title)}" maxlength="60"></label>
        <label>시작 챕터<input id="setChapter" type="number" min="1" value="${s.chapterStart}" class="num" title="카페에서 제1장을 했다면 2"></label></div>
      <label>장소 (한 줄에 하나)<textarea id="setLocs" rows="5">${esc(s.locations.join('\n'))}</textarea></label>
      <label>교칙 (한 줄에 하나)<textarea id="setRules" rows="6">${esc(s.rules.join('\n'))}</textarea></label>
      <label>🌙 야간 출입 금지 장소 (한 줄에 하나 — 야간 방송 뒤에는 이 장소로 글을 쓸 수 없어요)<textarea id="setNight" rows="3">${esc(s.nightClosed.join('\n'))}</textarea></label>
      <div class="row wrap"><button class="btn small pink" id="saveSettings">설정 저장</button>
        <label class="btn small">지도 이미지 업로드<input type="file" id="mapFile" accept="image/*" hidden></label>
        ${s.mapImage ? '<button class="btn small ghost" id="mapClear">지도 삭제</button>' : ''}</div>
    </section>

    <section class="gm-card wide"><h2>📚 지난 이야기</h2>
      <p class="hint">카페 등 사이트 밖에서 진행한 챕터를 적어 두세요. 요약이든 원문 복사든 괜찮아요. AI 사건 설계 요청문에 「이미 일어난 일」로 들어가서, 새 사건이 앞 이야기와 모순되지 않고 복선과 관계를 이어받게 됩니다.
        「모두 공개」로 두면 플레이어도 로그북에서 읽을 수 있어요. (그 챕터에서 사망한 캐릭터는 캐릭터 관리에서 사망 처리해 주세요)</p>
      <div class="lore-list">${s.lore
        .map((l) => `<div class="lore-row"><b>${esc(l.title)}</b><small>${l.public ? '모두 공개' : 'GM만'} · ${l.text.length.toLocaleString()}자</small>
          <span class="grow"></span><button class="btn tiny ghost" data-lore-edit="${l.id}">수정</button><button class="btn tiny ghost" data-lore-del="${l.id}">삭제</button></div>`)
        .join('') || '<p class="hint">아직 기록이 없습니다.</p>'}</div>
      <div class="stack lore-form">
        <div class="row"><input id="loreTitle" placeholder="제목 (예: 제1장 — 카페 진행 요약)" maxlength="80" class="grow">
          <label class="chk"><input type="checkbox" id="lorePublic" checked> 모두 공개</label></div>
        <textarea id="loreText" rows="8" placeholder="누가 어떻게 죽었는지, 흑막과 동기, 처형, 남은 떡밥, 캐릭터들의 관계 변화 등을 적어 주세요."></textarea>
        <div class="row"><button class="btn small pink" id="loreSave">${editingLore ? '수정 저장' : '기록 추가'}</button>${editingLore ? '<button class="btn small ghost" id="loreCancel">취소</button>' : ''}</div>
      </div>
    </section>

    ${cafeImportHTML()}

    <section class="gm-card"><h2>🎵 사운드</h2>${soundAdminHTML()}</section>

    <section class="gm-card"><h2>플레이어</h2>
      <p class="hint">GM은 여러 명일 수 있어요. 봉인된 사건은 GM끼리도 서로 보이지 않습니다.</p>
      ${s.players.map((p) => `<div class="row"><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.nickname)} ${p.isGM ? '<b class="gm-badge">GM</b>' : ''}
        <button class="btn tiny ghost" data-role="${p.id}" data-on="${p.isGM ? '' : '1'}">${p.isGM ? 'GM 해제' : 'GM 권한 주기'}</button></div>`).join('')}
      <h3>💾 자동 백업</h3>
      <p class="hint">10분마다 바뀐 내용이 있으면 서버 컴퓨터의 <code>data/backups</code> 폴더에 자동으로 저장됩니다 (최근 30개 + 하루 1개씩 14일). 불러오기·로그 비우기·삭제 같은 작업 직전에도 저장돼요. 이미지는 포함, 음원은 제외.</p>
      <div class="row wrap"><button class="btn small" id="bkLoad">${backups ? '목록 새로고침' : '백업 목록 보기'}</button><button class="btn small" id="bkNow">지금 백업</button></div>
      ${backups ? `<div class="bk-list">${backups
        .map((b) => `<div class="bk-row"><span>${new Date(b.savedAt).toLocaleString('ko-KR')}</span><small>${esc(BACKUP_REASON[b.reason] || b.reason)} · ${Math.ceil(b.size / 1024)}KB</small>
          <span class="grow"></span><button class="btn tiny ghost" data-bk-get="${b.name}">받기</button><button class="btn tiny" data-bk-restore="${b.name}">되돌리기</button></div>`)
        .join('') || '<p class="hint">아직 백업이 없습니다.</p>'}</div>` : ''}
      <h3>파일로 옮기기</h3>
      <p class="hint">다른 컴퓨터로 옮기거나 따로 보관할 때 쓰세요.</p>
      <div class="row wrap"><button class="btn small" id="exportBtn">방 백업 파일 받기 (JSON)</button>
        <label class="btn small">백업 파일 불러오기<input type="file" id="importFile" accept=".json" hidden></label></div>
    </section>
  </div>`
  );
  bind(el);
}

const students = () => store.state.characters.filter((c) => !c.npc);
const charOpts = (id, sel = 0) => `<select id="${id}">${students().map((c, i) => `<option value="${c.id}" ${i === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;

// 학생 × 학생 친밀도 표
function affinityMatrix() {
  const st = students();
  if (st.length < 2) return '';
  const aff = store.state.affinity;
  return `<div class="aff-matrix-wrap"><table class="aff-matrix"><thead><tr><th></th>${st.map((c) => `<th style="${ink(c.color)}">${esc(c.name)}</th>`).join('')}</tr></thead><tbody>
    ${st
      .map(
        (a) => `<tr><th style="${ink(a.color)}">${esc(a.name)}</th>${st
          .map((b) => {
            if (a.id === b.id) return '<td class="self">—</td>';
            const r = aff[[a.id, b.id].sort().join('|')];
            return `<td class="lv${r?.level || 0}" title="${r?.points || 0}점 · 자유시간 ${r?.events || 0}회">${r ? `Lv.${r.level}<small>${r.points}</small>` : '·'}</td>`;
          })
          .join('')}</tr>`
      )
      .join('')}
  </tbody></table></div>`;
}

// 동기 발표: 모두에게 보내는 방송 + 캐릭터별 비밀 동기
function openMotive() {
  const chars = store.state.characters.filter((c) => !c.npc && c.alive);
  const d = modal(`<h2>📼 동기 발표</h2>
    <p class="hint">모두에게 방송할 내용과, 캐릭터마다 학생수첩 메일로 보낼 「동기」를 적어 주세요. 비워 둔 캐릭터에게는 메일이 가지 않아요.</p>
    <label>방송 내용<textarea id="mvText" rows="2" placeholder="예: 여러분에게 특별한 선물을 준비했어요~ 학생수첩을 확인해 주세요! 우푸푸!"></textarea></label>
    ${chars.map((c) => `<label style="${ink(c.color)}">${esc(c.name)}에게<textarea data-mv="${c.id}" rows="2" placeholder="예: 당신의 가족이 위험에 처한 영상이 도착했다…"></textarea></label>`).join('')}
    <div class="row end"><button class="btn small pink" id="mvSend">발표</button></div>`, { wide: true });
  $('#mvSend', d).onclick = async () => {
    const perChar = {};
    $$('[data-mv]', d).forEach((t) => (perChar[t.dataset.mv] = t.value));
    if (await emit('gm:motive', { text: $('#mvText', d).value, perChar })) d.close();
  };
}

function bind(el) {
  bindSoundAdmin(el);
  bindCafeImport(el);
  const on = (id, fn) => {
    const b = $('#' + id, el);
    if (b) b.onclick = fn;
  };
  const checked = (prefix) => $$(`[id^="${prefix}-"]`, el).filter((x) => x.checked).map((x) => x.id.slice(prefix.length + 1));

  $$('[data-phase]', el).forEach((b) => (b.onclick = () => emit('gm:phase', { phase: b.dataset.phase })));
  $$('[data-day]', el).forEach((b) => (b.onclick = () => emit('gm:day', { delta: +b.dataset.day })));
  $$('[data-time]', el).forEach((b) => {
    b.onclick = () => {
      const text = prompt('방송 내용 (비우면 기본 문구)', '');
      if (text !== null) emit('gm:time', { time: b.dataset.time, text, nextDay: !!b.dataset.next });
    };
  });
  on('motiveBtn', openMotive);
  on('skillReset', () => confirm('모든 캐릭터의 스킬 사용 횟수를 초기화할까요?') && emit('skill:reset'));
  on('bodyBtn', async () => {
    if (!confirm('시체 발견 방송을 할까요? (조사 파트로 전환)')) return;
    if (await emit('gm:body', { text: $('#bodyText').value })) $('#bodyText').value = '';
  });
  on('announceBtn', async () => {
    if (await emit('gm:announce', { text: $('#announceText').value })) $('#announceText').value = '';
  });

  $$('[data-prof]', el).forEach((b) => (b.onclick = () => openProfile(b.dataset.prof)));
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
  $$('[data-owner]', el).forEach((s) => (s.onchange = () => emit('gm:giveChar', { charId: s.dataset.owner, playerId: s.value })));
  $$('[data-coin]', el).forEach((b) => (b.onclick = () => emit('character:coins', { id: b.dataset.coin, delta: $('#coin-' + b.dataset.coin).value })));
  $$('[data-alive]', el).forEach((b) => {
    b.onclick = () => {
      const c = charById(b.dataset.alive);
      if (!c.alive || confirm(`${c.name}을(를) 사망 처리할까요?`)) emit('character:alive', { id: c.id, alive: !c.alive });
    };
  });
  on('newNpc', () => openEditor(null, { npc: true }));
  on('newStudent', () => openEditor(null));

  on('evCreate', async () => {
    const res = await emit('evidence:create', { name: $('#evName').value, desc: $('#evDesc').value, location: $('#evLoc').value, charIds: checked('evto') });
    if (res) {
      $('#evName').value = '';
      $('#evDesc').value = '';
      $$('[id^="evto-"]', el).forEach((x) => (x.checked = false));
      toast('언령을 만들었습니다.');
    }
  });
  $$('[data-holders]', el).forEach((b) => (b.onclick = async () => (await emit('evidence:holders', { id: b.dataset.holders, charIds: checked('h-' + b.dataset.holders) })) && toast('저장했습니다.')));
  $$('[data-evedit]', el).forEach((b) => {
    b.onclick = () => {
      const e = store.state.evidence.find((x) => x.id === b.dataset.evedit);
      const name = prompt('언령 이름', e.name);
      if (name === null) return;
      const desc = prompt('설명', e.desc);
      if (desc !== null) emit('evidence:edit', { id: e.id, name, desc });
    };
  });
  $$('[data-evdel]', el).forEach((b) => (b.onclick = () => confirm('이 언령을 삭제할까요? 모든 캐릭터에게서 사라집니다.') && emit('evidence:delete', { id: b.dataset.evdel })));

  on('ftSave', async () => {
    const data = {};
    ['ticketsPerDay', 'eventPoints', 'giftPoints', 'likedPoints', 'dislikedPoints', 'levelPoints', 'maxLevel'].forEach((k) => (data[k] = $('#ft-' + k).value));
    data.bondReward = $('#ft-bondReward').checked;
    if (await emit('gm:freetime', data)) toast('자유시간 설정을 저장했습니다.');
  });
  on('ftRefill', () => emit('gm:tickets', { refill: true }));
  $$('[data-tk]', el).forEach((b) => {
    b.onclick = () => {
      const [charId, delta] = b.dataset.tk.split(':');
      emit('gm:tickets', { charId, delta: +delta });
    };
  });
  on('affApply', () => {
    if ($('#affA').value === $('#affB').value) return toast('서로 다른 두 학생을 고르세요.', 'error');
    emit('gm:affinity', { a: $('#affA').value, b: $('#affB').value, delta: $('#affDelta').value });
  });

  on('itGrant', async () => {
    const res = await emit('item:grant', { icon: $('#itIcon').value, name: $('#itName').value, desc: $('#itDesc').value, charIds: checked('itto') });
    if (res) {
      $('#itName').value = '';
      $('#itDesc').value = '';
      toast('지급했습니다.');
    }
  });

  on('addItem', () => {
    shopRows.push('new' + Math.random().toString(36).slice(2, 8));
    render(el);
  });
  $$('[data-rmitem]', el).forEach((b) => (b.onclick = () => ((shopRows = shopRows.filter((id) => id !== b.dataset.rmitem)), render(el))));
  on('saveShop', async () => {
    const items = shopRows.map((id) => ({
      id: id.startsWith('new') ? null : id,
      icon: $(`#si-icon-${id}`).value,
      name: $(`#si-name-${id}`).value,
      desc: $(`#si-desc-${id}`).value,
      price: $(`#si-price-${id}`).value,
      stock: $(`#si-stock-${id}`).value === '' ? null : $(`#si-stock-${id}`).value,
      gacha: $(`#si-gacha-${id}`).checked,
    }));
    if (await emit('shop:save', { items, gachaPrice: $('#gachaPrice').value })) {
      shopRows = null;
      el.querySelector('.shop-edit tbody').innerHTML = '';
      render(el);
      toast('매점을 저장했습니다.');
    }
  });

  on('saveSettings', async () => {
    const lines = (id) => $(id).value.split(/\n/).map((x) => x.trim()).filter(Boolean);
    if (await emit('gm:settings', { title: $('#setTitle').value, chapterStart: $('#setChapter').value, locations: lines('#setLocs'), rules: lines('#setRules'), nightClosed: lines('#setNight') })) toast('설정을 저장했습니다.');
  });
  const mf = $('#mapFile', el);
  if (mf)
    mf.onchange = async () => {
      const url = await uploadImage(mf.files[0], 1600, 1600);
      if (url) emit('gm:settings', { mapImage: url });
    };
  on('mapClear', () => emit('gm:settings', { mapImage: '' }));

  $$('[data-role]', el).forEach((b) => {
    b.onclick = () => {
      const on = !!b.dataset.on;
      if (confirm(on ? '이 플레이어에게도 GM 권한을 줄까요?' : '이 플레이어의 GM 권한을 해제할까요?')) emit('gm:role', { playerId: b.dataset.role, on });
    };
  });
  $$('[data-lore-edit]', el).forEach((b) => {
    b.onclick = () => {
      const l = store.state.lore.find((x) => x.id === b.dataset.loreEdit);
      editingLore = l.id;
      render(el);
      $('#loreTitle').value = l.title;
      $('#loreText').value = l.text;
      $('#lorePublic').checked = l.public;
      $('#loreTitle').scrollIntoView({ block: 'center' });
    };
  });
  $$('[data-lore-del]', el).forEach((b) => (b.onclick = () => confirm('이 기록을 지울까요?') && emit('gm:loreDelete', { id: b.dataset.loreDel })));
  on('loreCancel', () => {
    editingLore = null;
    render(el);
    $('#loreTitle').value = '';
    $('#loreText').value = '';
  });
  on('loreSave', async () => {
    if (await emit('gm:lore', { id: editingLore, title: $('#loreTitle').value, text: $('#loreText').value, public: $('#lorePublic').checked })) {
      editingLore = null;
      render(el);
      $('#loreTitle').value = '';
      $('#loreText').value = '';
      toast('저장했습니다.');
    }
  });
  const loadBackups = async (ev = 'gm:backups') => {
    const r = await emit(ev);
    if (r) {
      backups = r.list;
      render(el);
    }
  };
  on('bkLoad', () => loadBackups());
  on('bkNow', async () => {
    await loadBackups('gm:backupNow');
    toast('백업했습니다.');
  });
  $$('[data-bk-get]', el).forEach((b) => {
    b.onclick = async () => {
      const r = await emit('gm:backupGet', { name: b.dataset.bkGet });
      if (r?.data) download(`dangan-${store.state.code}-${b.dataset.bkGet}`, JSON.stringify(r.data), 'application/json');
    };
  });
  $$('[data-bk-restore]', el).forEach((b) => {
    b.onclick = async () => {
      const when = new Date(Number(b.dataset.bkRestore.split('-')[0])).toLocaleString('ko-KR');
      if (!confirm(`${when} 시점으로 방 전체를 되돌릴까요?\n(지금 상태도 백업해 두니 다시 돌아올 수 있어요)`)) return;
      if (await emit('gm:backupRestore', { name: b.dataset.bkRestore })) {
        toast('되돌렸습니다.');
        loadBackups();
      }
    };
  });
  on('exportBtn', async () => {
    const data = await emit('gm:export');
    if (data) download(`dangan-${store.state.code}-backup.json`, JSON.stringify(data), 'application/json');
  });
  const imf = $('#importFile', el);
  if (imf)
    imf.onchange = async () => {
      try {
        const data = JSON.parse(await imf.files[0].text());
        if (confirm('현재 방 내용을 백업 파일로 덮어씁니다. 계속할까요?') && (await emit('gm:import', { data }))) toast('불러왔습니다.');
      } catch {
        toast('올바른 백업 파일이 아닙니다.', 'error');
      }
      imf.value = '';
    };
}
