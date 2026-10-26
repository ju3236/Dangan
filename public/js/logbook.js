// 로그북: 한 챕터(일상 → 조사 → 재판)를 책처럼 모아 보기 / 내보내기
// 챕터는 재판 로그의 「처형」을 경계로 나눈다 (모두가 볼 수 있는 정보만 사용)
import { $, esc, store, charById, playerById, download, ink } from './core.js';

const BOARD = { notice: '공지', daily: '일상', investigation: '조사', freetime: '자유시간', free: '자유' };

function chapters() {
  const ends = store.trial.filter((m) => m.type === 'phase' && m.phase === 'execution').map((m) => m.ts);
  const first = store.state.chapterStart || 1; // 카페 등에서 앞 챕터를 했다면 그다음 번호부터
  const list = (store.state.lore || []).map((l) => ({ id: 'lore:' + l.id, label: `📚 ${l.title}`, lore: l }));
  // 카페에서 가져온 글은 카페 챕터별로 따로 묶는다
  [...new Set(store.state.posts.map((p) => p.cafeChapter).filter(Boolean))]
    .sort((a, b) => a - b)
    .forEach((n) => list.push({ id: 'cafe:' + n, label: `☕ 카페 제${n}장`, cafe: n, start: 0, end: Infinity }));
  let start = 0;
  ends.forEach((end, i) => {
    list.push({ id: String(i + 1), label: `제${first + i}장`, start, end: end + 15 * 60000 }); // 처형 연출 직후까지
    start = end + 15 * 60000;
  });
  list.push({ id: String(ends.length + 1), label: `제${first + ends.length}장 (진행 중)`, start, end: Infinity });
  return list;
}

const nameOf = (charId, authorId, fallback) => charById(charId)?.name || fallback || playerById(authorId)?.nickname || '?';
const plain = (t) => String(t || '').replace(/[{}]/g, '');

// 범위 안의 글과 재판 로그를 시간순으로
function collect(range, opts) {
  const items = [];
  if (opts.board)
    store.state.posts
      .filter((p) => (range.cafe ? p.cafeChapter === range.cafe : range.all || !p.cafeChapter))
      .filter((p) => p.ts >= range.start && p.ts < range.end && (opts.ooc || p.board !== 'free'))
      .forEach((p) => items.push({ ts: p.ts, kind: 'post', p }));
  if (opts.trial && !range.cafe) {
    let block = null;
    store.trial
      .filter((m) => m.ts >= range.start && m.ts < range.end && (opts.ooc || m.type !== 'ooc'))
      .forEach((m) => {
        // 연달아 이어진 재판 메시지는 한 덩어리로
        if (!block || m.ts - block.last > 3 * 3600000) {
          block = { ts: m.ts, kind: 'trial', msgs: [], last: m.ts };
          items.push(block);
        }
        block.msgs.push(m);
        block.last = m.ts;
      });
  }
  return items.sort((a, b) => a.ts - b.ts);
}

function trialLine(m) {
  const who = esc(nameOf(m.charId, m.authorId, m.author));
  switch (m.type) {
    case 'say': return `<p class="lb-say"><b style="${ink(charById(m.charId)?.color || '#333')}">${who}</b> 「${esc(plain(m.text))}」</p>`;
    case 'point': return `<p class="lb-point">🗯 논점 ${m.index} · ${esc(m.topic)} — “${esc(plain(m.text))}”</p>`;
    case 'showdown': return `<p class="lb-say"><b>⚔ ${who}</b> 「${esc(plain(m.text))}」</p>`;
    case 'shoot': return `<p class="lb-shoot">${who} — ${{ agree: '동의한다!', cut: '그 말, 베어 주겠어!' }[m.kind] || '그건 틀렸어!'} ${esc(plain(m.text))}${m.result === 'break' ? ' <b>BREAK!!</b>' : ''}</p>`;
    case 'narration': return `<p class="lb-narr">${esc(m.text).replace(/\n/g, '<br>')}</p>`;
    case 'announce': return `<p class="lb-mk">📺 모노쿠마: ${esc(m.text).replace(/\n/g, '<br>')}</p>`;
    case 'phase': return `<h4 class="lb-phase">── ${esc(m.text)} ──</h4>`;
    case 'skill': return `<p class="lb-shoot">✨ ${who} 스킬 발동 ${esc(m.text)}</p>`;
    case 'ooc': return `<p class="lb-ooc">(OOC) ${esc(m.author)}: ${esc(m.text)}</p>`;
    default: return `<p class="lb-sys">${esc(m.text)}</p>`;
  }
}

function itemsHTML(items) {
  let day = null;
  return items
    .map((it) => {
      if (it.kind === 'post') {
        const p = it.p;
        const head = p.day !== day ? `<h3 class="lb-day">${(day = p.day)}일째</h3>` : '';
        const partner = charById(p.partnerId);
        return `${head}<article class="lb-post">
          <div class="lb-meta">[${BOARD[p.board] || p.board}]${p.location ? ` 📍${esc(p.location)}` : ''}</div>
          <h4>${esc(p.title)}</h4>
          <div class="lb-author">${esc(nameOf(p.charId, p.authorId, p.displayName || (p.monokuma ? '모노쿠마' : null)))}${partner ? ` ♥ ${esc(partner.name)}` : ''}</div>
          <div class="lb-body">${esc(p.body).replace(/\n/g, '<br>')}</div>
          ${p.comments.map((c) => `<div class="lb-cmt ${c.parentId ? 'reply' : ''}"><b>${esc(nameOf(c.charId, c.authorId, c.displayName || (c.gm ? 'GM' : null)))}</b> ${esc(c.body).replace(/\n/g, '<br>')}${c.grants?.length ? ` <i>(${esc(c.grants.map((g) => g.label).join(', '))})</i>` : ''}</div>`).join('')}
        </article>`;
      }
      return `<section class="lb-trial"><h3 class="lb-day">⚖️ 학급재판</h3>${it.msgs.map(trialLine).join('')}</section>`;
    })
    .join('');
}

