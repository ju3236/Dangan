// 네이버 카페 글 가져오기: 게시글 화면을 통째로 복사(Ctrl+A → Ctrl+C)한 텍스트를 글 + 댓글로 나눈다
import { $, esc, emit, store, toast, fmtTime } from './core.js';

const NOISE = new Set([
  '인기멤버', '구독', '구독 중', '구독중', '1:1 채팅', '이 멤버의 글을 구독탭에서 볼 수 있습니다.', '매니저', '부매니저', '스탭',
  '이동삭제', '이전글', '다음글', '목록', '작성자', '답글쓰기', '신고', '새로고침', '프로필 사진', '프로필사진',
]);
const POST_DATE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}):(\d{2})\s*조회/;
const CMT_DATE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}):(\d{2})\s*(답글쓰기)?$/;
const toTs = (m) => new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
const NOTICE_BOARDS = ['공지사항', '교내 방송', '입학생 명단', '모노치라 파일'];
const MONOKUMA = ['모노쿠마', '모노치라', '모노븅', '키보가미네 학원'];
const norm = (n) => String(n || '').replace(/\s+/g, '').toLowerCase();

// 텍스트 → { board, title, author, ts, body, comments: [{ author, ts, text, replyTo }] }
export function parseCafe(raw) {
  const lines = String(raw || '')
    .replace(/\r/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 마크다운 링크로 붙여넣어진 경우
    .split('\n')
    .map((l) => l.replace(/^\s*[*•]\s+/, '').trim())
    .filter(Boolean);
  const di = lines.findIndex((l) => POST_DATE.test(l));
  if (di < 0) return { error: '게시글 작성 시각(「2024.04.24. 02:18조회 17」 같은 줄)을 찾지 못했어요. 게시글 화면 전체를 복사해 주세요.' };
  let hi = -1;
  for (let i = di - 1; i >= 0; i--) if (/목록$/.test(lines[i])) { hi = i; break; }
  // 「구독 중이 멤버의 글을 구독탭에서…」, 「1:1 채팅」, 등급 표시 같은 줄은 붙어서 한 줄로 오기도 한다
  const head = lines.slice(hi + 1, di).filter((l) => !NOISE.has(l) && !/^\d+$/.test(l) && !/구독|1:1 채팅|^인기멤버/.test(l));
  if (head.length < 2) return { error: '게시판 이름·제목·작성자를 찾지 못했어요.' };
  const post = {
    board: head.length >= 3 ? head[0] : '',
    title: head[head.length >= 3 ? 1 : 0],
    author: head[head.length - 1],
    ts: toTs(POST_DATE.exec(lines[di])),
  };

  let i = di + 1;
  const body = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/님의 게시글 더보기$/.test(l) || /^좋아요/.test(l) || l === '댓글') break;
    if (/^댓글\s*\d+\s*URL 복사$/.test(l) || l === 'URL 복사') continue;
    body.push(l);
  }
  post.body = body.join('\n');

  // 댓글 영역: 「댓글알림」(없으면 클린봇 안내) 다음부터 입력칸/페이지 이동 전까지
  let ci = lines.findIndex((l, k) => k >= i && l === '댓글알림');
  if (ci < 0) ci = lines.findIndex((l, k) => k >= i && /^클린봇/.test(l));
  const blocks = [];
  let postAuthor = null;
  if (ci >= 0) {
    let cur = [];
    for (let k = ci + 1; k < lines.length; k++) {
      const l = lines[k];
      if (/^페이징 이동/.test(l) || /^댓글을 입력하세요/.test(l) || l === '등록') break;
      const m = CMT_DATE.exec(l);
      if (m) {
        const ls = cur.filter((x) => !NOISE.has(x));
        // 카페는 글쓴이의 댓글에 「작성자」 표시를 붙인다 → 글쓴이를 확실히 알 수 있다
        if (ls.length && cur.includes('작성자')) postAuthor = ls[0];
        if (ls.length) blocks.push({ author: ls[0], text: ls.slice(1), ts: toTs(m) });
        cur = [];
      } else cur.push(l);
    }
  }
  if (postAuthor) post.author = postAuthor;
  // 답글: 본문이 「상대 이름 + 공백」으로 시작하면 그 사람에게 단 답글
  const names = [...new Set([post.author, ...blocks.map((b) => b.author)])].sort((a, b) => b.length - a.length);
  post.comments = blocks.map((b) => {
    let text = b.text.join('\n');
    let replyTo = null;
    const n = names.find((x) => text.startsWith(x + ' ') || text.startsWith(x + '\n') || text === x);
    if (n) {
      replyTo = n;
      text = text.slice(n.length).trim();
    }
    return { author: b.author, ts: b.ts, text, replyTo };
  });
  return { post };
}

// 카페 닉네임 → 사이트 작성자
function resolver(aliasText) {
  const chars = store.state.characters;
  const byName = new Map(chars.map((c) => [norm(c.name), c]));
  const alias = new Map([['브이', 'v']]);
  String(aliasText || '')
    .split('\n')
    .forEach((l) => {
      const [a, b] = l.split('=').map((x) => x?.trim());
      if (a && b) alias.set(norm(a), norm(b));
    });
  return (name) => {
    const c = byName.get(norm(name)) || byName.get(alias.get(norm(name)));
    if (c) return { charId: c.id, label: c.name };
    if (name === 'SYSTEM') return { gm: true, displayName: 'SYSTEM', label: 'SYSTEM (GM)' };
    if (MONOKUMA.includes(name)) return { monokuma: true, displayName: name, label: `${name} (모노쿠마)` };
    return { displayName: name, label: `${name} (캐릭터 없음)`, unmatched: true };
  };
}

let parsed = null;

