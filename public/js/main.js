// 진입점: 로비, 로그인 유지, 라우팅, 상단바, 연출
import { $, $$, esc, socket, store, emit, local, toast, PHASES, unseenPings, onChange } from './core.js';
import * as board from './board.js';
import * as trial from './trial.js';
import * as handbook from './handbook.js';
import { unreadCount } from './handbook.js';
import * as shop from './shop.js';
import * as gm from './gm.js';
import { playClimax, playExecution } from './cinema.js';
import { refreshAudio, setBGM, se, SPLASH_SE, soundButton, bindSoundButton } from './audio.js';

const views = { board, trial, handbook, shop, gm };

// ---------- 로비 ----------
let lobbyMode = 'join';
const params = new URLSearchParams(location.search);
$('#lCode').value = params.get('room') || local.get('dgr_last', '') || '';
$('#lNick').value = local.get('dgr_nick', '');

$$('.lobby-tabs button').forEach(
  (b) =>
    (b.onclick = () => {
      lobbyMode = b.dataset.mode;
      $$('.lobby-tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $$('.mode-join').forEach((x) => x.classList.toggle('hidden', lobbyMode !== 'join'));
      $$('.mode-create').forEach((x) => x.classList.toggle('hidden', lobbyMode !== 'create'));
      $('#lSubmit').textContent = lobbyMode === 'join' ? '입장' : '방 만들기';
    })
);

$('#lobbyForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#lError').textContent = '';
  const nickname = $('#lNick').value.trim();
  const password = $('#lPass').value;
  local.set('dgr_nick', nickname);
  const res =
    lobbyMode === 'join'
      ? await emit('room:join', { code: $('#lCode').value, nickname, password })
      : await emit('room:create', { title: $('#lTitle').value, nickname, password });
  if (res) entered(res);
};

function entered({ code, session }) {
  local.set(`dgr_session_${code}`, session);
  local.set('dgr_last', code);
  history.replaceState(null, '', `?room=${code}${location.hash || '#/board/all'}`);
  $('#lobby').classList.add('hidden');
  $('#app').classList.remove('hidden');
  route();
}

function showLobby() {
  setBGM('lobby');
  $('#app').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
}

// 접속/재접속 시 저장된 세션으로 자동 로그인
socket.on('connect', () => {
  const code = params.get('room') || local.get('dgr_last');
  const session = code && local.get(`dgr_session_${code}`);
  if (!session) return showLobby();
  socket.emit('room:resume', { code, session }, (res) => {
    if (res?.error) {
      local.del(`dgr_session_${code}`);
      showLobby();
    } else entered(res);
  });
});

$('#logoutBtn').onclick = () => {
  const code = store.state?.code;
  socket.emit('room:logout', { session: local.get(`dgr_session_${code}`) });
  local.del(`dgr_session_${code}`);
  store.state = null;
  location.href = location.pathname + `?room=${code}`;
};

$('#tCode').onclick = (e) => {
  e.preventDefault();
  const url = `${location.origin}${location.pathname}?room=${store.state.code}`;
  navigator.clipboard?.writeText(url);
  toast('초대 링크를 복사했습니다: ' + url);
};

// ---------- 라우팅 ----------
// #/board/all, #/post/ID, #/write/BOARD, #/edit/ID, #/trial, #/handbook/TAB, #/shop, #/gm
let current = { name: null, args: [], key: '' };
function parseHash() {
  const [name = 'board', ...args] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const map = { post: 'board', write: 'board', edit: 'board', board: 'board' };
  return { view: map[name] || name, name, args };
}

