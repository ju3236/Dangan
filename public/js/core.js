// 공용: 소켓, 상태, DOM/렌더링 도우미
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const socket = io();

// 상태 저장소: 서버 상태(state) + 재판 로그(trial) + 화면용 로컬 값
export const store = {
  state: null,
  trial: [],
  listeners: new Set(),
};
export const onChange = (fn) => store.listeners.add(fn);
export const notify = (what) => store.listeners.forEach((fn) => fn(what));

// 응답을 기다리는 emit. 오류면 토스트를 띄우고 null 반환
export function emit(ev, data = {}) {
  return new Promise((resolve) => {
    socket.emit(ev, data, (res) => {
      if (res?.error) {
        toast(res.error, 'error');
        resolve(null);
      } else resolve(res || {});
    });
  });
}

export const local = {
  get(k, def = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

// ---------- 상태 조회 ----------
export const S = () => store.state;
export const isGM = () => !!store.state?.me?.isGM;
export const charById = (id) => store.state?.characters.find((c) => c.id === id);
// 내가 조종하는 캐릭터: 내 캐릭터 + (GM이면) NPC. GM이 여러 명이라 다른 사람의 캐릭터는 넣지 않는다
export const myChars = () => (store.state?.characters || []).filter((c) => c.mine || (isGM() && c.npc));
export const ownedChars = () => (store.state?.characters || []).filter((c) => c.mine);
export const students = () => (store.state?.characters || []).filter((c) => !c.npc);
export const evidenceById = (id) => store.state?.evidence.find((e) => e.id === id);
export const playerById = (id) => store.state?.players.find((p) => p.id === id);

// 현재 말하는 캐릭터 (방마다 기억)
export function speakAs(value) {
  const key = `dgr_speak_${store.state?.code}`;
  if (value !== undefined) local.set(key, value);
  const id = local.get(key, null);
  const chars = myChars();
  if (id && chars.some((c) => c.id === id)) return id;
  return ownedChars()[0]?.id || chars[0]?.id || null;
}
export function lastSprite(charId, value) {
  const key = `dgr_sprite_${charId}`;
  if (value !== undefined) local.set(key, value);
  return local.get(key, null);
}

export const PHASES = { daily: '일상 파트', investigation: '조사 파트', trial: '학급재판', execution: '처형' };

// ---------- 표시 도우미 ----------
export function spriteOf(c, spriteId) {
  if (!c?.sprites?.length) return null;
  return c.sprites.find((s) => s.id === spriteId) || c.sprites[0];
}

export function avatar(c, size = 44, spriteId = null, cls = '') {
  const s = spriteOf(c, spriteId);
  const style = `--c:${c?.color || '#777'};width:${size}px;height:${size}px`;
  const dead = c && !c.alive ? ' dead' : '';
  if (s) return `<img class="avatar${dead} ${cls}" style="${style}" src="${esc(s.img)}" alt="" loading="lazy">`;
  return `<span class="avatar${dead} ${cls}" style="${style};font-size:${Math.round(size * 0.45)}px">${esc((c?.name || '?').slice(0, 1))}</span>`;
}

export function charSelectHTML(id, selected, { none = null, chars = myChars(), cls = '' } = {}) {
  return `<select id="${id}" class="${cls}">${none !== null ? `<option value="">${esc(none)}</option>` : ''}${chars
    .map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}${c.npc ? ' (NPC)' : ''}${c.alive ? '' : ' ✝'}</option>`)
    .join('')}</select>`;
}

export function fmtTime(ts, withDate = true) {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (!withDate || d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}. ${hm}`;
}