export function cafeImportHTML() {
  const s = store.state;
  return `<section class="gm-card wide"><h2>☕ 카페 글 가져오기</h2>
    <p class="hint">네이버 카페 게시글을 열고 <b>Ctrl+A → Ctrl+C</b>로 화면 전체를 복사해 아래에 붙여넣으세요. 글과 댓글이 나뉘어 들어가고, 닉네임이 캐릭터 이름과 같으면 그 캐릭터의 글·댓글이 됩니다.
      댓글이 여러 페이지면 페이지마다 복사해서 다시 가져오면 같은 글에 이어 붙어요(중복은 건너뜀). 알림은 가지 않아요.</p>
    <textarea id="cafeText" rows="6" placeholder="카페 게시글 화면을 통째로 붙여넣기"></textarea>
    <div class="row wrap"><button class="btn small" id="cafeParse">미리 보기</button></div>
    <div id="cafePreview">${previewHTML(s)}</div>
  </section>`;
}

function previewHTML(s) {
  if (!parsed?.post && !parsed?.error) return '';
  if (parsed.error) return `<p class="warn">${esc(parsed.error)}</p>`;
  const p = parsed.post;
  const who = resolver($('#cafeAlias')?.value ?? parsed.alias);
  const names = [...new Set([p.author, ...p.comments.map((c) => c.author)])];
  const unmatched = names.filter((n) => who(n).unmatched);
  const guess = NOTICE_BOARDS.includes(p.board) || MONOKUMA.includes(p.author) ? 'notice' : /말탄환|단서|재판|처형/.test(p.board) ? 'investigation' : 'daily';
  const loc = s.locations.includes(p.board) ? p.board : '';
  return `<div class="cafe-prev stack">
    <div><b>${esc(p.title)}</b> <small>— ${esc(who(p.author).label)} · ${fmtTime(p.ts)} · 카페 게시판 「${esc(p.board || '?')}」 · 댓글 ${p.comments.length}개</small></div>
    <p class="pre hint">${esc(p.body.slice(0, 200))}${p.body.length > 200 ? '…' : ''}</p>
    ${p.comments.length ? `<ul class="hint">${p.comments.slice(0, 3).map((c) => `<li><b>${esc(who(c.author).label)}</b> ${c.replyTo ? `→ ${esc(c.replyTo)} ` : ''}${esc(c.text.slice(0, 60))}</li>`).join('')}${p.comments.length > 3 ? '<li>…</li>' : ''}</ul>` : ''}
    <div class="row wrap">
      <label>게시판<select id="cafeBoard">${[['daily', '일상'], ['investigation', '조사'], ['notice', '공지'], ['free', '자유']].map(([v, t]) => `<option value="${v}" ${v === guess ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>장소<select id="cafeLoc"><option value="">없음</option>${s.locations.map((l) => `<option ${l === loc ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>일차<input type="number" id="cafeDay" class="num" min="1" value="${parsed.day || 1}"></label>
      <label>카페 챕터<input type="number" id="cafeChapter" class="num" min="1" value="${parsed.chapter || Math.max(1, (s.chapterStart || 1) - 1)}" title="로그북에서 「☕ 카페 제N장」으로 묶여요"></label>
    </div>
    ${unmatched.length ? `<p class="warn">캐릭터와 이어지지 않은 이름: ${unmatched.map(esc).join(', ')} — 그 이름 그대로 표시돼요. 캐릭터로 잇고 싶으면 아래에 「카페이름=캐릭터이름」을 한 줄씩 적으세요.</p>` : ''}
    <textarea id="cafeAlias" rows="2" placeholder="예: 브이=V">${esc(parsed.alias || '')}</textarea>
    <div class="row wrap"><button class="btn small" id="cafeRecheck">이름 다시 확인</button><button class="btn small pink" id="cafeImport">가져오기</button></div>
  </div>`;
}

export function bindCafeImport(el) {
  const btn = (id, fn) => {
    const b = $('#' + id, el);
    if (b) b.onclick = fn;
  };
  const redraw = () => ($('#cafePreview', el).innerHTML = previewHTML(store.state), bindCafeImport(el));
  const keep = () => {
    if (!parsed?.post) return;
    parsed.alias = $('#cafeAlias', el)?.value || '';
    parsed.day = $('#cafeDay', el)?.value;
    parsed.chapter = $('#cafeChapter', el)?.value;
  };
  btn('cafeParse', () => {
    const alias = parsed?.alias || '';
    parsed = parseCafe($('#cafeText', el).value);
    if (parsed.post) parsed.alias = alias;
    redraw();
  });
  btn('cafeRecheck', () => (keep(), redraw()));
  btn('cafeImport', async () => {
    keep();
    const p = parsed.post;
    const who = resolver(parsed.alias);
    const strip = ({ label, unmatched, ...rest }) => rest;
    const res = await emit('gm:importCafe', {
      title: p.title,
      body: p.body,
      ts: p.ts,
      board: $('#cafeBoard', el).value,
      location: $('#cafeLoc', el).value,
      day: parsed.day,
      chapter: parsed.chapter,
      author: strip(who(p.author)),
      comments: p.comments.map((c) => {
        const to = c.replyTo && who(c.replyTo);
        return { ...strip(who(c.author)), ts: c.ts, body: to ? `@${to.charId ? to.label : c.replyTo} ${c.text}` : c.text };
      }),
    });
    if (!res) return;
    toast(`${res.created ? '새 글로 가져왔어요' : '기존 글에 이어 붙였어요'} — 댓글 ${res.added}개 추가 (눌러서 보기)`, 'info', `#/post/${res.id}`);
    parsed = { alias: parsed.alias }; // 이름 연결은 다음 글에도 그대로
    $('#cafeText', el).value = '';
    $('#cafePreview', el).innerHTML = '';
  });
}
