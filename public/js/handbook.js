// 전자학생수첩: 학생 명부 / 내 캐릭터(메달·스킬·언령·소지품) / 교칙 / 지도 / 알림
import { $, $$, esc, emit, store, render as paint, modal, toast, isGM, charById, myChars, evidenceById, avatar, charSelectHTML, fmtTime } from './core.js';
import { openEditor, openProfile, charCard, bindCards } from './chars.js';
import { hearts } from './board.js';

const TABS = { roster: '학생 명부', me: '내 캐릭터', mail: '메일', report: '통신부', rules: '교칙', map: '지도', notices: '알림' };

export function render(el, name, args, what) {
  if (what && what.startsWith('trial')) return;
  const tab = TABS[args[0]] ? args[0] : 'roster';
  const body = { roster, me, mail, report, rules, map, notices }[tab](args);
  render2(el, tab, body);
  bind(el, tab, args);
}

function render2(el, tab, body) {
  paint(
    el,
    `<div class="handbook">
      <div class="hb-frame">
        <div class="hb-top"><span>📱 전자학생수첩</span><span>${esc(store.state.title)} · ${store.state.day}일째</span></div>
        <nav class="hb-tabs">${Object.entries(TABS).map(([k, l]) => `<a href="#/handbook/${k}" class="${k === tab ? 'active' : ''}">${l}${k === 'mail' && unreadCount() ? ` <i class="nav-badge">${unreadCount()}</i>` : ''}</a>`).join('')}</nav>
        <div class="hb-body">${body}</div>
      </div>
    </div>`
  );
}

function roster() {
  const s = store.state;
  const st = s.characters.filter((c) => !c.npc);
  const npcs = s.characters.filter((c) => c.npc);
  return `<div class="hb-section-head"><h2>학생 명부 <small>${st.filter((c) => c.alive).length} / ${st.length}명 생존</small></h2>
      <button class="btn small pink" data-new>+ 캐릭터</button></div>
    <div class="card-grid">${st.map(charCard).join('') || '<p class="hint">아직 학생이 없습니다.</p>'}</div>
    ${npcs.length ? `<h3>NPC</h3><div class="card-grid">${npcs.map(charCard).join('')}</div>` : ''}`;
}

function me(args) {
  const chars = myChars().filter((c) => c.mine || isGM());
  if (!chars.length)
    return `<div class="empty-me"><p>아직 캐릭터가 없습니다.</p><button class="btn pink" data-new>+ 첫 캐릭터 만들기</button><p class="hint">한 계정으로 캐릭터를 여러 명 만들 수 있어요.</p></div>`;
  const c = charById(args[1]) && chars.some((x) => x.id === args[1]) ? charById(args[1]) : chars.find((x) => x.mine) || chars[0];
  const bullets = (c.bullets || []).map(evidenceById).filter(Boolean);
  return `<div class="char-chips">${chars.map((x) => `<a href="#/handbook/me/${x.id}" class="chip ${x.id === c.id ? 'active' : ''}" style="--c:${x.color}">${avatar(x, 26)} ${esc(x.name)}${x.npc ? ' <small>NPC</small>' : ''}</a>`).join('')}<button class="chip add" data-new>+ 새 캐릭터</button></div>
    <div class="me-head" style="--c:${c.color}">
      ${avatar(c, 92)}
      <div class="grow"><div class="talent">${esc(c.talent || '초고교급 ???')}</div><h2 style="color:${c.color}">${esc(c.name)}${c.alive ? '' : ' <small class="dead-text">사망</small>'}</h2>
        <div class="coins">🪙 모노쿠마 메달 <b>${c.coins ?? 0}</b> <a href="#/shop" class="btn tiny">매점 가기</a>
          <span class="ticket-count">💞 자유시간 티켓 <b>${c.tickets ?? 0}</b></span> <a href="#/handbook/report/${c.id}" class="btn tiny">통신부</a></div>
        ${c.likes || c.dislikes ? `<div class="likes">${c.likes ? `<span>💗 좋아하는 것: ${esc(c.likes)}</span>` : ''}${c.dislikes ? `<span>💢 싫어하는 것: ${esc(c.dislikes)}</span>` : ''}</div>` : ''}</div>
      <div class="stack"><button class="btn small" data-profile-open="${c.id}">프로필</button><button class="btn small pink" data-edit="${c.id}">수정</button></div>
    </div>
    <div class="me-grid">
      <section><h3>✨ 고유 스킬</h3>
        ${c.skills.map((s) => {
          const left = s.maxUses > 0 ? s.maxUses - s.used : null;
          return `<div class="skill-card"><div><b>${esc(s.name)}</b> <small>${left === null ? '무제한' : `남은 횟수 ${left}/${s.maxUses}`}</small><p>${esc(s.desc)}</p></div>
            <button class="btn tiny pink" data-skill="${s.id}" ${left === 0 ? 'disabled' : ''}>발동</button></div>`;
        }).join('') || '<p class="hint">스킬이 없습니다. 수정 → 고유 스킬에서 추가하세요.</p>'}
      </section>
      <section><h3>⚡ 언령 (말탄환) <small>${bullets.length}</small></h3>
        ${bullets.map((e) => `<div class="bullet-card"><b>⚡ ${esc(e.name)}</b><p>${esc(e.desc)}</p>
          <div class="meta">${e.day}일째${e.location ? ` · 📍${esc(e.location)}` : ''}<button class="link" data-share="${e.id}">공유하기</button></div></div>`).join('') || '<p class="hint">조사 게시판에서 GM이 댓글로 언령을 지급하면 여기 모입니다.</p>'}
      </section>
      <section><h3>🎒 소지품 <small>${(c.inventory || []).length}</small></h3>
        <div class="inv-grid">${(c.inventory || []).map((i) => `<div class="inv-item"><span class="icon">${esc(i.icon)}</span><div class="grow"><b>${esc(i.name)}</b>${i.qty > 1 ? ` <small>×${i.qty}</small>` : ''}<p>${esc(i.desc)}</p></div>
          <div class="stack"><button class="btn tiny" data-give="${i.id}">선물</button><button class="btn tiny ghost" data-use="${i.id}">사용</button></div></div>`).join('') || '<p class="hint">소지품이 없습니다. 매점이나 모노모노 머신에서 얻을 수 있어요.</p>'}</div>
      </section>
    </div>`;
}

