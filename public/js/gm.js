// GM 관리 화면
import { $, $$, esc, emit, store, render as paint, toast, isGM, charById, avatar, uploadImage, download, PHASES } from './core.js';
import { openEditor, openProfile } from './chars.js';

let shopRows = null; // 편집 중인 매점 상품 id 목록 (null이면 서버 상태 그대로)

export function render(el, name, args, what) {
  if (what && what.startsWith('trial')) return;
  if (!isGM()) {
    el.innerHTML = '<p class="hint pad">GM만 볼 수 있는 화면입니다.</p>';
    return;
  }
  const s = store.state;
  const chars = s.characters;
  const checks = (prefix, checked = []) =>
    chars.map((c) => `<label class="chk"><input type="checkbox" id="${prefix}-${c.id}" ${checked.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('');
  if (!shopRows) shopRows = s.shop.items.map((i) => i.id);
  const itemOf = (id) => s.shop.items.find((i) => i.id === id) || { id, name: '', desc: '', icon: '🎁', price: 1, stock: null, gacha: true };

  paint(
    el,
    `<div class="gm">
    <section class="gm-card"><h2>진행</h2>
      <div class="phase-btns">${Object.entries(PHASES).map(([k, l]) => `<button class="btn ${s.phase === k ? 'pink' : ''}" data-phase="${k}">${l}</button>`).join('')}</div>
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
      <button class="btn small" id="newNpc">+ NPC 만들기</button>
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
      <label>방 제목<input id="setTitle" value="${esc(s.title)}" maxlength="60"></label>
      <label>장소 (한 줄에 하나)<textarea id="setLocs" rows="5">${esc(s.locations.join('\n'))}</textarea></label>
      <label>교칙 (한 줄에 하나)<textarea id="setRules" rows="6">${esc(s.rules.join('\n'))}</textarea></label>
      <div class="row wrap"><button class="btn small pink" id="saveSettings">설정 저장</button>
        <label class="btn small">지도 이미지 업로드<input type="file" id="mapFile" accept="image/*" hidden></label>
        ${s.mapImage ? '<button class="btn small ghost" id="mapClear">지도 삭제</button>' : ''}</div>
    </section>

    <section class="gm-card"><h2>플레이어</h2>
      ${s.players.map((p) => `<div class="row"><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.nickname)} ${p.isGM ? '<b class="gm-badge">GM</b>' : `<button class="btn tiny ghost" data-transfer="${p.id}">GM 넘기기</button>`}</div>`).join('')}
      <h3>백업</h3>
      <p class="hint">무료 호스팅은 재시작 시 데이터가 사라질 수 있어요. 세션이 끝나면 백업해 두세요. (이미지 포함)</p>
      <div class="row wrap"><button class="btn small" id="exportBtn">방 백업 (JSON)</button>
        <label class="btn small">백업 불러오기<input type="file" id="importFile" accept=".json" hidden></label></div>
    </section>
  </div>`
  );
  bind(el);
}

function bind(el) {
  const on = (id, fn) => {
    const b = $('#' + id, el);
    if (b) b.onclick = fn;
  };
  const checked = (prefix) => $$(`[id^="${prefix}-"]`, el).filter((x) => x.checked).map((x) => x.id.slice(prefix.length + 1));

  $$('[data-phase]', el).forEach((b) => (b.onclick = () => emit('gm:phase', { phase: b.dataset.phase })));
  $$('[data-day]', el).forEach((b) => (b.onclick = () => emit('gm:day', { delta: +b.dataset.day })));
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
    if (await emit('gm:settings', { title: $('#setTitle').value, locations: lines('#setLocs'), rules: lines('#setRules') })) toast('설정을 저장했습니다.');
  });
  const mf = $('#mapFile', el);
  if (mf)
    mf.onchange = async () => {
      const url = await uploadImage(mf.files[0], 1600, 1600);
      if (url) emit('gm:settings', { mapImage: url });
    };
  on('mapClear', () => emit('gm:settings', { mapImage: '' }));

  $$('[data-transfer]', el).forEach((b) => (b.onclick = () => confirm('이 플레이어에게 GM을 넘길까요?') && emit('gm:transfer', { playerId: b.dataset.transfer })));
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
