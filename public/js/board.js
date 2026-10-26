// 게시판 (일상/조사 파트): 네이버 카페 같은 글 + 댓글
import {
  $, $$, esc, emit, store, local, mentionHTML, render as paint, toast, isGM, charById, myChars, students, playerById,
  avatar, spriteOf, charSelectHTML, fmtTime, speakAs, lastSprite,
} from './core.js';

export const BOARDS = {
  all: '전체글보기',
  notice: '📢 공지사항',
  daily: '☀️ 일상',
  investigation: '🔍 조사',
  freetime: '💞 자유시간',
  free: '💬 자유 (OOC)',
};
const BOARD_DESC = {
  all: '모든 게시판의 글',
  notice: 'GM과 모노쿠마의 공지',
  daily: '일상 파트 역극 — 캐릭터끼리의 하루를 글로 써 주세요.',
  investigation: '조사 파트 — 조사하고 싶은 장소/행동을 글로 올리면 GM이 댓글로 결과를 알려줍니다.',
  freetime: '자유시간 티켓으로 다른 학생과 함께 보낸 시간. 함께한 만큼 친밀도가 올라갑니다.',
  free: '캐릭터 밖(OOC) 잡담, 질문, 공지 확인',
};
const PAGE_SIZE = 15;

let page = 1;
let dayFilter = '';
let query = '';
let replyTo = null;
let grantRows = [];
let ctx = null;

const refresh = () => ctx && renderBoard(ctx.el, ctx.name, ctx.args);

export function mount() {
  replyTo = null;
  grantRows = [];
  page = 1;
}

export function render(el, name, args, what) {
  if (what && what.startsWith('trial')) return;
  ctx = { el, name, args };
  renderBoard(el, name, args);
}

// ---------- 공통 ----------
const seenKey = () => `dgr_seen_${store.state.code}`;
function isNew(p) {
  const seen = local.get(seenKey(), {});
  return seen[p.id] === undefined || seen[p.id] < p.comments.length;
}
function markSeen(p) {
  const seen = local.get(seenKey(), {});
  seen[p.id] = p.comments.length;
  local.set(seenKey(), seen);
}

function authorOf(item) {
  const c = charById(item.charId);
  if (c) return { c, name: c.name, sub: playerById(item.authorId)?.nickname || '', color: c.color };
  if (item.monokuma) return { c: null, name: '모노쿠마', sub: '학원장', color: '#ffffff', monokuma: true };
  const p = playerById(item.authorId);
  const gm = item.gm || (p?.isGM && !item.charId);
  return { c: null, name: p?.nickname || '(알 수 없음)', sub: gm ? 'GM' : 'OOC', color: gm ? '#ffcf3a' : '#9a8fa6', gm };
}

function authorAvatar(a, size, spriteId) {
  if (a.c) return avatar(a.c, size, spriteId);
  if (a.monokuma) return `<span class="avatar monokuma" style="width:${size}px;height:${size}px;font-size:${size * 0.5}px">🐻</span>`;
  return `<span class="avatar" style="--c:${a.color};width:${size}px;height:${size}px;font-size:${size * 0.4}px">${a.gm ? '👑' : esc(a.name.slice(0, 1))}</span>`;
}

function sidebar(active) {
  const s = store.state;
  const counts = {};
  const news = {};
  s.posts.forEach((p) => {
    counts[p.board] = (counts[p.board] || 0) + 1;
    if (isNew(p)) news[p.board] = true;
  });
  const writeBoard = active === 'all' || active === 'notice' ? (s.phase === 'investigation' ? 'investigation' : 'daily') : active;
  const mine = myChars().filter((c) => c.mine);
  return `<aside class="cafe-side">
    <div class="cafe-profile">
      <div class="cafe-emblem">🐻</div>
      <b>${esc(s.title)}</b>
      <span>${s.day}일째 · 멤버 ${s.players.length}명</span>
      <a class="btn pink block" href="#/write/${writeBoard}">✏️ 글쓰기</a>
    </div>
    <ul class="cafe-menu">
      ${Object.entries(BOARDS)
        .map(([k, label]) => {
          const n = k === 'all' ? s.posts.length : counts[k] || 0;
          const nw = k === 'all' ? Object.keys(news).length > 0 : news[k];
          return `<li><a href="#/board/${k}" class="${k === active ? 'active' : ''}">${label}${nw ? ' <i class="new">N</i>' : ''}<small>${n}</small></a></li>`;
        })
        .join('')}
    </ul>
    <div class="cafe-members">
      <h4>접속 중</h4>
      ${s.players
        .map((p) => `<div class="member"><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.nickname)}${p.isGM ? ' <b class="gm-badge">GM</b>' : ''}</div>`)
        .join('')}
    </div>
    ${mine.length ? `<div class="cafe-members"><h4>내 캐릭터</h4>${mine.map((c) => `<a class="member" href="#/handbook/me/${c.id}">${avatar(c, 22)} ${esc(c.name)} <small>🪙${c.coins ?? 0}</small></a>`).join('')}</div>` : `<a class="btn block" href="#/handbook/me">+ 캐릭터 만들기</a>`}
  </aside>`;
}