// 메일함: 모노쿠마(또는 GM)가 보낸 비밀 메일. 받은 캐릭터의 주인과 GM만 볼 수 있다
export const unreadCount = () => (store.state?.mails || []).filter((m) => !m.read && charById(m.charId)?.mine).length;

function mail() {
  const s = store.state;
  const gm = isGM();
  const list = s.mails.slice().reverse();
  const compose = gm
    ? `<details class="mail-compose" id="mailCompose"><summary>✉️ 메일 보내기 (GM)</summary>
        <div class="stack">
          <div class="chks">${s.characters.map((c) => `<label class="chk"><input type="checkbox" id="mto-${c.id}">${esc(c.name)}</label>`).join('')}</div>
          <div class="row"><input id="mFrom" value="모노쿠마" maxlength="30" style="width:140px"><input id="mSubject" placeholder="제목" maxlength="100" class="grow"></div>
          <textarea id="mBody" rows="5" placeholder="내용"></textarea>
          <div class="row end"><button class="btn small pink" id="mSend">보내기</button></div>
        </div></details>`
    : '';
  return `<h2>메일함</h2>
    ${compose}
    <p class="hint">${gm ? 'GM은 모든 캐릭터의 메일을 볼 수 있습니다.' : '내 캐릭터에게 온 비밀 메일입니다. 다른 사람에게는 보이지 않아요.'}</p>
    <ul class="mail-list">${list
      .map((m) => {
        const c = charById(m.charId);
        return `<li class="${m.read ? '' : 'unread'} ${m.kind || ''}" data-mail="${m.id}">
          ${avatar(c, 34)}<div class="grow"><div><b>${esc(m.subject)}</b></div><small>${esc(m.from)} → ${esc(c?.name || '?')} · ${fmtTime(m.ts)}</small></div>
          ${m.read ? '' : '<i class="nav-badge">N</i>'}</li>`;
      })
      .join('') || '<p class="hint">메일이 없습니다.</p>'}</ul>`;
}

function openMail(id) {
  const m = store.state.mails.find((x) => x.id === id);
  if (!m) return;
  const c = charById(m.charId);
  modal(`<div class="mail-view ${m.kind || ''}">
    <div class="mail-from">📩 From. ${esc(m.from)} → ${esc(c?.name || '?')}<small>${fmtTime(m.ts)}</small></div>
    <h2>${esc(m.subject)}</h2>
    <div class="mail-body">${esc(m.body)}</div>
  </div>`, { wide: true });
  if (!m.read && c?.mine) emit('mail:read', { id });
}