const loreHTML = (l) => `<div class="lb-lore">${esc(l.text)}</div>`;

function current() {
  const list = chapters();
  const sel = $('#lbRange')?.value || list[list.length - 1].id;
  const range = sel === 'all' ? { start: 0, end: Infinity, label: '전체', all: true } : list.find((c) => c.id === sel) || list[list.length - 1];
  const opts = { board: $('#lbBoard')?.checked ?? true, trial: $('#lbTrial')?.checked ?? true, ooc: $('#lbOoc')?.checked ?? false };
  return { list, sel, range, opts, items: range.lore ? [] : collect(range, opts) };
}

export function logbookHTML() {
  const { list, sel, range, opts, items } = current();
  return `<div class="hb-section-head"><h2>로그북</h2>
      <div class="row wrap"><button class="btn small" id="lbHtml">📖 HTML로 저장</button><button class="btn small ghost" id="lbTxt">텍스트로 저장</button></div></div>
    <div class="row wrap lb-tools">
      <select id="lbRange">${list.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.label}</option>`).join('')}<option value="all" ${sel === 'all' ? 'selected' : ''}>전체</option></select>
      <label class="chk"><input type="checkbox" id="lbBoard" ${opts.board ? 'checked' : ''}> 게시판</label>
      <label class="chk"><input type="checkbox" id="lbTrial" ${opts.trial ? 'checked' : ''}> 학급재판</label>
      <label class="chk"><input type="checkbox" id="lbOoc" ${opts.ooc ? 'checked' : ''}> OOC 포함</label>
      <span class="hint">챕터는 「처형」을 기준으로 나뉩니다. 비밀 메일은 포함되지 않아요.</span>
    </div>
    <div class="logbook"><h2 class="lb-title">${esc(store.state.title)} — ${esc(range.label)}</h2>${range.lore ? loreHTML(range.lore) : itemsHTML(items) || '<p class="hint">이 범위에는 기록이 없습니다.</p>'}</div>`;
}

const BOOK_CSS = `body{font-family:'Noto Sans KR',sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.8;color:#222;background:#fbf8f2}
h2.lb-title{text-align:center;border-bottom:3px double #222;padding-bottom:12px}.lb-day{margin-top:36px;color:#c21e63;border-left:5px solid #c21e63;padding-left:10px}
.lb-post{margin:18px 0;padding:14px 18px;background:#fff;border:1px solid #e6e1ea}.lb-post h4{margin:2px 0}.lb-meta,.lb-author{font-size:13px;color:#777}
.lb-body{margin:10px 0}.lb-cmt{font-size:14px;border-top:1px dashed #ddd;padding:6px 0}.lb-cmt.reply{padding-left:22px}.lb-cmt i{color:#8a5d00}
.lb-trial{margin:18px 0;padding:14px 18px;background:#fff;border-left:5px solid #222}.lb-trial p{margin:4px 0}.lb-narr{font-style:italic;color:#555;text-align:center}
.lb-mk{background:#111;color:#fff;padding:6px 10px}.lb-shoot{color:#b85a00;font-weight:700}.lb-point{color:#c21e63;font-weight:700}.lb-phase{text-align:center;color:#c21e63}
.lb-ooc,.lb-sys{color:#999;font-size:13px}`;

export function bindLogbook(el, rerender) {
  ['lbRange', 'lbBoard', 'lbTrial', 'lbOoc'].forEach((id) => {
    const f = $('#' + id, el);
    if (f) f.onchange = rerender;
  });
  const { sel, range, items } = current();
  const title = `${store.state.title} — ${range.label}`;
  // 파일 이름은 영문으로 (브라우저에 따라 한글 이름이 'download'로 바뀌는 경우가 있어서)
  const file = `dangan-${store.state.code}-logbook-${sel === 'all' ? 'all' : range.lore ? 'story' : range.cafe ? 'cafe-ch' + range.cafe : 'ch' + sel}`;
  const h = $('#lbHtml', el);
  if (h)
    h.onclick = () =>
      download(`${file}.html`, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${BOOK_CSS}.lb-lore{white-space:pre-wrap}</style></head><body><h2 class="lb-title">${esc(title)}</h2>${range.lore ? loreHTML(range.lore) : itemsHTML(items)}</body></html>`, 'text/html');
  const t = $('#lbTxt', el);
  if (t)
    t.onclick = () => {
      const div = document.createElement('div');
      div.innerHTML = (range.lore ? loreHTML(range.lore) : itemsHTML(items)).replace(/<br>/g, '\n').replace(/<\/(p|div|h3|h4|article|section)>/g, '$&\n');
      download(`${file}.txt`, `${title}\n\n${div.textContent.replace(/\n{3,}/g, '\n\n')}`);
    };
}