function renderBoard(el, name, args) {
  let main = '';
  let active = 'all';
  if (name === 'post') {
    const p = store.state.posts.find((x) => x.id === args[0]);
    active = p?.board || 'all';
    main = p ? postView(p) : '<div class="cafe-empty">삭제되었거나 없는 글입니다.</div>';
  } else if (name === 'write' || name === 'edit') {
    const p = name === 'edit' ? store.state.posts.find((x) => x.id === args[0]) : null;
    active = p?.board || args[0] || 'daily';
    main = writeView(p, args[0]);
  } else {
    active = BOARDS[args[0]] ? args[0] : 'all';
    main = listView(active);
  }
  paint(el, `<div class="cafe">${sidebar(active)}<section class="cafe-main">${main}</section></div>`);
  bind(el, name, args);
}

// ---------- 목록 ----------
function listView(board) {
  const s = store.state;
  let posts = s.posts.filter((p) => board === 'all' || p.board === board);
  if (dayFilter) posts = posts.filter((p) => String(p.day) === dayFilter);
  if (query) {
    const q = query.toLowerCase();
    posts = posts.filter((p) => (p.title + ' ' + p.body + ' ' + authorOf(p).name).toLowerCase().includes(q));
  }
  posts = posts.slice().reverse();
  const pinned = s.posts.filter((p) => p.pinned && (p.board === 'notice' || p.board === board || board === 'all')).reverse();
  const pages = Math.max(1, Math.ceil(posts.length / PAGE_SIZE));
  page = Math.min(page, pages);
  const shown = posts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const days = [...new Set(s.posts.map((p) => p.day))].sort((a, b) => a - b);

  const row = (p, pin) => {
    const a = authorOf(p);
    return `<tr class="${pin ? 'pinned' : ''}">
      <td class="no">${pin ? '<span class="pin">공지</span>' : p.no}</td>
      <td class="title"><a href="#/post/${p.id}">${board === 'all' && !pin ? `<span class="tag ${p.board}">${BOARDS[p.board].replace(/^\S+ /, '')}</span>` : ''}${esc(p.title)}</a>
        ${p.comments.length ? `<b class="cmt">[${p.comments.length}]</b>` : ''}${isNew(p) ? ' <i class="new">N</i>' : ''}
        ${p.location ? `<span class="loc">📍${esc(p.location)}</span>` : ''}</td>
      <td class="writer"><span style="color:${a.color}">${esc(a.name)}</span>${p.partnerId ? ` <small class="heart">♥</small> <span style="color:${charById(p.partnerId)?.color || '#999'}">${esc(charById(p.partnerId)?.name || '?')}</span>` : ''}</td>
      <td class="day">${p.day}일째</td>
      <td class="date">${fmtTime(p.ts)}</td></tr>`;
  };
  return `<div class="cafe-head">
      <h2>${BOARDS[board]}</h2><p>${BOARD_DESC[board]}</p>
    </div>
    <div class="cafe-tools">
      <select id="bDay"><option value="">전체 일차</option>${days.map((d) => `<option value="${d}" ${String(d) === dayFilter ? 'selected' : ''}>${d}일째</option>`).join('')}</select>
      <input id="bQuery" placeholder="제목·내용·작성자 검색" value="${esc(query)}">
      <a class="btn pink small" href="#/write/${board === 'all' || board === 'notice' ? (s.phase === 'investigation' ? 'investigation' : 'daily') : board}">글쓰기</a>
    </div>
    <table class="cafe-list">
      <thead><tr><th class="no">번호</th><th>제목</th><th class="writer">작성자</th><th class="day">일차</th><th class="date">작성일</th></tr></thead>
      <tbody>
        ${page === 1 ? pinned.map((p) => row(p, true)).join('') : ''}
        ${shown.map((p) => row(p)).join('') || `<tr><td colspan="5" class="cafe-empty">아직 글이 없습니다. 첫 글을 써 보세요!</td></tr>`}
      </tbody>
    </table>
    <div class="pager">${Array.from({ length: pages }, (_, i) => `<button data-page="${i + 1}" class="${i + 1 === page ? 'active' : ''}">${i + 1}</button>`).join('')}</div>`;
}