// 텍스트 속 언령 이름 → 누르면 설명이 뜨는 span (내가 볼 수 있는 언령만)
export function clueHTML(text) {
  const list = (store.state?.evidence || []).filter((e) => e.name.length >= 2).sort((a, b) => b.name.length - a.name.length);
  const html = esc(text);
  if (!list.length) return html;
  const byName = new Map(list.map((e) => [esc(e.name), e.id]));
  const re = new RegExp([...byName.keys()].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return html.replace(re, (m) => `<span class="clue" data-ev="${byName.get(m)}" title="언령 설명 보기">${m}</span>`);
}

// {약점} → 클릭 가능한 약점 span. clues면 약점 밖의 언령 이름도 강조
export function weakHTML(text, msgId, clickable = true, clues = false) {
  return String(text ?? '')
    .split(/(\{[^{}]+\})/)
    .map((part) => {
      const m = /^\{([^{}]+)\}$/.exec(part);
      if (m) return `<span class="weak" ${clickable ? `data-weak="${msgId}"` : ''}>${esc(m[1])}</span>`;
      return clues ? clueHTML(part) : esc(part);
    })
    .join('');
}

// 다시 그려도 입력 중인 값·포커스·스크롤·펼침 상태를 유지한다
export function render(el, html) {
  const saved = {};
  $$('input[id], textarea[id], select[id]', el).forEach((f) => {
    if (f.type === 'file') return;
    saved[f.id] = f.type === 'checkbox' || f.type === 'radio' ? { checked: f.checked } : { value: f.value };
  });
  const openDetails = $$('details[id]', el).filter((d) => d.open).map((d) => d.id);
  const active = document.activeElement;
  const focusId = active && el.contains(active) ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const scrolls = $$('[data-keep-scroll]', el).map((s) => [s.dataset.keepScroll, s.scrollTop]);
  el.innerHTML = html;
  for (const [id, v] of Object.entries(saved)) {
    const f = el.querySelector('#' + CSS.escape(id));
    if (!f || f.dataset.fresh !== undefined) continue;
    if ('checked' in v) f.checked = v.checked;
    else if (f.tagName === 'SELECT') {
      if ([...f.options].some((o) => o.value === v.value)) f.value = v.value;
    } else f.value = v.value;
  }
  openDetails.forEach((id) => {
    const d = el.querySelector('#' + CSS.escape(id));
    if (d) d.open = true;
  });
  scrolls.forEach(([k, top]) => {
    const s = el.querySelector(`[data-keep-scroll="${k}"]`);
    if (s) s.scrollTop = top;
  });
  if (focusId) {
    const f = el.querySelector('#' + CSS.escape(focusId));
    if (f) {
      f.focus();
      if (sel) try { f.setSelectionRange(...sel); } catch {}
    }
  }
}

// ---------- 토스트 / 모달 ----------
export function toast(text, kind = 'info', link = null) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind + (link ? ' link' : '');
  el.textContent = text;
  if (link) el.onclick = () => (location.hash = link);
  box.appendChild(el);
  const ms = link ? 6500 : 3500;
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 500);
}

// '@캐릭터이름'을 강조 (이미 이스케이프된 HTML에 적용)
export function mentionHTML(html) {
  const names = (store.state?.characters || []).map((c) => c.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return html;
  const re = new RegExp('@(' + names.map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
  return html.replace(re, '<b class="mention">@$1</b>');
}

// 아직 안 본 '나에게 온 알림' (댓글·답글·멘션) 수
export function unseenPings() {
  const seen = local.get(`dgr_seen_ping_${store.state?.code}`, 0);
  return (store.state?.notices || []).filter((n) => n.toPlayers && n.ts > seen).length;
}
export function markPingsSeen() {
  local.set(`dgr_seen_ping_${store.state?.code}`, Date.now());
}

export function modal(html, { wide = false, onClose } = {}) {
  const d = document.createElement('dialog');
  d.className = 'modal' + (wide ? ' wide' : '');
  d.innerHTML = `<button class="modal-x" type="button" aria-label="닫기">✕</button>${html}`;
  document.body.appendChild(d);
  d.querySelector('.modal-x').onclick = () => d.close();
  d.addEventListener('close', () => {
    onClose?.();
    d.remove();
  });
  d.showModal();
  return d;
}

export function confirmBox(text) {
  return Promise.resolve(window.confirm(text));
}

// ---------- 이미지 ----------
export function resizeImage(file, maxW, maxH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width, maxH / img.height);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(cv.toDataURL('image/webp', 0.9));
    };
    img.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    img.src = URL.createObjectURL(file);
  });
}

export async function uploadImage(file, maxW = 900, maxH = 900) {
  try {
    const dataUrl = await resizeImage(file, maxW, maxH);
    const res = await emit('image:upload', { dataUrl });
    return res?.url || null;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

export function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name.replace(/[\\/:*?"<>|]/g, '_'); // 윈도우에서 못 쓰는 글자 정리
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