// 통신부: 내 캐릭터와 다른 학생들의 친밀도
function report(args) {
  const chars = myChars().filter((c) => (c.mine || isGM()) && !c.npc);
  if (!chars.length) return `<div class="empty-me"><p>아직 캐릭터가 없습니다.</p><button class="btn pink" data-new>+ 첫 캐릭터 만들기</button></div>`;
  const c = chars.find((x) => x.id === args[1]) || chars.find((x) => x.mine) || chars[0];
  const s = store.state;
  const ft = s.freeTime;
  const others = s.characters.filter((x) => x.id !== c.id && !x.npc);
  const rows = others
    .map((o) => ({ o, a: s.affinity[[c.id, o.id].sort().join('|')] || { points: 0, events: 0, level: 0 } }))
    .sort((x, y) => y.a.points - x.a.points);
  const fragments = rows.reduce((n, r) => n + r.a.level, 0);
  return `<div class="char-chips">${chars.map((x) => `<a href="#/handbook/report/${x.id}" class="chip ${x.id === c.id ? 'active' : ''}" style="--c:${x.color}">${avatar(x, 26)} ${esc(x.name)}</a>`).join('')}</div>
    <div class="report-head" style="--c:${c.color}">
      ${avatar(c, 64)}
      <div class="grow"><div class="talent">통신부</div><h2 style="color:${c.color}">${esc(c.name)}</h2>
        <div>희망의 조각 <b class="frag">${fragments}</b>개 · 💞 남은 자유시간 티켓 <b class="tickets">${c.tickets ?? 0}</b>장</div></div>
    </div>
    <p class="hint">자유시간 1회 +${ft.eventPoints} · 선물 +${ft.giftPoints} (좋아하는 선물 ${ft.likedPoints >= 0 ? '+' : ''}${ft.likedPoints}, 싫어하는 선물 ${ft.dislikedPoints}) · ${ft.levelPoints}점마다 Lv 1 (최대 Lv.${ft.maxLevel})</p>
    <div class="report-list">${rows
      .map(({ o, a }) => {
        const maxed = a.level >= ft.maxLevel;
        const prog = maxed ? 100 : ((a.points % ft.levelPoints) / ft.levelPoints) * 100;
        return `<div class="report-row ${o.alive ? '' : 'dead'}" style="--c:${o.color}">
          <button class="link" data-profile="${o.id}">${avatar(o, 48)}</button>
          <div class="grow"><b style="color:${o.color}">${esc(o.name)}</b> <small>${esc(o.talent)}</small>${o.alive ? '' : ' <small class="dead-text">사망</small>'}
            <div class="row">${hearts(a.level)} <small>Lv.${a.level} · ${a.points}점 · 자유시간 ${a.events}회</small></div>
            <div class="aff-bar"><i style="width:${prog}%"></i></div></div>
          <div class="stack">
            ${o.alive && c.alive ? `<a class="btn tiny pink" href="#/write/freetime/${c.id}/${o.id}">💞 자유시간</a>` : ''}
            <button class="btn tiny" data-gift-to="${o.id}">🎁 선물</button>
          </div></div>`;
      })
      .join('') || '<p class="hint">다른 학생이 아직 없습니다.</p>'}</div>`;
}

function rules() {
  return `<h2>교칙</h2><ol class="rules">${store.state.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>
    ${isGM() ? '<p class="hint">교칙은 GM 화면 → 학원 설정에서 고칠 수 있어요.</p>' : ''}`;
}

function map() {
  const s = store.state;
  const counts = {};
  s.posts.forEach((p) => p.location && (counts[p.location] = (counts[p.location] || 0) + 1));
  return `<h2>학원 지도</h2>
    ${s.mapImage ? `<img class="map-img" src="${esc(s.mapImage)}" alt="지도">` : '<p class="hint">GM이 지도 이미지를 올리면 여기에 표시됩니다.</p>'}
    <h3>장소 <small>${s.timeOfDay === 'night' ? '🌙 지금은 야간' : ''}</small></h3><div class="loc-grid">${s.locations
      .map((l) => {
        const closed = s.nightClosed.includes(l);
        const locked = closed && s.timeOfDay === 'night';
        return `<div class="loc-cell ${locked ? 'locked' : ''}">${locked ? '🔒' : '📍'} ${esc(l)}<small>${counts[l] ? `글 ${counts[l]}개` : ''}${closed ? ' · 야간 출입 금지' : ''}</small></div>`;
      })
      .join('')}</div>`;
}