// ---------- 글 보기 ----------
function postView(p) {
  markSeen(p);
  const a = authorOf(p);
  const me = store.state.me;
  const canEdit = p.authorId === me.id || me.isGM;
  const sprite = a.c && p.spriteId ? spriteOf(a.c, p.spriteId) : null;
  const top = p.comments.filter((c) => !c.parentId);
  const replies = (id) => p.comments.filter((c) => c.parentId === id);
  return `<div class="post">
    <div class="post-head">
      <a class="post-board" href="#/board/${p.board}">${BOARDS[p.board]} ›</a>
      <h2>${p.pinned ? '<span class="pin">공지</span> ' : ''}${esc(p.title)}</h2>
      <div class="post-author">
        ${authorAvatar(a, 46, p.spriteId)}
        <div><b style="color:${a.color}">${esc(a.name)}</b> ${a.c ? `<small>${esc(a.c.talent)}</small>` : ''}${partnerHTML(p)}
          <div class="meta">${esc(a.sub)} · ${fmtTime(p.ts)} · ${p.day}일째${p.location ? ` · 📍${esc(p.location)}` : ''}${p.editedAt ? ' · 수정됨' : ''}</div></div>
        <div class="post-actions">
          ${canEdit ? `<a class="btn tiny ghost" href="#/edit/${p.id}">수정</a><button class="btn tiny ghost" data-del-post="${p.id}">삭제</button>` : ''}
          ${me.isGM ? `<button class="btn tiny ghost" data-pin="${p.id}">${p.pinned ? '고정 해제' : '상단 고정'}</button>` : ''}
        </div>
      </div>
    </div>
    <div class="post-body">${sprite ? `<img class="post-sprite" src="${esc(sprite.img)}" alt="">` : ''}${mentionHTML(esc(p.body))}</div>
    <div class="comments">
      <h3>댓글 <b>${p.comments.length}</b></h3>
      ${top.map((c) => commentHTML(p, c) + replies(c.id).map((r) => commentHTML(p, r, true)).join('')).join('') || '<p class="hint">첫 댓글을 남겨 보세요.</p>'}
      ${commentForm(p)}
    </div>
    <div class="post-nav"><a class="btn small ghost" href="#/board/${p.board}">목록</a></div>
  </div>`;
}

function commentHTML(p, c, reply = false) {
  const a = authorOf(c);
  const me = store.state.me;
  const canDel = c.authorId === me.id || me.isGM;
  return `<div class="comment ${reply ? 'reply' : ''} ${a.gm ? 'gm' : ''} ${replyTo === c.id ? 'replying' : ''}">
    ${authorAvatar(a, reply ? 34 : 40, c.spriteId)}
    <div class="c-main">
      <div class="c-who"><b style="color:${a.color}">${esc(a.name)}</b>${a.gm ? ' <b class="gm-badge">GM</b>' : a.c ? ` <small>${esc(a.sub)}</small>` : ' <small>OOC</small>'}
        ${p.authorId === c.authorId && p.charId === c.charId ? '<span class="writer-badge">작성자</span>' : ''}</div>
      ${c.body ? `<div class="c-body">${mentionHTML(esc(c.body))}</div>` : ''}
      ${c.grants?.length ? `<div class="grants">${c.grants.map((g) => `<span class="grant ${g.type}">${g.type === 'bullet' ? '⚡' : g.type === 'coin' ? '🪙' : ''} ${esc(g.label)} → ${esc(g.charIds.map((id) => charById(id)?.name || '?').join(', '))}</span>`).join('')}</div>` : ''}
      <div class="c-meta">${fmtTime(c.ts)} <button data-reply="${c.id}">답글쓰기</button>${canDel ? `<button data-del-cmt="${c.id}">삭제</button>` : ''}</div>
    </div>
  </div>`;
}