function route() {
  if (!store.state) return;
  const { view, name, args } = parseHash();
  const v = views[view] || board;
  const key = location.hash;
  const el = $('#view');
  if (key !== current.key) {
    if (current.view && current.view !== v) current.view.unmount?.(el);
    el.innerHTML = '';
    el.className = 'view-' + (views[view] ? view : 'board');
    current = { view: v, name, args, key };
    v.mount?.(el, name, args);
    window.scrollTo(0, 0);
  }
  $$('.mainnav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (views[view] ? view : 'board')));
  v.render(el, name, args, 'route');
  updateBGM();
}

// 지금 화면과 진행 상황에 맞는 BGM
function updateBGM() {
  const s = store.state;
  if (!s) return setBGM('lobby');
  const inTrial = location.hash.startsWith('#/trial');
  if (s.phase === 'execution') return setBGM('execution');
  if (inTrial || s.phase === 'trial') {
    if (s.trial.showdown) return setBGM('debate');
    if (s.trial.climax && !s.trial.climax.solved) return setBGM('climax');
    return setBGM('trial');
  }
  setBGM(s.phase === 'investigation' ? 'investigation' : 'daily');
}
window.addEventListener('hashchange', route);

function rerender(what, payload) {
  if (!current.view || !store.state) return;
  current.view.render($('#view'), current.name, current.args, what, payload);
}

// ---------- 서버 이벤트 ----------
let lastPhase = null;
socket.on('state', (s) => {
  const first = !store.state;
  store.state = s;
  renderTop();
  updateBGM();
  if (first) route();
  else rerender('state');
  // 파트가 바뀌면 해당 화면으로 이동
  if (lastPhase && s.phase !== lastPhase && !location.hash.startsWith('#/gm')) {
    if (s.phase === 'trial' || s.phase === 'execution') location.hash = '#/trial';
    else location.hash = `#/board/${s.phase}`;
  }
  lastPhase = s.phase;
});

socket.on('trial:log', (msgs) => {
  store.trial = msgs;
  rerender('trial:log');
});
socket.on('trial:msg', (m) => {
  store.trial.push(m);
  rerender('trial:msg', m);
});
socket.on('trial:update', (m) => {
  const i = store.trial.findIndex((x) => x.id === m.id);
  if (i >= 0) store.trial[i] = m;
  rerender('trial:update', m);
});
socket.on('notice', (n) => {
  if (n.kind === 'mail') se('mail');
  if (n.kind !== 'phase') toast(n.text, n.kind || 'info', n.link);
  if (n.toPlayers) renderTop();
});
socket.on('splash', showSplash);
socket.on('audio:changed', async () => {
  await refreshAudio();
  rerender('state');
});
refreshAudio().then(() => rerender('state')); // 슬롯 목록이 도착하면 GM 사운드 화면을 다시 그린다
socket.on('climax:play', playClimax);
socket.on('execution:play', playExecution);

onChange((what) => what === 'top' && store.state && renderTop());

function renderTop() {
  const s = store.state;
  $('#tTitle').textContent = s.title;
  $('#tCode').textContent = s.code;
  $('#tDay').textContent = `${s.day}일째 ${{ morning: '☀️', day: '🌤', night: '🌙' }[s.timeOfDay] || ''}`;
  $('#tDay').title = { morning: '아침', day: '낮', night: '야간' }[s.timeOfDay] || '';
  const pb = $('#tPhase');
  pb.textContent = PHASES[s.phase];
  pb.className = 'phase-badge ' + s.phase;
  if (!$('#soundBtn')) {
    $('#tSound').innerHTML = soundButton();
    bindSoundButton();
  }
  $('#tUser').innerHTML = `${esc(s.me.nickname)}${s.me.isGM ? ' <b class="gm-badge">GM</b>' : ''}`;
  $$('.gm-only').forEach((el) => el.classList.toggle('hidden', !s.me.isGM));
  const n = unreadCount() + unseenPings();
  $('[data-nav=handbook]').innerHTML = `📱 학생수첩${n ? ` <i class="nav-badge">${n}</i>` : ''}`;
  document.title = `${s.title} — ${PHASES[s.phase]}`;
  document.body.dataset.phase = s.phase;
}

// ---------- 연출 ----------
let splashTimer = null;
function showSplash({ kind, name, color, skill, text, level, max }) {
  const n = name ? `<small>${esc(name)}</small>` : '';
  const words = {
    refute: `${n}그건 틀렸어!`,
    agree: `${n}동의한다!`,
    break: 'BREAK!!',
    miss: '<small>튕겨났다…</small>',
    body: '시체가<br>발견되었습니다!',
    daily: '<small>DAILY LIFE</small>일상 파트',
    investigation: '<small>DEADLY LIFE</small>수사 개시',
    trial: '<small>CLASS TRIAL</small>학급재판 개정!',
    execution: '<small>PUNISHMENT TIME</small>오시오키 타임',
    vote: '<small>VOTE</small>투표 타임!',
    result: '<small>VOTE RESULT</small>투표 결과',
    correct: '<small>CLASS TRIAL</small>정답!!',
    climax: '<small>CLIMAX INFERENCE</small>클라이맥스 추리',
    showdown: `<small>${esc(name)}</small>반론하겠어!`,
    cut: `${n}그 말, 베어 주겠어!`,
    still: `${n}아직이야!`,
    wrong: '<small>CLASS TRIAL</small>오답…',
    skill: `${n}〈${esc(skill)}〉<small>SKILL</small>`,
    announce: `<small>📺 모노쿠마 방송</small><span class="announce-text">${esc(text)}</span>`,
    fragment: `<small>${esc(name)}</small>희망의 조각<small>친밀도 Lv.${esc(level)} / ${esc(max)}</small>`,
  };
  if (!words[kind]) return;
  se(SPLASH_SE[kind]);
  const el = $('#splash');
  el.className = 'splash ' + kind;
  el.innerHTML = `<div class="word" ${color ? `style="--sc:${esc(color)}"` : ''}>${words[kind]}</div>`;
  clearTimeout(splashTimer);
  const ms = { break: 1300, miss: 1100, announce: 3200, fragment: 2400 }[kind] || 1800;
  splashTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
$('#splash').onclick = () => $('#splash').classList.add('hidden');
