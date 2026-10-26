// 사운드: 상황에 맞는 BGM과 연출 효과음. 음원은 GM이 직접 넣는다 (/audio/list)
import { $, esc, local, store, toast } from './core.js';

let slots = []; // [{ id, kind, label, version }]
let settings = { bgm: 0.45, se: 0.8, mute: false, ...local.get('dgr_volume', {}) };
let bgm = null; // { slot, el }
let wanted = null; // 지금 나와야 할 BGM
let override = null; // 연출 중 강제 BGM
let unlocked = false;

export const audioSlots = () => slots;
const has = (id) => slots.find((s) => s.id === id)?.version;
const url = (id) => `/audio/file/${id}?v=${has(id)}`;

export async function refreshAudio() {
  try {
    slots = await (await fetch('/audio/list')).json();
  } catch {
    slots = [];
  }
  // 음원이 바뀌었으면 BGM 다시 시작
  if (bgm && bgm.version !== has(bgm.slot)) stopBGM(true);
  apply();
}

// 브라우저는 사용자가 한 번 클릭해야 소리를 낼 수 있다
document.addEventListener(
  'pointerdown',
  () => {
    if (unlocked) return;
    unlocked = true;
    apply();
  },
  { capture: true }
);

function fade(el, to, ms, done) {
  const from = el.volume;
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
    if (k < 1) requestAnimationFrame(tick);
    else done?.();
  };
  requestAnimationFrame(tick);
}

function stopBGM(now = false) {
  if (!bgm) return;
  const el = bgm.el;
  bgm = null;
  if (now) return el.pause();
  fade(el, 0, 700, () => el.pause());
}

function apply() {
  const slot = override || wanted;
  const vol = settings.mute ? 0 : settings.bgm;
  if (bgm && bgm.slot === slot) {
    bgm.el.volume = vol;
    if (bgm.el.paused && unlocked) bgm.el.play().catch(() => {});
    return;
  }
  stopBGM();
  if (!slot || !has(slot)) return;
  const el = new Audio(url(slot));
  el.loop = true;
  el.volume = 0;
  bgm = { slot, el, version: has(slot) };
  if (unlocked) el.play().then(() => fade(el, vol, 900)).catch(() => {});
}

export function setBGM(slot) {
  wanted = slot;
  apply();
}

export function overrideBGM(slot) {
  override = slot;
  apply();
}

export function se(id) {
  if (settings.mute || !unlocked || !has(id)) return;
  const el = new Audio(url(id));
  el.volume = settings.se;
  el.play().catch(() => {});
}

export function preview(id) {
  if (!has(id)) return;
  unlocked = true;
  const el = new Audio(url(id));
  el.volume = settings.mute ? 0.5 : Math.max(settings.se, settings.bgm);
  el.play().catch(() => {});
  setTimeout(() => el.pause(), 8000);
}

// 상단바의 🔊 버튼: 음량 조절
export function soundButton() {
  return `<button id="soundBtn" class="btn tiny ghost" title="소리 설정">${settings.mute ? '🔇' : '🔊'}</button>`;
}

export function bindSoundButton() {
  const b = $('#soundBtn');
  if (!b) return;
  b.onclick = (e) => {
    e.stopPropagation();
    let pop = $('#soundPop');
    if (pop) return pop.remove();
    pop = document.createElement('div');
    pop.id = 'soundPop';
    pop.className = 'sound-pop';
    const any = slots.some((s) => s.version);
    pop.innerHTML = `<label>BGM<input type="range" min="0" max="1" step="0.05" id="volBgm" value="${settings.bgm}"></label>
      <label>효과음<input type="range" min="0" max="1" step="0.05" id="volSe" value="${settings.se}"></label>
      <label class="chk"><input type="checkbox" id="volMute" ${settings.mute ? 'checked' : ''}> 음소거</label>
      ${any ? '' : '<p class="hint">아직 음원이 없어요. GM 화면 → 사운드에서 넣을 수 있어요.</p>'}`;
    document.body.appendChild(pop);
    const save = () => {
      settings = { bgm: +$('#volBgm').value, se: +$('#volSe').value, mute: $('#volMute').checked };
      local.set('dgr_volume', settings);
      b.textContent = settings.mute ? '🔇' : '🔊';
      apply();
    };
    pop.oninput = save;
    pop.onclick = (ev) => ev.stopPropagation();
    setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }));
  };
}

// GM 화면: 슬롯별 업로드/미리듣기/삭제
export function soundAdminHTML() {
  const row = (s) => `<div class="snd-row ${s.version ? 'on' : ''}"><span class="snd-label">${s.kind === 'bgm' ? '🎵' : '🔔'} ${esc(s.label)}</span>
    <code>${s.id}</code><span class="grow"></span>
    ${s.version ? `<button class="btn tiny ghost" data-snd-play="${s.id}">▶</button><button class="btn tiny ghost" data-snd-del="${s.id}">삭제</button>` : '<small class="hint">없음</small>'}
    <label class="btn tiny">${s.version ? '바꾸기' : '넣기'}<input type="file" accept="audio/*" data-snd-up="${s.id}" hidden></label></div>`;
  return `<p class="hint">가지고 있는 음원 파일을 넣어 주세요. 파일은 이 컴퓨터의 <code>data/audio</code> 폴더에 저장되고, git과 방 백업에는 포함되지 않습니다.
    폴더에 직접 <code>trial.mp3</code>처럼 슬롯 이름으로 넣어도 돼요.</p>
    <h3>BGM</h3>${slots.filter((s) => s.kind === 'bgm').map(row).join('')}
    <h3>효과음</h3>${slots.filter((s) => s.kind === 'se').map(row).join('')}`;
}

export function bindSoundAdmin(el) {
  const auth = () => ({ 'x-room': store.state.code, 'x-session': local.get(`dgr_session_${store.state.code}`) });
  el.querySelectorAll('[data-snd-play]').forEach((b) => (b.onclick = () => preview(b.dataset.sndPlay)));
  el.querySelectorAll('[data-snd-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('이 음원을 지울까요?')) return;
      await fetch(`/audio/file/${b.dataset.sndDel}`, { method: 'DELETE', headers: auth() });
    };
  });
  el.querySelectorAll('[data-snd-up]').forEach((inp) => {
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      toast(`올리는 중… ${f.name}`);
      const res = await fetch(`/audio/file/${inp.dataset.sndUp}`, { method: 'POST', headers: { ...auth(), 'content-type': f.type || 'audio/mpeg' }, body: f });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) toast(r.error || '올리지 못했습니다.', 'error');
      else toast('음원을 넣었습니다.');
      inp.value = '';
    };
  });
}

// 연출 종류 → 효과음
export const SPLASH_SE = {
  refute: 'refute', agree: 'agree', break: 'break', miss: 'miss', body: 'body', announce: 'announce', vote: 'vote',
  correct: 'correct', wrong: 'wrong', showdown: 'showdown', cut: 'cut', still: 'showdown', skill: 'skill', fragment: 'fragment',
  climax: 'announce', trial: 'announce', investigation: 'announce', daily: 'announce', execution: 'gameover',
};