function commentForm(p) {
  const gm = isGM();
  const chars = myChars();
  const cur = $('#cAs')?.value ?? speakAs() ?? '';
  const c = charById(cur);
  const replyName = replyTo ? authorOf(p.comments.find((x) => x.id === replyTo) || {}).name : null;
  const defaults = p.charId ? [p.charId] : [];
  const grantHTML = !gm
    ? ''
    : `<details class="grant-box" id="grantBox"><summary>🎁 보상 지급 — 언령 / 아이템 / 모노쿠마 메달</summary>
      ${grantRows
        .map((r) => {
          const fields =
            r.type === 'bullet'
              ? `<input id="g-name-${r.key}" placeholder="언령 이름" maxlength="60"><textarea id="g-desc-${r.key}" rows="2" placeholder="언령 설명 (학생수첩에 표시)"></textarea>`
              : r.type === 'item'
                ? `<div class="row"><input id="g-icon-${r.key}" class="icon-input" value="🎁" maxlength="8"><input id="g-name-${r.key}" placeholder="아이템 이름" maxlength="60"></div><input id="g-desc-${r.key}" placeholder="아이템 설명">`
                : `<input id="g-amount-${r.key}" type="number" value="3" placeholder="메달 수 (음수면 차감)">`;
          return `<div class="grant-row ${r.type}">
            <div class="grant-type">${{ bullet: '⚡ 언령', item: '🎒 아이템', coin: '🪙 메달' }[r.type]}<button type="button" data-rm-grant="${r.key}">✕</button></div>
            ${fields}
            <div class="grant-to">받는 캐릭터: ${students().concat(store.state.characters.filter((x) => x.npc)).map((x) => `<label><input type="checkbox" id="g-to-${r.key}-${x.id}" ${defaults.includes(x.id) ? 'checked' : ''}>${esc(x.name)}</label>`).join('')}</div>
          </div>`;
        })
        .join('')}
      <div class="row"><button type="button" class="btn tiny" data-add-grant="bullet">+ 언령</button><button type="button" class="btn tiny" data-add-grant="item">+ 아이템</button><button type="button" class="btn tiny" data-add-grant="coin">+ 메달</button></div>
    </details>`;
  return `<form class="comment-form" id="cForm">
    ${replyTo ? `<div class="replying-to">↳ <b>${esc(replyName)}</b> 님에게 답글 <button type="button" id="cancelReply">취소</button></div>` : ''}
    <div class="row">
      ${charSelectHTML('cAs', cur, { none: gm ? 'GM (진행)' : `${store.state.me.nickname} (OOC)`, chars })}
      ${c?.sprites?.length ? `<select id="cSprite">${c.sprites.map((s) => `<option value="${s.id}" ${s.id === lastSprite(c.id) ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>` : ''}
    </div>
    <textarea id="cBody" rows="3" placeholder="${gm ? '조사 결과나 진행 내용을 댓글로 남겨 주세요.' : '댓글을 남겨 보세요. @캐릭터이름 으로 부르면 그 플레이어에게 알림이 가요. (Ctrl+Enter 등록)'}"></textarea>
    ${grantHTML}
    <div class="row end"><button class="btn pink small">등록</button></div>
  </form>`;
}

function partnerHTML(p) {
  const pc = charById(p.partnerId);
  if (!pc) return '';
  const aff = store.state.affinity[[p.charId, p.partnerId].sort().join('|')];
  return ` <span class="ft-with">♥ 함께한 상대 ${avatar(pc, 22)} <b style="color:${pc.color}">${esc(pc.name)}</b>${aff ? ` · ${hearts(aff.level)}` : ''}</span>`;
}

export function hearts(level) {
  const max = store.state.freeTime.maxLevel;
  return `<span class="hearts" title="친밀도 Lv.${level}/${max}">${'◆'.repeat(level)}<i>${'◇'.repeat(Math.max(0, max - level))}</i></span>`;
}

// ---------- 글쓰기 ----------
function writeView(p, boardArg) {
  const s = store.state;
  const gm = isGM();
  const board = p?.board || $('#wBoard')?.value || (BOARDS[boardArg] && boardArg !== 'all' ? boardArg : 'daily');
  const boards = Object.entries(BOARDS).filter(([k]) => k !== 'all' && (k !== 'notice' || gm));
  const ft = board === 'freetime' && !p;
  const pre = boardArg === 'freetime' ? ctx.args : [];
  let charId = $('#wAs')?.value ?? pre[1] ?? p?.charId ?? speakAs() ?? '';
  const ftChars = myChars().filter((x) => x.alive && (x.mine || gm));
  if (ft && !ftChars.some((x) => x.id === charId)) charId = ftChars[0]?.id || '';
  const c = charById(charId);
  const spriteSel = $('#wSprite')?.value ?? p?.spriteId ?? (c ? lastSprite(c.id) : '');
  return `<div class="cafe-head"><h2>${p ? '글 수정' : '카페 글쓰기'}</h2></div>
  <form class="write" id="wForm">
    <div class="row">
      <select id="wBoard" ${p ? 'disabled' : ''}>${boards.map(([k, l]) => `<option value="${k}" ${k === board ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="wLoc"><option value="">장소 선택 (선택)</option>${s.locations
        .map((l) => {
          const locked = !gm && s.timeOfDay === 'night' && s.nightClosed.includes(l);
          return `<option value="${esc(l)}" ${l === p?.location ? 'selected' : ''} ${locked ? 'disabled' : ''}>${esc(l)}${locked ? ' 🔒 야간 출입 금지' : ''}</option>`;
        })
        .join('')}</select>
    </div>
    ${p ? '' : `<div class="row">
      <label class="lbl">작성 캐릭터</label>${ft ? charSelectHTML('wAs', charId, { chars: ftChars }) : charSelectHTML('wAs', charId, { none: gm ? 'GM / 모노쿠마 이름 없이' : `${s.me.nickname} (OOC)` })}
      ${c?.sprites?.length ? `<label class="lbl">표정</label><select id="wSprite"><option value="">(없음)</option>${c.sprites.map((x) => `<option value="${x.id}" ${x.id === spriteSel ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>` : ''}
    </div>`}
    ${ft ? freeTimeFields(charId, pre[2]) : ''}
    <input id="wTitle" maxlength="100" placeholder="${ft ? '제목 (비우면 「A 와(과) B 의 자유시간」)' : '제목을 입력해 주세요.'}" value="${esc(p?.title || '')}">
    <textarea id="wBody" rows="16" placeholder="${board === 'investigation' ? '어디를 어떻게 조사하는지 적어 주세요. GM이 댓글로 결과를 알려줍니다.' : ft ? '함께 무엇을 하며 시간을 보냈는지 적어 주세요. 상대 캐릭터의 플레이어가 댓글로 이어서 역극합니다.' : '내용을 입력하세요.'}">${esc(p?.body || '')}</textarea>
    <div class="row end"><a class="btn ghost small" href="${p ? `#/post/${p.id}` : `#/board/${board}`}">취소</a><button class="btn pink">${p ? '수정' : ft ? '💞 자유시간 보내기 (티켓 1장)' : '등록'}</button></div>
  </form>`;
}

function freeTimeFields(charId, partnerPre) {
  const c = charById(charId);
  const others = store.state.characters.filter((x) => x.id !== charId && x.alive && !x.npc);
  const sel = $('#wPartner')?.value ?? partnerPre ?? '';
  const aff = (id) => store.state.affinity[[charId, id].sort().join('|')];
  return `<div class="ft-box">
    <div class="row wrap"><b>💞 자유시간</b><span>남은 티켓 <b class="tickets">${c?.tickets ?? 0}</b>장 (하루 ${store.state.freeTime.ticketsPerDay}장, 다음 날 충전)</span></div>
    <div class="row wrap"><label class="lbl">함께할 상대</label><select id="wPartner"><option value="">선택…</option>${others
      .map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)} (Lv.${aff(x.id)?.level ?? 0})</option>`)
      .join('')}</select></div>
    <p class="hint">자유시간을 보내면 두 사람의 친밀도가 +${store.state.freeTime.eventPoints} 올라갑니다. 선물은 학생수첩 → 소지품에서 줄 수 있어요.</p>
  </div>`;
}

// ---------- 이벤트 ----------
function bind(el, name, args) {
  $$('[data-page]', el).forEach((b) => (b.onclick = () => ((page = +b.dataset.page), refresh())));
  const day = $('#bDay', el);
  if (day) day.onchange = () => ((dayFilter = day.value), (page = 1), refresh());
  const q = $('#bQuery', el);
  if (q)
    q.onkeydown = (e) => {
      if (e.key === 'Enter') {
        query = q.value.trim();
        page = 1;
        refresh();
      }
    };

  // 글쓰기
  const wf = $('#wForm', el);
  if (wf) {
    const as = $('#wAs', el);
    if (as) as.onchange = () => (speakAs(as.value || null), refresh());
    const sp = $('#wSprite', el);
    if (sp) sp.onchange = () => lastSprite($('#wAs').value, sp.value);
    const wb = $('#wBoard', el);
    if (wb) wb.onchange = () => refresh();
    wf.onsubmit = async (e) => {
      e.preventDefault();
      const data = { title: $('#wTitle').value, body: $('#wBody').value, location: $('#wLoc').value };
      if (name === 'edit') {
        if (await emit('post:edit', { id: args[0], ...data })) location.hash = `#/post/${args[0]}`;
      } else if ($('#wBoard').value === 'freetime') {
        if (!$('#wPartner').value) return toast('함께할 상대를 고르세요.', 'error');
        const res = await emit('freetime:start', { ...data, charId: $('#wAs').value, partnerId: $('#wPartner').value, spriteId: $('#wSprite')?.value || null });
        if (res?.id) location.hash = `#/post/${res.id}`;
      } else {
        const res = await emit('post:create', { ...data, board: $('#wBoard').value, charId: $('#wAs')?.value || null, spriteId: $('#wSprite')?.value || null });
        if (res?.id) location.hash = `#/post/${res.id}`;
      }
    };
  }

  // 글 보기
  if (name !== 'post') return;
  const postId = args[0];
  $$('[data-del-post]', el).forEach(
    (b) => (b.onclick = async () => confirm('이 글을 삭제할까요?') && (await emit('post:delete', { id: postId })) && (location.hash = '#/board/all'))
  );
  $$('[data-pin]', el).forEach((b) => (b.onclick = () => emit('post:pin', { id: postId })));
  $$('[data-reply]', el).forEach(
    (b) =>
      (b.onclick = () => {
        replyTo = b.dataset.reply;
        refresh();
        $('#cBody')?.focus();
      })
  );
  $$('[data-del-cmt]', el).forEach(
    (b) => (b.onclick = () => confirm('댓글을 삭제할까요?') && emit('comment:delete', { postId, id: b.dataset.delCmt }))
  );
  const cancel = $('#cancelReply', el);
  if (cancel) cancel.onclick = () => ((replyTo = null), refresh());
  $$('[data-add-grant]', el).forEach(
    (b) =>
      (b.onclick = () => {
        grantRows.push({ key: Math.random().toString(36).slice(2, 8), type: b.dataset.addGrant });
        refresh();
        $('#grantBox').open = true;
      })
  );
  $$('[data-rm-grant]', el).forEach((b) => (b.onclick = () => ((grantRows = grantRows.filter((r) => r.key !== b.dataset.rmGrant)), refresh())));

  const as = $('#cAs', el);
  if (as) as.onchange = () => (as.value && speakAs(as.value), refresh());
  const sp = $('#cSprite', el);
  if (sp) sp.onchange = () => lastSprite($('#cAs').value, sp.value);
  const body = $('#cBody', el);
  if (body) body.onkeydown = (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && $('#cForm').requestSubmit();
  const cf = $('#cForm', el);
  if (cf)
    cf.onsubmit = async (e) => {
      e.preventDefault();
      const grants = grantRows.map((r) => ({
        type: r.type,
        name: $(`#g-name-${r.key}`)?.value,
        desc: $(`#g-desc-${r.key}`)?.value,
        icon: $(`#g-icon-${r.key}`)?.value,
        amount: $(`#g-amount-${r.key}`)?.value,
        charIds: $$(`[id^="g-to-${r.key}-"]`).filter((x) => x.checked).map((x) => x.id.slice(`g-to-${r.key}-`.length)),
      }));
      if (grants.some((g) => !g.charIds.length)) return toast('보상을 받을 캐릭터를 선택하세요.', 'error');
      const res = await emit('comment:create', {
        postId, parentId: replyTo, charId: $('#cAs').value || null, spriteId: $('#cSprite')?.value || null,
        body: $('#cBody').value, grants,
      });
      if (!res) return;
      $('#cBody').value = '';
      replyTo = null;
      grantRows = [];
      refresh();
    };
}