function notices() {
  const list = store.state.notices.slice().reverse();
  return `<h2>알림</h2><ul class="notice-list">${list.map((n) => `<li class="${n.kind || ''}"><span>${esc(n.text)}</span><small>${n.day}일째 · ${fmtTime(n.ts)}</small></li>`).join('') || '<p class="hint">알림이 없습니다.</p>'}</ul>`;
}

function bind(el, tab, args) {
  $$('[data-new]', el).forEach((b) => (b.onclick = () => openEditor(null)));
  bindCards(el);
  const charId = $('.chip.active', el)?.getAttribute('href')?.split('/').pop();
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
  $$('[data-profile-open]', el).forEach((b) => (b.onclick = () => openProfile(b.dataset.profileOpen)));
  $$('[data-skill]', el).forEach(
    (b) => (b.onclick = () => confirm('스킬을 발동할까요?') && emit('skill:use', { charId, skillId: b.dataset.skill }))
  );
  $$('[data-use]', el).forEach(
    (b) => (b.onclick = () => confirm('이 아이템을 사용할까요? (1개 소모)') && emit('item:use', { charId, invId: b.dataset.use }))
  );
  $$('[data-give]', el).forEach((b) => (b.onclick = () => pickTarget('누구에게 선물할까요?', charId, (toId) => emit('item:give', { fromId: charId, toId, invId: b.dataset.give }))));
  const reportChar = tab === 'report' ? $('.chip.active', el)?.getAttribute('href')?.split('/').pop() : null;
  $$('[data-gift-to]', el).forEach((b) => (b.onclick = () => pickGift(reportChar, b.dataset.giftTo)));
  $$('[data-mail]', el).forEach((li) => (li.onclick = () => openMail(li.dataset.mail)));
  const ms = $('#mSend', el);
  if (ms)
    ms.onclick = async () => {
      const charIds = $$('[id^="mto-"]', el).filter((x) => x.checked).map((x) => x.id.slice(4));
      if (await emit('gm:mail', { charIds, from: $('#mFrom').value, subject: $('#mSubject').value, body: $('#mBody').value })) {
        $('#mSubject').value = '';
        $('#mBody').value = '';
        $$('[id^="mto-"]', el).forEach((x) => (x.checked = false));
        toast('메일을 보냈습니다.');
      }
    };
  $$('[data-share]', el).forEach((b) => (b.onclick = () => pickTarget('누구에게 언령을 공유할까요?', charId, (toId) => emit('evidence:share', { fromId: charId, toId, id: b.dataset.share }))));
}

function pickGift(fromId, toId) {
  const from = charById(fromId);
  const to = charById(toId);
  if (!from?.inventory?.length) return alert(`${from?.name}의 소지품이 없습니다. 매점에서 선물을 사 보세요.`);
  const d = modal(`<h2>🎁 ${esc(to.name)}에게 선물</h2>
    <p class="hint">무엇을 좋아할지는 직접 알아내 보세요…!</p>
    <div class="gift-pick">${from.inventory.map((i, n) => `<label class="bullet-opt"><input type="radio" name="gift" value="${i.id}" ${n === 0 ? 'checked' : ''}><span class="icon">${esc(i.icon)}</span><div><b>${esc(i.name)}</b>${i.qty > 1 ? ` ×${i.qty}` : ''}<span>${esc(i.desc)}</span></div></label>`).join('')}</div>
    <div class="row end"><button class="btn small pink" id="giftOk">선물하기</button></div>`);
  $('#giftOk', d).onclick = async () => {
    const invId = $('input[name=gift]:checked', d)?.value;
    if (invId && (await emit('item:give', { fromId, toId, invId }))) d.close();
  };
}

function pickTarget(title, fromId, fn) {
  const chars = store.state.characters.filter((c) => c.id !== fromId);
  if (!chars.length) return;
  const d = modal(`<h2>${title}</h2>${charSelectHTML('pickTo', null, { chars })}<div class="row end"><button class="btn small pink" id="pickOk">확인</button></div>`);
  $('#pickOk', d).onclick = async () => {
    if (await fn($('#pickTo', d).value)) d.close();
  };
}
