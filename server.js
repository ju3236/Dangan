// 단간론파 역극 사이트 서버
// - 일상/조사: 카페형 게시판 (글 + 댓글, GM이 댓글로 언령·아이템·메달 지급)
// - 학급재판: 실시간 채팅 (표정 스프라이트, 논파, 투표)
// - 학생수첩 / 인벤토리 / 매점 / 스킬
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const caseAI = require('./case-ai');

const PORT = process.env.PORT || 3000;
// Railway에 볼륨을 붙이면 RAILWAY_VOLUME_MOUNT_PATH가 자동으로 들어온다 → 그 안에 저장 (음원·백업도 같은 곳)
const DATA_FILE =
  process.env.DATA_FILE ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'rooms.json') : path.join(__dirname, 'data', 'rooms.json'));
const VERSION = 2;
const MAX_TRIAL_MESSAGES = 3000;
const MAX_NOTICES = 300;
const MAX_IMAGES = 600;
const PHASES = { daily: '일상 파트', investigation: '조사 파트', trial: '학급재판', execution: '처형' };
const BOARDS = ['notice', 'daily', 'investigation', 'freetime', 'free'];
const FREE_TIME_DEFAULTS = { ticketsPerDay: 2, eventPoints: 3, levelPoints: 5, maxLevel: 5, giftPoints: 1, likedPoints: 3, dislikedPoints: -2, bondReward: true };
const TIMES = { morning: '아침', day: '낮', night: '야간' };
const DEFAULT_LOCATIONS = ['교실', '식당', '주방', '체육관', '도서실', '기숙사', '정원', '수영장', '창고', '매점'];
const DEFAULT_RULES = [
  '학생 여러분은 학원 안에서만 공동생활을 해야 합니다. 공동생활의 기한은 없습니다.',
  '밤 10시부터 오전 7시까지를 「야간」으로 합니다. 야간에는 출입 금지 구역이 있으니 주의해 주세요.',
  '취침은 기숙사의 개인실에서만 가능합니다. 다른 곳에서 고의로 잠드는 것은 처벌 대상입니다.',
  '학원장 모노쿠마에 대한 폭력과 감시 카메라 파괴를 금지합니다.',
  '동료를 죽인 「쿠로」는 졸업할 수 있지만, 다른 학생들에게 쿠로라는 사실을 들켜서는 안 됩니다.',
  '교칙은 앞으로 추가될 수 있습니다.',
];
const DEFAULT_ITEMS = [
  ['초코 바', '어디서나 파는 평범한 초코 바. 단 것을 좋아하는 사람에게 선물하자.', '🍫', 2],
  ['고급 홍차 세트', '향이 좋은 홍차. 우아한 티타임에 딱.', '🫖', 4],
  ['낡은 추리소설', '범인이 첫 페이지에 나온다는 소문이 있다.', '📕', 3],
  ['반짝이는 헤어핀', '별 모양 장식이 달린 헤어핀.', '⭐', 5],
  ['모노쿠마 인형', '어딘가 불길한 미소를 짓고 있다.', '🧸', 8],
  ['수상한 버섯', '먹어도 될까…?', '🍄', 1],
];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

// ---------- 저장 ----------
let rooms = {};
try {
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const [code, r] of Object.entries(loaded)) if (r.version === VERSION) rooms[code] = migrate(r);
} catch {
  rooms = {};
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(rooms), (err) => {
      if (err) return console.error('저장 실패:', err);
      fs.rename(tmp, DATA_FILE, (e) => e && console.error('저장 실패:', e));
    });
  }, 1000);
}

// ---------- 자동 백업 ----------
// 방마다 내용이 바뀌었으면 10분마다 data/backups/<방코드>/ 에 스냅샷을 남긴다.
// 최근 30개 + 그 이전은 하루 1개씩 14일치를 보관. 위험한 작업(불러오기, 로그 비우기 등) 직전에도 남긴다.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DATA_FILE), 'backups');
const BACKUP_MINUTES = Number(process.env.BACKUP_MINUTES) || 10;
const BACKUP_KEEP_RECENT = 30;
const BACKUP_KEEP_DAYS = 14;
const lastBackupSig = {};

const roomForBackup = (room) => {
  const { sessions, ...rest } = room;
  return rest;
};

function snapshot(room, reason = 'auto') {
  try {
    const dir = path.join(BACKUP_DIR, room.code);
    fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(roomForBackup(room));
    fs.writeFileSync(path.join(dir, `${Date.now()}-${reason}.json`), json);
    lastBackupSig[room.code] = crypto.createHash('sha1').update(json).digest('hex');
    pruneBackups(dir);
  } catch (e) {
    console.error('백업 실패:', e);
  }
}

function listBackups(code) {
  const dir = path.join(BACKUP_DIR, code);
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /^\d+-[\w-]+\.json$/.test(n))
      .map((name) => ({ name, savedAt: Number(name.split('-')[0]), reason: name.replace(/^\d+-|\.json$/g, ''), size: fs.statSync(path.join(dir, name)).size }))
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

function pruneBackups(dir) {
  const list = listBackups(path.basename(dir));
  const keep = new Set(list.slice(0, BACKUP_KEEP_RECENT).map((b) => b.name));
  const days = new Set();
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400000;
  for (const b of list.slice(BACKUP_KEEP_RECENT)) {
    const day = new Date(b.savedAt).toDateString();
    if (b.savedAt > cutoff && !days.has(day)) {
      days.add(day);
      keep.add(b.name);
    }
  }
  list.forEach((b) => !keep.has(b.name) && fs.unlinkSync(path.join(dir, b.name)));
}

setInterval(() => {
  for (const room of Object.values(rooms)) {
    const sig = crypto.createHash('sha1').update(JSON.stringify(roomForBackup(room))).digest('hex');
    if (sig !== lastBackupSig[room.code]) snapshot(room, 'auto');
  }
}, BACKUP_MINUTES * 60000).unref();

// 업로드된 이미지는 방 데이터 안에 보관하고 이 주소로 내려준다 (백업에도 함께 포함)
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/img/:code/:id', (req, res) => {
  const data = rooms[req.params.code]?.images?.[req.params.id];
  const m = data && /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(data);
  if (!m) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(m[1]).send(Buffer.from(m[2], 'base64'));
});

// ---------- 사운드 ----------
// 음원은 직접 넣는다: GM 화면에서 올리거나 data/audio 폴더에 '<슬롯>.mp3' 같은 이름으로 넣으면 된다
// (git과 방 백업에는 포함되지 않는다)
const AUDIO_DIR = process.env.AUDIO_DIR || path.join(path.dirname(DATA_FILE), 'audio');
const AUDIO_SLOTS = [
  ['lobby', 'bgm', '로비 · 타이틀'],
  ['daily', 'bgm', '일상 파트'],
  ['investigation', 'bgm', '조사 파트'],
  ['trial', 'bgm', '학급재판'],
  ['debate', 'bgm', '반론 쇼다운'],
  ['climax', 'bgm', '클라이맥스 추리'],
  ['execution', 'bgm', '오시오키'],
  ['refute', 'se', '그건 틀렸어!'],
  ['agree', 'se', '동의한다!'],
  ['break', 'se', 'BREAK!!'],
  ['miss', 'se', '튕겨났다…'],
  ['body', 'se', '시체 발견'],
  ['announce', 'se', '모노쿠마 방송 차임'],
  ['vote', 'se', '투표 타임'],
  ['correct', 'se', '투표 정답'],
  ['wrong', 'se', '투표 오답'],
  ['showdown', 'se', '반론하겠어!'],
  ['cut', 'se', '베어 주겠어!'],
  ['skill', 'se', '스킬 발동'],
  ['fragment', 'se', '희망의 조각'],
  ['mail', 'se', '메일 도착'],
  ['gameover', 'se', 'GAME OVER'],
].map(([id, kind, label]) => ({ id, kind, label }));
const AUDIO_TYPES = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/flac': 'flac' };
const AUDIO_EXT_TYPE = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', flac: 'audio/flac' };

function audioFile(slot) {
  try {
    const f = fs.readdirSync(AUDIO_DIR).find((n) => n.replace(/\.[^.]+$/, '') === slot && AUDIO_EXT_TYPE[n.split('.').pop().toLowerCase()]);
    return f ? path.join(AUDIO_DIR, f) : null;
  } catch {
    return null;
  }
}

app.get('/audio/list', (req, res) => {
  res.json(
    AUDIO_SLOTS.map((s) => {
      const f = audioFile(s.id);
      return { ...s, version: f ? Math.floor(fs.statSync(f).mtimeMs) : null };
    })
  );
});

// 음원은 방에 로그인한 사람만 받을 수 있다 (플레이어마다 고정된 mediaKey로 확인)
const validMediaKey = (key) => !!key && Object.values(rooms).some((r) => Object.values(r.players).some((p) => p.mediaKey === key));

app.get('/audio/file/:slot', (req, res) => {
  if (!validMediaKey(String(req.query.k || ''))) return res.sendStatus(403);
  const f = AUDIO_SLOTS.some((s) => s.id === req.params.slot) && audioFile(req.params.slot);
  if (!f) return res.sendStatus(404);
  res.type(AUDIO_EXT_TYPE[f.split('.').pop().toLowerCase()]).sendFile(f);
});

// GM만 올리고 지울 수 있다 (방 코드 + 세션으로 확인)
function audioAuth(req) {
  const r = rooms[String(req.get('x-room') || '')];
  const pid = r && r.sessions[String(req.get('x-session') || '')];
  return !!pid && r.gmIds.includes(pid);
}

app.post('/audio/file/:slot', express.raw({ type: () => true, limit: '60mb' }), (req, res) => {
  const slot = AUDIO_SLOTS.find((s) => s.id === req.params.slot);
  if (!slot || !audioAuth(req)) return res.status(403).json({ error: '권한이 없습니다.' });
  const ext = AUDIO_TYPES[String(req.get('content-type') || '').split(';')[0].toLowerCase()];
  if (!ext || !req.body?.length) return res.status(400).json({ error: 'mp3, ogg, wav, m4a 같은 음원 파일만 올릴 수 있어요.' });
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const old = audioFile(slot.id);
  if (old) fs.unlinkSync(old);
  fs.writeFileSync(path.join(AUDIO_DIR, `${slot.id}.${ext}`), req.body);
  io.emit('audio:changed');
  res.json({ ok: true });
});

app.delete('/audio/file/:slot', (req, res) => {
  if (!audioAuth(req)) return res.status(403).json({ error: '권한이 없습니다.' });
  const f = AUDIO_SLOTS.some((s) => s.id === req.params.slot) && audioFile(req.params.slot);
  if (f) fs.unlinkSync(f);
  io.emit('audio:changed');
  res.json({ ok: true });
});

// ---------- 유틸 ----------
const uid = () => crypto.randomBytes(6).toString('hex');
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v, def = 0, min = -1e9, max = 1e9) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};
const arr = (v, max = 100) => (Array.isArray(v) ? v.slice(0, max) : []);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

function newRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function createRoom(code, title) {
  return {
    version: VERSION,
    code,
    title: title || '희망과 절망의 학원',
    createdAt: Date.now(),
    gmIds: [], // GM은 여러 명일 수 있다
    day: 1,
    phase: 'daily',
    locations: [...DEFAULT_LOCATIONS],
    mapImage: '',
    rules: [...DEFAULT_RULES],
    players: {},
    sessions: {},
    characters: {},
    images: {},
    evidence: {},
    posts: [],
    postSeq: 0,
    notices: [],
    shop: {
      gachaPrice: 1,
      items: DEFAULT_ITEMS.map(([name, desc, icon, price]) => ({ id: uid(), name, desc, icon, price, stock: null, gacha: true })),
    },
    trial: { messages: [], voting: false, revealed: false, votes: {}, climax: null, showdown: null },
    freeTime: { ...FREE_TIME_DEFAULTS },
    timeOfDay: 'day',
    nightClosed: [],
    lore: [], // 지난 이야기 (사이트 밖에서 진행한 챕터 기록 등)
    chapterStart: 1,
    affinity: {},
    cases: [],
    mails: [],
  };
}

// 예전 데이터에 새 필드 채우기
function migrate(room) {
  if (!Array.isArray(room.gmIds)) room.gmIds = room.gmId ? [room.gmId] : [];
  delete room.gmId;
  room.freeTime = { ...FREE_TIME_DEFAULTS, ...(room.freeTime || {}) };
  room.timeOfDay = room.timeOfDay || 'day';
  room.nightClosed = room.nightClosed || [];
  room.lore = room.lore || [];
  room.chapterStart = room.chapterStart || 1;
  room.affinity = room.affinity || {};
  room.cases = room.cases || [];
  Object.values(room.players || {}).forEach((p) => (p.mediaKey = p.mediaKey || crypto.randomBytes(12).toString('hex')));
  room.cases.forEach((c) => (c.generating = false));
  room.trial.climax = room.trial.climax || null;
  room.trial.showdown = room.trial.showdown || null;
  room.mails = room.mails || [];
  Object.values(room.characters || {}).forEach((c) => {
    if (typeof c.tickets !== 'number') c.tickets = room.freeTime.ticketsPerDay;
    c.likes = c.likes || '';
    c.dislikes = c.dislikes || '';
  });
  return room;
}

// 이미지 값: 이 방에 업로드한 이미지 주소 또는 외부 http(s) URL만 허용
function imgRef(room, v) {
  if (typeof v !== 'string') return '';
  if (v.startsWith(`/img/${room.code}/`)) return v.slice(0, 80);
  if (/^https?:\/\/[^\s"'<>]+$/.test(v)) return v.slice(0, 1000);
  return '';
}

// ---------- 공개 상태 ----------
function onlineSet(room) {
  const ids = new Set();
  for (const sid of io.sockets.adapter.rooms.get(room.code) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s?.data.pid) ids.add(s.data.pid);
  }
  return ids;
}

const isGMOf = (room, pid) => room.gmIds.includes(pid);

function canSeeChars(room, pid, charIds) {
  if (!charIds?.length || isGMOf(room, pid)) return true;
  return charIds.some((id) => room.characters[id]?.ownerId === pid);
}

// 봉인된 사건: GM도 피해자/흑막/진상을 모른다 (진상 공개 전까지)
const isSealed = (c) => !!c && c.sealed && !c.revealed;
const caseById = (room, id) => room.cases.find((c) => c.id === id);

function canSeeNotice(room, pid, n) {
  if (n.toPlayers) return n.toPlayers.includes(pid);
  if (n.private) return n.charIds.some((id) => room.characters[id]?.ownerId === pid);
  return canSeeChars(room, pid, n.charIds);
}

function canSeeMail(room, pid, m) {
  if (room.characters[m.charId]?.ownerId === pid) return true;
  return isGMOf(room, pid) && !isSealed(caseById(room, m.caseId));
}

// GM에게 보낼 사건 정보. 봉인 중이면 진상을 빼고, 시체 발견 뒤에는 단서 목록과 모노쿠마 파일만
function caseForGM(c) {
  if (!isSealed(c)) return c;
  const f = c.file;
  return {
    id: c.id, status: c.status, createdAt: c.createdAt, day: c.day, sealed: true, revealed: false,
    difficulty: c.difficulty, notes: c.notes, excludeGM: c.excludeGM, generating: c.generating,
    sentAt: c.sentAt, bodyAt: c.bodyAt, hasFile: !!f, warningCount: c.warnings?.length || 0, clueGiven: c.clueGiven,
    pointsUsed: c.pointsUsed || 0, pointsTotal: f?.trialPoints.length || 0,
    victimId: c.bodyAt ? c.victimId : null, culpritId: null,
    file: f && c.bodyAt ? { clues: f.clues.map(({ name, desc, location, howFound }) => ({ name, desc, location, howFound })), monokumaFile: f.monokumaFile } : null,
  };
}

function publicState(room, pid) {
  const gm = isGMOf(room, pid);
  const online = onlineSet(room);
  const visibleEvidence = new Set();
  const characters = Object.values(room.characters).map((c) => {
    const own = gm || c.ownerId === pid;
    const v = {
      id: c.id, ownerId: c.ownerId, name: c.name, talent: c.talent, color: c.color, profile: c.profile,
      sprites: c.sprites, skills: c.skills, alive: c.alive, npc: c.npc, mine: c.ownerId === pid,
    };
    if (own) {
      Object.assign(v, { coins: c.coins, inventory: c.inventory, bullets: c.bullets, tickets: c.tickets });
      // 좋아하는 것/싫어하는 것은 주인만 (GM도 선물 맞히기에 참여하므로)
      if (c.ownerId === pid) Object.assign(v, { likes: c.likes, dislikes: c.dislikes });
      c.bullets.forEach((id) => visibleEvidence.add(id));
    }
    return v;
  });
  const evidence = Object.values(room.evidence)
    .filter((e) => gm || visibleEvidence.has(e.id) || e.presented)
    .map((e) => (gm ? { ...e, holders: Object.values(room.characters).filter((c) => c.bullets.includes(e.id)).map((c) => c.id) } : e));
  const votes = room.trial.votes;
  const tally = {};
  Object.values(votes).forEach((t) => (tally[t] = (tally[t] || 0) + 1));
  const myVotes = {};
  for (const [voter, target] of Object.entries(votes)) if (gm || room.characters[voter]?.ownerId === pid) myVotes[voter] = target;
  return {
    code: room.code,
    title: room.title,
    day: room.day,
    phase: room.phase,
    timeOfDay: room.timeOfDay,
    nightClosed: room.nightClosed,
    chapterStart: room.chapterStart,
    lore: room.lore.filter((l) => gm || l.public),
    locations: room.locations,
    mapImage: room.mapImage,
    rules: room.rules,
    me: { id: pid, isGM: gm, nickname: room.players[pid]?.nickname, mediaKey: room.players[pid]?.mediaKey },
    players: Object.values(room.players).map((p) => ({ id: p.id, nickname: p.nickname, isGM: isGMOf(room, p.id), online: online.has(p.id) })),
    characters,
    evidence,
    posts: room.posts,
    notices: room.notices.filter((n) => canSeeNotice(room, pid, n)).slice(-100),
    shop: room.shop,
    freeTime: room.freeTime,
    mails: room.mails.filter((m) => canSeeMail(room, pid, m)),
    cases: gm ? room.cases.map(caseForGM) : undefined,
    caseAI: gm ? caseAI.hasKey() : undefined,
    affinity: Object.fromEntries(
      Object.entries(room.affinity)
        .filter(([k]) => gm || canSeeChars(room, pid, k.split('|')))
        .map(([k, v]) => [k, { ...v, level: affLevel(room, v.points) }])
    ),
    trial: {
      voting: room.trial.voting,
      revealed: room.trial.revealed,
      voteCount: Object.keys(votes).length,
      myVotes,
      tally: room.trial.revealed || gm ? tally : null,
      // 클라이맥스 추리: 정답 순서(order)는 보내지 않는다
      climax: room.trial.climax && {
        panels: room.trial.climax.panels, slots: room.trial.climax.slots, solved: room.trial.climax.solved,
        attempts: room.trial.climax.attempts, lastHits: room.trial.climax.lastHits,
      },
      // 반론 쇼다운: 아직 안 나온 대사는 보내지 않는다
      showdown: room.trial.showdown && {
        id: room.trial.showdown.id, attackerId: room.trial.showdown.attackerId, targetId: room.trial.showdown.targetId,
        index: room.trial.showdown.index, total: room.trial.showdown.lines.length,
      },
    },
  };
}

// 재판 메시지의 정답은 GM에게만, 봉인된 사건의 논점이면 GM에게도 숨긴다
function trialMsgView(room, m, gm) {
  if (!m.answerId && !m.answerName) return m;
  if (gm && !isSealed(caseById(room, m.caseId))) return m;
  const { answerId, answerName, ...rest } = m;
  return { ...rest, hasAnswer: true };
}

function sendTrialLog(room) {
  eachSocket(room, (s, id) => s.emit('trial:log', room.trial.messages.map((m) => trialMsgView(room, m, isGMOf(room, id)))));
}

function eachSocket(room, fn) {
  for (const sid of io.sockets.adapter.rooms.get(room.code) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s?.data.pid) fn(s, s.data.pid);
  }
}

function broadcast(room) {
  eachSocket(room, (s, pid) => s.emit('state', publicState(room, pid)));
  scheduleSave();
}

function notice(room, text, charIds = [], extra = {}) {
  const n = { id: uid(), ts: Date.now(), day: room.day, text, charIds, ...extra };
  room.notices.push(n);
  if (room.notices.length > MAX_NOTICES) room.notices.splice(0, room.notices.length - MAX_NOTICES);
  eachSocket(room, (s, pid) => canSeeNotice(room, pid, n) && s.emit('notice', n));
}

// 학급재판에서 꺼낸 언령은 모두에게 공개된다 (대사에 이름이 들어가면 누구나 눌러서 설명을 볼 수 있게)
// char가 있으면 그 캐릭터가 가진 언령만, 없으면(GM 나레이션) 이름이 나온 언령 전부
function presentClues(room, text, char) {
  let changed = false;
  for (const ev of Object.values(room.evidence)) {
    if (ev.presented || ev.name.length < 2 || !text.includes(ev.name)) continue;
    if (char && !char.bullets.includes(ev.id)) continue;
    ev.presented = true;
    changed = true;
  }
  return changed;
}

function trialPush(room, msg) {
  const m = { id: uid(), ts: Date.now(), ...msg };
  room.trial.messages.push(m);
  if (room.trial.messages.length > MAX_TRIAL_MESSAGES) room.trial.messages.splice(0, room.trial.messages.length - MAX_TRIAL_MESSAGES);
  eachSocket(room, (s, pid) => s.emit('trial:msg', trialMsgView(room, m, isGMOf(room, pid))));
  scheduleSave();
  return m;
}

function trialUpdate(room, m) {
  eachSocket(room, (s, pid) => s.emit('trial:update', trialMsgView(room, m, isGMOf(room, pid))));
  scheduleSave();
}

function splash(room, data) {
  io.to(room.code).emit('splash', data);
}

function bodyDiscovered(room, pid, text) {
  room.phase = 'investigation';
  room.posts.push({
    id: uid(), no: ++room.postSeq, board: 'notice', day: room.day, location: '', charId: null, spriteId: null,
    authorId: pid, monokuma: true, title: '시체가 발견되었습니다!',
    body: text || '시체가 발견되었습니다! 일정 시간의 「수사」 후, 「학급재판」을 시작합니다!\n학생 여러분은 조사 게시판에 수사 내용을 올려 주세요.',
    ts: Date.now(), editedAt: null, pinned: true, comments: [],
  });
  notice(room, '📺 시체가 발견되었습니다! 조사 파트가 시작됩니다.', [], { kind: 'phase' });
  splash(room, { kind: 'body' });
}

function sendMail(room, charId, subject, body, extra = {}) {
  const m = { id: uid(), charId, from: extra.from || '모노쿠마', subject, body, ts: Date.now(), read: false, ...extra };
  room.mails.push(m);
  notice(room, `📩 ${room.characters[charId]?.name || ''} 의 학생수첩에 새 메일이 도착했습니다.`, [charId], { kind: 'mail', private: !!extra.sealed });
  return m;
}

function grantItem(c, item, qty = 1) {
  const same = c.inventory.find((i) => i.name === item.name && i.desc === item.desc);
  if (same) same.qty += qty;
  else c.inventory.push({ id: uid(), name: item.name, desc: item.desc || '', icon: item.icon || '🎁', qty });
}

function grantBullet(c, evId) {
  if (!c.bullets.includes(evId)) c.bullets.push(evId);
}

// ---------- 친밀도 ----------
const pairKey = (a, b) => [a, b].sort().join('|');
const affLevel = (room, points) => Math.max(0, Math.min(room.freeTime.maxLevel, Math.floor(points / room.freeTime.levelPoints)));

// 두 캐릭터의 친밀도를 바꾸고, 레벨이 오르면 알림/연출
function addAffinity(room, aId, bId, delta, { event = false } = {}) {
  const a = room.characters[aId];
  const b = room.characters[bId];
  if (!a || !b || a === b) return;
  const key = pairKey(aId, bId);
  const rec = (room.affinity[key] = room.affinity[key] || { points: 0, events: 0 });
  const before = affLevel(room, rec.points);
  rec.points = Math.max(0, rec.points + delta);
  if (event) rec.events += 1;
  const after = affLevel(room, rec.points);
  if (after > before) {
    notice(room, `💗 ${a.name} 와(과) ${b.name} 의 친밀도가 Lv.${after} 이(가) 되었다! 희망의 조각을 손에 넣었다!`, [a.id, b.id], { kind: 'affinity' });
    eachSocket(room, (s, pid) => canSeeChars(room, pid, [a.id, b.id]) && s.emit('splash', { kind: 'fragment', name: `${a.name} ♥ ${b.name}`, level: after, max: room.freeTime.maxLevel }));
    if (after >= room.freeTime.maxLevel && !rec.bonded && room.freeTime.bondReward) {
      rec.bonded = true;
      bondReward(room, a, b);
      bondReward(room, b, a);
    }
  } else if (after < before) {
    notice(room, `💔 ${a.name} 와(과) ${b.name} 의 친밀도가 Lv.${after} (으)로 내려갔다…`, [a.id, b.id], { kind: 'affinity' });
  }
}

// 특정 플레이어에게만 가는 알림 (댓글, 답글, @멘션). 누른 사람 자신은 빼고
function ping(room, pids, actorId, text, link) {
  const to = [...new Set(pids)].filter((id) => id && id !== actorId && room.players[id]);
  if (to.length) notice(room, text, [], { kind: 'ping', toPlayers: to, link });
}

// 글 속 '@캐릭터이름' → 그 캐릭터 주인들
function mentionedOwners(room, text) {
  return Object.values(room.characters)
    .filter((c) => text.includes('@' + c.name))
    .map((c) => c.ownerId);
}

// 친밀도 최대: 서로에게 「유대」 스킬과 특별 메일
function bondReward(room, c, partner) {
  if (!c.skills.some((s) => s.bondWith === partner.id)) {
    c.skills.push({
      id: uid(), bondWith: partner.id, name: `유대 — ${partner.name}`, maxUses: 1, used: 0,
      desc: `${partner.name}와(과)의 유대. 학급재판에서 한 번, 막혔을 때 ${partner.name}에게 도움을 청할 수 있다 (GM에게 힌트 하나를 받거나, ${partner.name}에게 발언 차례를 넘긴다).`,
    });
  }
  sendMail(room, c.id, `💗 ${partner.name}와(과)의 유대의 증표`,
    `우푸푸… 축하해요! ${c.name} 와(과) ${partner.name} 의 유대가 최고에 이르렀습니다.\n\n두 사람만의 특별한 기억을 학생수첩에 새겨 두었어요. 학급재판에서 쓸 수 있는 스킬 「유대 — ${partner.name}」이(가) 해금되었습니다!\n\n…그 유대가 절망으로 바뀌지 않기를 빌게요~ 우푸푸푸!`,
    { kind: 'bond', from: '모노쿠마' });
}

// 선물 반응: 받는 캐릭터의 좋아하는 것/싫어하는 것 키워드와 아이템 이름 비교
function giftReaction(to, itemName) {
  const match = (list) =>
    list.split(/[,\n]/).map((k) => k.trim()).filter(Boolean).some((k) => itemName.includes(k) || k.includes(itemName));
  if (match(to.likes || '')) return 'liked';
  if (match(to.dislikes || '')) return 'disliked';
  return 'normal';
}

const charNames = (room, ids) => ids.map((id) => room.characters[id]?.name).filter(Boolean).join(', ');

function sanitizeSprites(room, list) {
  return arr(list, 30)
    .map((s) => ({ id: str(s?.id, 20) || uid(), label: str(s?.label, 20) || '기본', img: imgRef(room, s?.img) }))
    .filter((s) => s.img);
}

function sanitizeSkills(list, old = []) {
  return arr(list, 10)
    .map((s) => {
      const id = str(s?.id, 20) || uid();
      const prev = old.find((o) => o.id === id);
      return {
        id,
        name: str(s?.name, 40).trim(),
        desc: str(s?.desc, 500),
        maxUses: int(s?.maxUses, 1, 0, 99),
        used: prev ? prev.used : 0,
        ...(prev?.bondWith ? { bondWith: prev.bondWith } : {}), // 친밀도 보상 스킬 표시 유지
      };
    })
    .filter((s) => s.name);
}

// ---------- 소켓 ----------
io.on('connection', (socket) => {
  let room = null;
  let pid = null;
  const isGM = () => !!room && isGMOf(room, pid);
  const nightLocked = (loc) => !isGM() && room.timeOfDay === 'night' && !!loc && room.nightClosed.includes(loc);
  const me = () => room?.players[pid];
  const ownChar = (id) => {
    const c = room?.characters[id];
    return c && (c.ownerId === pid || isGM()) ? c : null;
  };

  // 이벤트 등록 도우미: 입장 확인, GM 권한 확인, 오류 처리
  const on = (ev, fn, opt = {}) =>
    socket.on(ev, (data, cb) => {
      // 모든 요청에 정확히 한 번 응답한다 (핸들러가 응답하지 않으면 ok)
      let done = false;
      const reply = (r) => {
        if (done) return;
        done = true;
        if (typeof cb === 'function') cb(r);
      };
      if (!data || typeof data !== 'object') data = {};
      if (opt.auth !== false && !room) return reply({ error: '방에 입장하지 않았습니다.' });
      if (opt.gm && !isGM()) return reply({ error: 'GM만 할 수 있습니다.' });
      try {
        const r = fn(data, reply);
        if (r && typeof r.then === 'function')
          r.then(
            () => reply({ ok: true }),
            (e) => {
              console.error(ev, e);
              reply({ error: caseAI.describeError(e) });
            }
          );
        else reply({ ok: true });
      } catch (e) {
        console.error(ev, e);
        reply({ error: '서버 오류가 발생했습니다.' });
      }
    });

  function enter(r, player, reply) {
    if (room && room.code !== r.code) socket.leave(room.code);
    room = r;
    pid = player.id;
    socket.data.pid = pid;
    socket.join(r.code);
    const session = crypto.randomBytes(18).toString('hex');
    r.sessions[session] = pid;
    socket.emit('trial:log', r.trial.messages.map((m) => trialMsgView(r, m, isGM())));
    broadcast(r);
    reply({ code: r.code, session });
  }

  function newPlayer(r, nickname, password) {
    const salt = crypto.randomBytes(8).toString('hex');
    const p = { id: uid(), nickname, salt, hash: hashPw(password, salt), joinedAt: Date.now(), mediaKey: crypto.randomBytes(12).toString('hex') };
    r.players[p.id] = p;
    return p;
  }

  on(
    'room:create',
    ({ nickname, password, title }, reply) => {
      nickname = str(nickname, 20).trim();
      password = str(password, 100);
      if (!nickname || !password) return reply({ error: '닉네임과 비밀번호를 입력하세요.' });
      const code = newRoomCode();
      const r = (rooms[code] = createRoom(code, str(title, 60).trim()));
      const p = newPlayer(r, nickname, password);
      r.gmIds = [p.id];
      enter(r, p, reply);
    },
    { auth: false }
  );

  on(
    'room:join',
    ({ code, nickname, password }, reply) => {
      const r = rooms[str(code, 10).toUpperCase().trim()];
      nickname = str(nickname, 20).trim();
      password = str(password, 100);
      if (!r) return reply({ error: '방을 찾을 수 없습니다.' });
      if (!nickname || !password) return reply({ error: '닉네임과 비밀번호를 입력하세요.' });
      let p = Object.values(r.players).find((x) => x.nickname === nickname);
      if (p) {
        if (hashPw(password, p.salt) !== p.hash) return reply({ error: '이미 있는 닉네임입니다. 비밀번호가 틀렸어요.' });
      } else {
        p = newPlayer(r, nickname, password);
        notice(r, `${nickname} 님이 처음 입장했습니다.`);
      }
      enter(r, p, reply);
    },
    { auth: false }
  );

  on(
    'room:resume',
    ({ code, session }, reply) => {
      const r = rooms[str(code, 10)];
      session = str(session, 64);
      const p = r && r.players[r.sessions[session]];
      if (!p) return reply({ error: '다시 로그인해 주세요.' });
      delete r.sessions[session];
      enter(r, p, reply);
    },
    { auth: false }
  );

  on('room:logout', ({ session }) => {
    delete room.sessions[str(session, 64)];
    socket.leave(room.code);
    const r = room;
    room = null;
    pid = null;
    socket.data.pid = null;
    broadcast(r);
  });

  socket.on('disconnect', () => room && broadcast(room));

  on('image:upload', ({ dataUrl }, reply) => {
    if (typeof dataUrl !== 'string' || dataUrl.length > 2_000_000 || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl))
      return reply({ error: '이미지가 너무 크거나 형식이 맞지 않습니다.' });
    if (Object.keys(room.images).length >= MAX_IMAGES) return reply({ error: '이 방의 이미지 저장 한도를 넘었습니다.' });
    const id = uid();
    room.images[id] = dataUrl;
    scheduleSave();
    reply({ url: `/img/${room.code}/${id}` });
  });

  // ---------- 캐릭터 ----------
  on('character:save', (d, reply) => {
    const fields = {
      name: str(d.name, 40).trim() || '이름 없음',
      talent: str(d.talent, 60),
      color: /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : '#ff3e8a',
      profile: str(d.profile, 3000),
      sprites: sanitizeSprites(room, d.sprites),
      likes: str(d.likes, 300),
      dislikes: str(d.dislikes, 300),
    };
    let c = d.id && room.characters[d.id];
    if (c) {
      if (!ownChar(c.id)) return reply({ error: '권한이 없습니다.' });
      // 좋아하는 것/싫어하는 것은 주인만 볼 수 있으니 주인이 저장할 때만 바꾼다
      if (c.ownerId !== pid) {
        delete fields.likes;
        delete fields.dislikes;
      }
      Object.assign(c, fields, { skills: sanitizeSkills(d.skills, c.skills) });
    } else {
      // GM은 다른 플레이어의 캐릭터를 대신 만들어 줄 수 있다
      const ownerId = isGM() && d.ownerId && room.players[d.ownerId] ? d.ownerId : pid;
      c = {
        id: uid(), ownerId, ...fields, skills: sanitizeSkills(d.skills),
        alive: true, npc: !!d.npc && isGM(), coins: 0, inventory: [], bullets: [], tickets: room.freeTime.ticketsPerDay, createdAt: Date.now(),
      };
      room.characters[c.id] = c;
      if (!c.npc) notice(room, `새 학생 「${c.name}」(${c.talent || '재능 미상'}) 이(가) 입학했습니다.`);
    }
    broadcast(room);
    reply({ id: c.id });
  });

  on('character:delete', ({ id }, reply) => {
    if (!ownChar(id)) return reply({ error: '권한이 없습니다.' });
    snapshot(room, 'before-char-delete');
    delete room.characters[id];
    delete room.trial.votes[id];
    Object.keys(room.affinity).forEach((k) => k.split('|').includes(id) && delete room.affinity[k]);
    broadcast(room);
    reply({ ok: true });
  });

  on(
    'character:alive',
    ({ id, alive }) => {
      const c = room.characters[id];
      if (!c) return;
      c.alive = !!alive;
      notice(room, alive ? `${c.name} 이(가) 생존 상태로 변경되었습니다.` : `${c.name} 이(가) 사망했습니다.`);
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'character:coins',
    ({ id, delta }) => {
      const c = room.characters[id];
      if (!c) return;
      delta = int(delta, 0, -9999, 9999);
      c.coins = Math.max(0, c.coins + delta);
      notice(room, `${c.name} 모노쿠마 메달 ${delta >= 0 ? '+' : ''}${delta} (보유 ${c.coins})`, [c.id], { kind: 'coin' });
      broadcast(room);
    },
    { gm: true }
  );

  // ---------- 게시판 ----------
  on('post:create', (d, reply) => {
    const board = BOARDS.includes(d.board) ? d.board : 'daily';
    if (board === 'notice' && !isGM()) return reply({ error: '공지는 GM만 쓸 수 있습니다.' });
    if (board === 'freetime') return reply({ error: '자유시간은 「자유시간 보내기」로 시작해 주세요.' });
    if (nightLocked(d.location)) return reply({ error: `야간에는 「${d.location}」에 출입할 수 없습니다. (교칙)` });
    const title = str(d.title, 100).trim();
    const body = str(d.body, 20000);
    if (!title) return reply({ error: '제목을 입력하세요.' });
    if (d.charId && !ownChar(d.charId)) return reply({ error: '권한이 없습니다.' });
    const post = {
      id: uid(), no: ++room.postSeq, board, day: room.day, location: str(d.location, 40),
      charId: d.charId || null, spriteId: str(d.spriteId, 20) || null, authorId: pid, title, body,
      ts: Date.now(), editedAt: null, pinned: false, comments: [],
    };
    room.posts.push(post);
    const who = room.characters[post.charId]?.name || me().nickname;
    ping(room, mentionedOwners(room, `${title}\n${body}`), pid, `📣 ${who} 이(가) 「${title}」에서 당신의 캐릭터를 불렀습니다.`, `#/post/${post.id}`);
    broadcast(room);
    reply({ id: post.id });
  });

  on('post:edit', (d, reply) => {
    const post = room.posts.find((p) => p.id === d.id);
    if (!post || (post.authorId !== pid && !isGM())) return reply({ error: '권한이 없습니다.' });
    post.title = str(d.title, 100).trim() || post.title;
    post.body = str(d.body, 20000);
    post.location = str(d.location, 40);
    post.editedAt = Date.now();
    broadcast(room);
    reply({ ok: true });
  });

  on('post:delete', ({ id }, reply) => {
    const post = room.posts.find((p) => p.id === id);
    if (!post || (post.authorId !== pid && !isGM())) return reply({ error: '권한이 없습니다.' });
    room.posts = room.posts.filter((p) => p.id !== id);
    broadcast(room);
    reply({ ok: true });
  });

  on(
    'post:pin',
    ({ id }) => {
      const post = room.posts.find((p) => p.id === id);
      if (post) post.pinned = !post.pinned;
      broadcast(room);
    },
    { gm: true }
  );

  // 댓글. GM은 댓글에 보상(언령/아이템/메달)을 붙일 수 있다
  on('comment:create', (d, reply) => {
    const post = room.posts.find((p) => p.id === d.postId);
    if (!post) return reply({ error: '글을 찾을 수 없습니다.' });
    const body = str(d.body, 5000).trim();
    const grantsIn = isGM() ? arr(d.grants, 10) : [];
    if (!body && !grantsIn.length) return reply({ error: '내용을 입력하세요.' });
    if (d.charId && !ownChar(d.charId)) return reply({ error: '권한이 없습니다.' });
    const parent = d.parentId && post.comments.find((c) => c.id === d.parentId);
    const grants = [];
    for (const g of grantsIn) {
      const targets = arr(g?.charIds, 50).filter((id) => room.characters[id]);
      if (!targets.length) continue;
      const names = charNames(room, targets);
      if (g.type === 'bullet') {
        const name = str(g.name, 60).trim();
        if (!name) continue;
        const ev = { id: uid(), name, desc: str(g.desc, 1000), location: post.location, day: room.day, ts: Date.now() };
        room.evidence[ev.id] = ev;
        targets.forEach((id) => grantBullet(room.characters[id], ev.id));
        grants.push({ type: 'bullet', label: `언령 「${name}」`, charIds: targets, evidenceId: ev.id });
        notice(room, `${names} — 언령 「${name}」 을(를) 입수했다!`, targets, { kind: 'bullet' });
      } else if (g.type === 'item') {
        const name = str(g.name, 60).trim();
        if (!name) continue;
        const item = { name, desc: str(g.desc, 500), icon: str(g.icon, 8) || '🎁' };
        targets.forEach((id) => grantItem(room.characters[id], item));
        grants.push({ type: 'item', label: `${item.icon} ${name}`, charIds: targets });
        notice(room, `${names} — 아이템 「${name}」 을(를) 얻었다!`, targets, { kind: 'item' });
      } else if (g.type === 'coin') {
        const amount = int(g.amount, 0, -9999, 9999);
        if (!amount) continue;
        targets.forEach((id) => (room.characters[id].coins = Math.max(0, room.characters[id].coins + amount)));
        grants.push({ type: 'coin', label: `모노쿠마 메달 ${amount > 0 ? '+' : ''}${amount}`, charIds: targets });
        notice(room, `${names} — 모노쿠마 메달 ${amount > 0 ? '+' : ''}${amount}`, targets, { kind: 'coin' });
      }
    }
    post.comments.push({
      id: uid(), parentId: parent ? parent.parentId || parent.id : null, charId: d.charId || null,
      spriteId: str(d.spriteId, 20) || null, authorId: pid, gm: isGM() && !d.charId, body, grants, ts: Date.now(),
    });
    const who = room.characters[d.charId]?.name || (isGM() ? 'GM' : me().nickname);
    const link = `#/post/${post.id}`;
    const mentioned = mentionedOwners(room, body);
    if (parent) ping(room, [parent.authorId], pid, `↳ ${who} 이(가) 「${post.title}」의 내 댓글에 답글을 남겼습니다.`, link);
    ping(room, [post.authorId].filter((id) => id !== parent?.authorId && !mentioned.includes(id)), pid, `💬 ${who} 이(가) 「${post.title}」에 댓글을 남겼습니다.`, link);
    ping(room, mentioned.filter((id) => id !== parent?.authorId), pid, `📣 ${who} 이(가) 「${post.title}」 댓글에서 당신의 캐릭터를 불렀습니다.`, link);
    broadcast(room);
    reply({ ok: true });
  });

  on('comment:delete', ({ postId, id }, reply) => {
    const post = room.posts.find((p) => p.id === postId);
    const c = post?.comments.find((x) => x.id === id);
    if (!c || (c.authorId !== pid && !isGM())) return reply({ error: '권한이 없습니다.' });
    post.comments = post.comments.filter((x) => x.id !== id && x.parentId !== id);
    broadcast(room);
    reply({ ok: true });
  });

  // ---------- 언령 ----------
  on(
    'evidence:create',
    ({ name, desc, location, charIds }, reply) => {
      name = str(name, 60).trim();
      if (!name) return reply({ error: '이름을 입력하세요.' });
      const ev = { id: uid(), name, desc: str(desc, 1000), location: str(location, 40), day: room.day, ts: Date.now() };
      room.evidence[ev.id] = ev;
      const targets = arr(charIds, 50).filter((id) => room.characters[id]);
      targets.forEach((id) => grantBullet(room.characters[id], ev.id));
      if (targets.length) notice(room, `${charNames(room, targets)} — 언령 「${name}」 을(를) 입수했다!`, targets, { kind: 'bullet' });
      broadcast(room);
      reply({ id: ev.id });
    },
    { gm: true }
  );

  on(
    'evidence:edit',
    ({ id, name, desc }) => {
      const ev = room.evidence[id];
      if (!ev) return;
      ev.name = str(name, 60).trim() || ev.name;
      ev.desc = str(desc, 1000);
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'evidence:delete',
    ({ id }) => {
      delete room.evidence[id];
      Object.values(room.characters).forEach((c) => (c.bullets = c.bullets.filter((b) => b !== id)));
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'evidence:holders',
    ({ id, charIds }) => {
      const ev = room.evidence[id];
      if (!ev) return;
      const set = new Set(arr(charIds, 50));
      const added = [];
      Object.values(room.characters).forEach((c) => {
        const has = c.bullets.includes(id);
        if (set.has(c.id) && !has) {
          c.bullets.push(id);
          added.push(c.id);
        }
        if (!set.has(c.id) && has) c.bullets = c.bullets.filter((b) => b !== id);
      });
      if (added.length) notice(room, `${charNames(room, added)} — 언령 「${ev.name}」 을(를) 입수했다!`, added, { kind: 'bullet' });
      broadcast(room);
    },
    { gm: true }
  );

  // 내 캐릭터가 가진 언령을 다른 캐릭터에게 공유
  on('evidence:share', ({ id, fromId, toId }, reply) => {
    const from = ownChar(fromId);
    const to = room.characters[toId];
    if (!from || !to || !from.bullets.includes(id) || !room.evidence[id]) return reply({ error: '공유할 수 없습니다.' });
    grantBullet(to, id);
    notice(room, `${from.name} → ${to.name} 언령 「${room.evidence[id].name}」 공유`, [from.id, to.id], { kind: 'bullet' });
    broadcast(room);
    reply({ ok: true });
  });

  // ---------- 인벤토리 ----------
  function takeItem(c, invId) {
    const it = c.inventory.find((i) => i.id === invId);
    if (!it) return null;
    it.qty -= 1;
    if (it.qty <= 0) c.inventory = c.inventory.filter((i) => i !== it);
    return it;
  }

  on('item:give', ({ fromId, toId, invId }, reply) => {
    const from = ownChar(fromId);
    const to = room.characters[toId];
    if (!from || !to || from === to) return reply({ error: '선물할 수 없습니다.' });
    const it = takeItem(from, invId);
    if (!it) return reply({ error: '아이템이 없습니다.' });
    grantItem(to, it);
    const reaction = giftReaction(to, it.name);
    const ft = room.freeTime;
    const pts = { liked: ft.likedPoints, disliked: ft.dislikedPoints, normal: ft.giftPoints }[reaction];
    const line = { liked: '정말 기뻐하는 것 같다! ♥', disliked: '어쩐지 곤란해하는 것 같다…', normal: '고맙게 받아 주었다.' }[reaction];
    notice(room, `🎁 ${from.name} 이(가) ${to.name} 에게 「${it.name}」 을(를) 선물했다! — ${line}`, [], { kind: 'gift' });
    if (!to.npc && !from.npc) addAffinity(room, from.id, to.id, pts);
    broadcast(room);
    reply({ ok: true, reaction });
  });

  on('item:use', ({ charId, invId }, reply) => {
    const c = ownChar(charId);
    const it = c && takeItem(c, invId);
    if (!it) return reply({ error: '아이템이 없습니다.' });
    notice(room, `${c.name} 이(가) 「${it.name}」 을(를) 사용했다.`, [c.id], { kind: 'item' });
    broadcast(room);
    reply({ ok: true });
  });

  on(
    'item:grant',
    ({ name, desc, icon, charIds }, reply) => {
      name = str(name, 60).trim();
      const targets = arr(charIds, 50).filter((id) => room.characters[id]);
      if (!name || !targets.length) return reply({ error: '이름과 대상을 정하세요.' });
      const item = { name, desc: str(desc, 500), icon: str(icon, 8) || '🎁' };
      targets.forEach((id) => grantItem(room.characters[id], item));
      notice(room, `${charNames(room, targets)} — 아이템 「${name}」 을(를) 얻었다!`, targets, { kind: 'item' });
      broadcast(room);
      reply({ ok: true });
    },
    { gm: true }
  );

  // ---------- 자유시간 / 친밀도 ----------
  // 티켓 1장으로 상대와 자유시간 → 자유시간 게시판에 두 사람의 글이 생기고 친밀도 상승
  on('freetime:start', (d, reply) => {
    const c = ownChar(d.charId);
    const partner = room.characters[d.partnerId];
    if (!c || !partner || c === partner) return reply({ error: '함께할 상대를 고르세요.' });
    if (!c.alive || !partner.alive) return reply({ error: '세상을 떠난 학생과는 자유시간을 보낼 수 없습니다.' });
    if (c.tickets <= 0 && !isGM()) return reply({ error: '오늘의 자유시간 티켓을 모두 썼습니다.' });
    const title = str(d.title, 100).trim() || `${c.name} 와(과) ${partner.name} 의 자유시간`;
    c.tickets = Math.max(0, c.tickets - 1);
    const post = {
      id: uid(), no: ++room.postSeq, board: 'freetime', day: room.day, location: str(d.location, 40),
      charId: c.id, partnerId: partner.id, spriteId: str(d.spriteId, 20) || null, authorId: pid,
      title, body: str(d.body, 20000), ts: Date.now(), editedAt: null, pinned: false, comments: [],
    };
    room.posts.push(post);
    notice(room, `💞 ${c.name} 이(가) ${partner.name} 와(과) 자유시간을 보냈다.`, [], { kind: 'affinity' });
    ping(room, [partner.ownerId], pid, `💞 ${c.name} 이(가) ${partner.name} 와(과)의 자유시간 글을 올렸습니다. 댓글로 이어서 역극해 주세요!`, `#/post/${post.id}`);
    if (!c.npc && !partner.npc) addAffinity(room, c.id, partner.id, room.freeTime.eventPoints, { event: true });
    broadcast(room);
    reply({ id: post.id });
  });

  on(
    'gm:affinity',
    ({ a, b, delta }) => {
      addAffinity(room, a, b, int(delta, 0, -999, 999));
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'gm:tickets',
    ({ charId, delta, refill }) => {
      if (refill) Object.values(room.characters).forEach((c) => (c.tickets = room.freeTime.ticketsPerDay));
      else if (room.characters[charId]) room.characters[charId].tickets = Math.max(0, room.characters[charId].tickets + int(delta, 0, -99, 99));
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'gm:freetime',
    (d) => {
      const ft = room.freeTime;
      ft.ticketsPerDay = int(d.ticketsPerDay, ft.ticketsPerDay, 0, 20);
      ft.eventPoints = int(d.eventPoints, ft.eventPoints, 0, 100);
      ft.levelPoints = int(d.levelPoints, ft.levelPoints, 1, 100);
      ft.maxLevel = int(d.maxLevel, ft.maxLevel, 1, 10);
      ft.giftPoints = int(d.giftPoints, ft.giftPoints, -50, 50);
      ft.likedPoints = int(d.likedPoints, ft.likedPoints, -50, 50);
      ft.dislikedPoints = int(d.dislikedPoints, ft.dislikedPoints, -50, 50);
      if (typeof d.bondReward === 'boolean') ft.bondReward = d.bondReward;
      broadcast(room);
    },
    { gm: true }
  );

  // ---------- 메일 ----------
  on('mail:read', ({ id }) => {
    const m = room.mails.find((x) => x.id === id);
    if (!m || !ownChar(m.charId)) return;
    if (room.characters[m.charId].ownerId !== pid) return; // GM이 열람해도 읽음 처리하지 않음
    m.read = true;
    broadcast(room);
  });

  on(
    'gm:mail',
    ({ charIds, subject, body, from }, reply) => {
      const targets = arr(charIds, 50).filter((id) => room.characters[id]);
      subject = str(subject, 100).trim();
      if (!targets.length || !subject) return reply({ error: '받는 캐릭터와 제목을 정하세요.' });
      targets.forEach((id) => sendMail(room, id, subject, str(body, 10000), { from: str(from, 30).trim() || '모노쿠마' }));
      broadcast(room);
    },
    { gm: true }
  );

  // ---------- 사건 기획 (GM 전용) ----------
  const findCase = (id) => room.cases.find((c) => c.id === id);
  // excludeMe: 추첨을 누른 GM 본인의 캐릭터 제외
  const drawPool = (excludeMe) =>
    Object.values(room.characters).filter((c) => c.alive && !c.npc && !(excludeMe && c.ownerId === pid));
  const pick = (list) => list[crypto.randomInt(list.length)];

  // 흑막·피해자에게 비밀 메일
  function sendCaseMails(c) {
    const f = c.file;
    const timeline = f.timeline.map((t) => `· ${t.time} — ${t.event}`).join('\n');
    const extra = { caseId: c.id, sealed: !!c.sealed };
    sendMail(room, c.culpritId, f.culpritMail.subject, `${f.culpritMail.body}\n\n──── 사건 경위 ────\n${timeline}`, { ...extra, kind: 'culprit' });
    const vm = caseAI.victimMail(room.characters[c.victimId]?.name || '');
    sendMail(room, c.victimId, vm.subject, vm.body, { ...extra, kind: 'victim' });
    c.sentAt = Date.now();
    c.status = 'sent';
  }

  // 사건 파일이 들어온 뒤: 봉인 모드면 바로 메일 발송
  // 사건 파일 저장: 공개되는 모노쿠마 파일에서 흑막 이름을 지우고 점검
  function setCaseFile(c, file) {
    c.file = file;
    c.warnings = caseAI.checkCase(file);
    if (caseAI.scrubName(file, room.characters[c.culpritId]?.name)) c.warnings.push('모노쿠마 파일에 흑막 이름이 있어서 지웠습니다.');
  }

  function caseFileReady(c, file, reply) {
    setCaseFile(c, file);
    c.clueGiven = {};
    c.pointsUsed = 0;
    if (c.sealed) sendCaseMails(c);
    broadcast(room);
    reply({ ok: true, warnings: c.sealed ? undefined : c.warnings, warningCount: c.warnings.length, sent: !!c.sentAt });
  }

  on(
    'case:draw',
    (d, reply) => {
      const sealed = d.sealed !== false;
      const manual = !sealed || !!d.manual; // 봉인 모드에서도 직접 지정 가능 (지정한 사람만 알게 된다)
      const pool = drawPool(!!d.excludeGM);
      const victim = (manual && room.characters[d.victimId]) || (pool.length ? pick(pool) : null);
      const rest = pool.filter((c) => c !== victim);
      const culprit = (manual && room.characters[d.culpritId]) || (rest.length ? pick(rest) : null);
      if (!victim || !culprit || victim === culprit) return reply({ error: '추첨할 수 있는 학생이 2명 이상 필요합니다.' });
      room.cases.forEach((c) => c.status === 'draft' && !c.file && (c.status = 'closed'));
      const c = {
        id: uid(), status: 'draft', createdAt: Date.now(), day: room.day, victimId: victim.id, culpritId: culprit.id,
        excludeGM: !!d.excludeGM, difficulty: str(d.difficulty, 20) || '보통', notes: str(d.notes, 1000), file: null, warnings: [],
        clueGiven: {}, sentAt: null, bodyAt: null, sealed, revealed: false, pointsUsed: 0,
      };
      room.cases.push(c);
      broadcast(room);
      reply({ id: c.id });
    },
    { gm: true }
  );

  on(
    'case:reroll',
    ({ id, which }, reply) => {
      const c = findCase(id);
      if (!c || c.sentAt) return reply({ error: '메일을 보낸 뒤에는 바꿀 수 없습니다.' });
      const pool = drawPool(c.excludeGM);
      if (which === 'victim' || which === 'both') {
        const opts = pool.filter((x) => x.id !== c.culpritId && (which === 'both' || x.id !== c.victimId));
        if (opts.length) c.victimId = pick(opts).id;
      }
      if (which === 'culprit' || which === 'both') {
        const opts = pool.filter((x) => x.id !== c.victimId && (which === 'both' || x.id !== c.culpritId));
        if (opts.length) c.culpritId = pick(opts).id;
      }
      c.file = null;
      c.warnings = [];
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'case:settings',
    ({ id, difficulty, notes }) => {
      const c = findCase(id);
      if (!c) return;
      c.difficulty = str(difficulty, 20) || c.difficulty;
      c.notes = str(notes, 1000);
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'case:prompt',
    ({ id }, reply) => {
      const c = findCase(id);
      if (!c) return reply({ error: '사건을 찾을 수 없습니다.' });
      reply({ prompt: caseAI.buildPrompt(room, c) });
    },
    { gm: true }
  );

  on(
    'case:import',
    ({ id, text }, reply) => {
      const c = findCase(id);
      if (!c) return reply({ error: '사건을 찾을 수 없습니다.' });
      if (c.sentAt) return reply({ error: '이미 메일을 보낸 사건입니다.' });
      const res = caseAI.parseCaseText(str(text, 300000));
      if (res.error) return reply({ error: res.error });
      caseFileReady(c, res.file, reply);
    },
    { gm: true }
  );

  on(
    'case:generate',
    async ({ id }, reply) => {
      const c = findCase(id);
      if (!c) return reply({ error: '사건을 찾을 수 없습니다.' });
      if (c.generating) return reply({ error: '이미 생성 중입니다.' });
      if (c.sentAt) return reply({ error: '이미 메일을 보낸 사건입니다.' });
      c.generating = true;
      broadcast(room);
      let file;
      try {
        file = await caseAI.generateCase(room, c);
      } finally {
        c.generating = false;
        broadcast(room);
      }
      caseFileReady(c, file, reply);
    },
    { gm: true }
  );

  on(
    'case:update',
    ({ id, file }, reply) => {
      const c = findCase(id);
      if (!c) return reply({ error: '사건을 찾을 수 없습니다.' });
      if (isSealed(c)) return reply({ error: '봉인된 사건은 수정할 수 없습니다.' });
      const res = caseAI.ImportSchema.safeParse(file);
      if (!res.success) return reply({ error: `형식 오류: ${res.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join(' / ')}` });
      setCaseFile(c, res.data);
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'case:send',
    ({ id }, reply) => {
      const c = findCase(id);
      if (!c?.file) return reply({ error: '사건 파일이 없습니다.' });
      if (!room.characters[c.victimId] || !room.characters[c.culpritId]) return reply({ error: '피해자나 흑막 캐릭터가 삭제되었습니다.' });
      sendCaseMails(c);
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'case:clue',
    ({ id, index, charIds }, reply) => {
      const c = findCase(id);
      if (isSealed(c) && !c.bodyAt) return reply({ error: '봉인된 사건의 단서는 시체 발견 뒤에 열립니다.' });
      const clue = c?.file?.clues[index];
      const targets = arr(charIds, 50).filter((x) => room.characters[x]);
      if (!clue || !targets.length) return reply({ error: '받을 캐릭터를 고르세요.' });
      // 같은 단서는 같은 언령으로 지급 (재판 정답 선택이 쉽도록)
      let ev = room.evidence[c.clueGiven[index]];
      if (!ev) {
        ev = { id: uid(), name: clue.name, desc: clue.desc, location: clue.location, day: room.day, ts: Date.now() };
        room.evidence[ev.id] = ev;
        c.clueGiven[index] = ev.id;
      }
      targets.forEach((x) => grantBullet(room.characters[x], ev.id));
      notice(room, `${charNames(room, targets)} — 언령 「${ev.name}」 을(를) 입수했다!`, targets, { kind: 'bullet' });
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'case:body',
    ({ id }, reply) => {
      const c = findCase(id);
      if (!c?.file) return reply({ error: '사건 파일이 없습니다.' });
      const v = room.characters[c.victimId];
      if (v) v.alive = false;
      bodyDiscovered(room, pid, `시체가 발견되었습니다! 일정 시간의 「수사」 후, 「학급재판」을 시작합니다!\n\n━━ 모노쿠마 파일 ━━\n${c.file.monokumaFile}`);
      c.bodyAt = Date.now();
      broadcast(room);
    },
    { gm: true }
  );

  // 재판: 사건 파일의 다음 논점을 논스톱 의논 발언으로 낸다 (정답은 봉인된 채 자동 판정)
  on(
    'case:point',
    ({ id }, reply) => {
      const c = findCase(id);
      const points = c?.file?.trialPoints || [];
      const i = c?.pointsUsed || 0;
      if (!points[i]) return reply({ error: '남은 논점이 없습니다.' });
      const tp = points[i];
      c.pointsUsed = i + 1;
      trialPush(room, { type: 'point', index: i + 1, topic: tp.topic, text: tp.falseClaim, answerName: tp.answerClue, caseId: c.id, author: '모노쿠마' });
      broadcast(room);
    },
    { gm: true }
  );

  // 진상 공개: 봉인을 풀고 모두에게 흑막을 알린다
  function revealCase(c, intro) {
    c.revealed = true;
    const k = room.characters[c.culpritId];
    trialPush(room, {
      type: 'announce',
      text: `${intro}이번 사건 「${c.file?.title || ''}」의 흑막은… 「${k?.name || '?'}」였습니다!${c.file ? `\n\n${c.file.overview}` : ''}`,
    });
    sendTrialLog(room);
  }

  on(
    'case:reveal',
    ({ id }, reply) => {
      const c = findCase(id);
      if (!c?.file) return reply({ error: '사건 파일이 없습니다.' });
      revealCase(c, '');
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'case:close',
    ({ id }) => {
      const c = findCase(id);
      if (c) {
        c.status = 'closed';
        c.closedAt = Date.now();
      }
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'case:delete',
    ({ id }) => {
      snapshot(room, 'before-case-delete');
      room.cases = room.cases.filter((c) => c.id !== id);
      broadcast(room);
    },
    { gm: true }
  );

  // ---------- 매점 ----------
  on(
    'shop:save',
    ({ items, gachaPrice }) => {
      room.shop.gachaPrice = int(gachaPrice, 1, 0, 9999);
      room.shop.items = arr(items, 200)
        .map((i) => ({
          id: str(i?.id, 20) || uid(),
          name: str(i?.name, 60).trim(),
          desc: str(i?.desc, 500),
          icon: str(i?.icon, 8) || '🎁',
          price: int(i?.price, 1, 0, 9999),
          stock: i?.stock === null || i?.stock === '' || i?.stock === undefined ? null : int(i.stock, 0, 0, 9999),
          gacha: !!i?.gacha,
        }))
        .filter((i) => i.name);
      broadcast(room);
    },
    { gm: true }
  );

  on('shop:buy', ({ charId, itemId }, reply) => {
    const c = ownChar(charId);
    const item = room.shop.items.find((i) => i.id === itemId);
    if (!c || !item) return reply({ error: '구매할 수 없습니다.' });
    if (item.stock !== null && item.stock <= 0) return reply({ error: '품절입니다.' });
    if (c.coins < item.price) return reply({ error: '모노쿠마 메달이 부족합니다.' });
    c.coins -= item.price;
    if (item.stock !== null) item.stock -= 1;
    grantItem(c, item);
    notice(room, `${c.name} 이(가) 매점에서 「${item.name}」 을(를) 샀다. (-${item.price})`, [c.id], { kind: 'shop' });
    broadcast(room);
    reply({ ok: true });
  });

  on('shop:gacha', ({ charId }, reply) => {
    const c = ownChar(charId);
    if (!c) return reply({ error: '캐릭터를 선택하세요.' });
    const price = room.shop.gachaPrice;
    const pool = room.shop.items.filter((i) => i.gacha && (i.stock === null || i.stock > 0));
    if (!pool.length) return reply({ error: '모노모노 머신이 비어 있습니다.' });
    if (c.coins < price) return reply({ error: '모노쿠마 메달이 부족합니다.' });
    const item = pool[crypto.randomInt(pool.length)];
    c.coins -= price;
    if (item.stock !== null) item.stock -= 1;
    grantItem(c, item);
    notice(room, `${c.name} — 모노모노 머신에서 「${item.name}」 이(가) 나왔다!`, [c.id], { kind: 'shop' });
    broadcast(room);
    reply({ item });
  });

  // ---------- 스킬 ----------
  on('skill:use', ({ charId, skillId }, reply) => {
    const c = ownChar(charId);
    const sk = c?.skills.find((s) => s.id === skillId);
    if (!sk) return reply({ error: '스킬을 찾을 수 없습니다.' });
    if (sk.maxUses > 0 && sk.used >= sk.maxUses) return reply({ error: '사용 횟수를 모두 썼습니다.' });
    sk.used += 1;
    const left = sk.maxUses > 0 ? ` (남은 횟수 ${sk.maxUses - sk.used})` : '';
    if (room.phase === 'trial') {
      trialPush(room, { type: 'skill', charId: c.id, author: me().nickname, authorId: pid, text: `〈${sk.name}〉 ${sk.desc}`.trim() });
    }
    splash(room, { kind: 'skill', name: c.name, skill: sk.name, color: c.color });
    notice(room, `✨ ${c.name} 스킬 발동 — 〈${sk.name}〉${left}`, [], { kind: 'skill' });
    broadcast(room);
    reply({ ok: true });
  });

  on(
    'skill:reset',
    () => {
      Object.values(room.characters).forEach((c) => c.skills.forEach((s) => (s.used = 0)));
      notice(room, '모든 스킬 사용 횟수가 초기화되었습니다.');
      broadcast(room);
    },
    { gm: true }
  );

  // ---------- 학급재판 ----------
  on('trial:say', (d, reply) => {
    const type = ['say', 'ooc', 'narration', 'announce'].includes(d.type) ? d.type : 'say';
    const text = str(d.text, 2000).trim();
    if (!text) return reply({ error: '내용을 입력하세요.' });
    if ((type === 'narration' || type === 'announce') && !isGM()) return reply({ error: 'GM만 쓸 수 있습니다.' });
    let c = null;
    if (type === 'say') {
      c = ownChar(d.charId);
      if (!c) return reply({ error: '말할 캐릭터를 선택하세요.' });
    }
    const answerId = isGM() && d.answerId && room.evidence[d.answerId] ? d.answerId : null;
    if (type !== 'ooc' && presentClues(room, text, c)) broadcast(room);
    trialPush(room, {
      type, text, charId: c?.id || null, spriteId: c ? str(d.spriteId, 20) || null : null,
      author: me().nickname, authorId: pid, answerId,
    });
    ping(room, mentionedOwners(room, text), pid, `📣 ${c?.name || me().nickname} 이(가) 학급재판에서 당신의 캐릭터를 불렀습니다.`, '#/trial');
    reply({ ok: true });
  });

  on('trial:dice', ({ sides, charId }) => {
    sides = int(sides, 6, 2, 1000);
    const c = charId ? ownChar(charId) : null;
    trialPush(room, { type: 'dice', text: `${c ? c.name : me().nickname}의 주사위 (d${sides}) → ${1 + crypto.randomInt(sides)}` });
  });

  on('trial:shoot', ({ msgId, charId, evidenceId, kind }, reply) => {
    const target = room.trial.messages.find((m) => m.id === msgId);
    const c = ownChar(charId);
    const ev = room.evidence[evidenceId];
    if (!target || !c || !ev) return reply({ error: '쏠 수 없습니다.' });
    if (!c.bullets.includes(evidenceId)) return reply({ error: `${c.name} 은(는) 그 언령을 가지고 있지 않습니다.` });
    if (!ev.presented) {
      ev.presented = true;
      broadcast(room);
    }
    if (target.type === 'showdown') {
      const sd = room.trial.showdown;
      if (!sd || sd.id !== target.showdownId) return reply({ error: '끝난 반론 쇼다운입니다.' });
      trialPush(room, {
        type: 'shoot', kind: 'cut', result: 'pending', targetId: target.id, showdownId: sd.id, evidenceId,
        charId: c.id, author: me().nickname, authorId: pid, text: `「${ev.name}」 ▶ “${target.text.replace(/[{}]/g, '')}”`,
      });
      splash(room, { kind: 'cut', name: c.name, color: c.color });
      return reply({ ok: true });
    }
    const agree = kind === 'agree';
    const result = target.answerId
      ? target.answerId === evidenceId ? 'break' : 'miss'
      : target.answerName ? (ev.name === target.answerName ? 'break' : 'miss') : 'pending';
    const quote = target.text.replace(/[{}]/g, '');
    trialPush(room, {
      type: 'shoot', kind: agree ? 'agree' : 'refute', result, targetId: target.id, evidenceId,
      charId: c.id, author: me().nickname, authorId: pid,
      text: `「${ev.name}」 ▶ “${quote}”`,
    });
    splash(room, { kind: agree ? 'agree' : 'refute', name: c.name, color: c.color });
    if (result !== 'pending') {
      if (result === 'break') {
        target.broken = true;
        trialUpdate(room, target);
      }
      setTimeout(() => splash(room, { kind: result }), 1500);
    }
    reply({ ok: true });
  });

  on(
    'trial:judge',
    ({ msgId, ok }) => {
      const m = room.trial.messages.find((x) => x.id === msgId && x.type === 'shoot');
      if (!m) return;
      m.result = ok ? 'break' : 'miss';
      trialUpdate(room, m);
      const target = room.trial.messages.find((x) => x.id === m.targetId);
      if (target && ok) {
        target.broken = true;
        trialUpdate(room, target);
      }
      splash(room, { kind: m.result });
    },
    { gm: true }
  );

  on(
    'trial:clear',
    () => {
      snapshot(room, 'before-clear');
      room.trial.messages = [];
      room.trial.climax = null;
      room.trial.showdown = null;
      io.to(room.code).emit('trial:log', []);
      broadcast(room);
      scheduleSave();
    },
    { gm: true }
  );

  // ---------- 클라이맥스 추리 ----------
  // 사건 재구성 컷을 섞어서 내고, 모두가 함께 순서를 맞춘다. 정답 순서는 서버만 안다
  const finaleCase = () => [...room.cases].reverse().find((x) => x.file && x.status !== 'closed');

  on(
    'climax:start',
    (_, reply) => {
      const c = finaleCase();
      if (!c) return reply({ error: '진행 중인 사건 파일이 없습니다.' });
      const texts = caseAI.climaxPanels(c.file, room.characters[c.culpritId]?.name);
      if (texts.length < 2) return reply({ error: '클라이맥스 컷이 부족합니다.' });
      const ordered = texts.map((text) => ({ id: uid(), text }));
      const panels = [...ordered];
      for (let i = panels.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [panels[i], panels[j]] = [panels[j], panels[i]];
      }
      room.trial.climax = { caseId: c.id, order: ordered.map((p) => p.id), panels, slots: [], solved: false, attempts: 0, lastHits: null };
      trialPush(room, { type: 'announce', text: '자, 그럼 사건을 처음부터 되짚어 볼까요~? 클라이맥스 추리를 시작합니다!' });
      splash(room, { kind: 'climax' });
      broadcast(room);
    },
    { gm: true }
  );

  on('climax:place', ({ panelId }) => {
    const cx = room.trial.climax;
    if (!cx || cx.solved || !cx.panels.some((p) => p.id === panelId) || cx.slots.includes(panelId)) return;
    cx.slots.push(panelId);
    broadcast(room);
  });

  on('climax:remove', ({ index }) => {
    const cx = room.trial.climax;
    if (!cx || cx.solved) return;
    cx.slots.splice(int(index, 0, 0, 99), 1);
    broadcast(room);
  });

  on('climax:clear', () => {
    const cx = room.trial.climax;
    if (!cx || cx.solved) return;
    cx.slots = [];
    broadcast(room);
  });

  on('climax:submit', (_, reply) => {
    const cx = room.trial.climax;
    if (!cx || cx.solved) return;
    if (cx.slots.length !== cx.order.length) return reply({ error: '모든 컷을 채워 주세요.' });
    cx.attempts += 1;
    const hits = cx.slots.filter((id, i) => cx.order[i] === id).length;
    cx.lastHits = hits;
    if (hits === cx.order.length) {
      cx.solved = true;
      const texts = cx.order.map((id) => cx.panels.find((p) => p.id === id).text);
      trialPush(room, { type: 'narration', text: `【클라이맥스 추리】\n${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n…이게 사건의 전말이다!` });
      io.to(room.code).emit('climax:play', { panels: texts });
    } else {
      trialPush(room, { type: 'dice', text: `클라이맥스 추리 실패… ${cx.order.length}컷 중 ${hits}컷이 제자리입니다. (${cx.attempts}번째 시도)` });
      splash(room, { kind: 'miss' });
    }
    broadcast(room);
  });

  on(
    'climax:close',
    () => {
      room.trial.climax = null;
      broadcast(room);
    },
    { gm: true }
  );

  // ---------- 오시오키 ----------
  on(
    'execution:start',
    (_, reply) => {
      const c = [...room.cases].reverse().find((x) => x.file && x.revealed && x.status !== 'closed');
      if (!c) return reply({ error: '흑막이 공개된 사건이 없습니다. 투표 결과를 먼저 공개해 주세요.' });
      const k = room.characters[c.culpritId];
      if (!k) return reply({ error: '흑막 캐릭터를 찾을 수 없습니다.' });
      const script = caseAI.executionScript(c.file, k);
      room.phase = 'execution';
      k.alive = false;
      trialPush(room, { type: 'phase', text: '처형', phase: 'execution' });
      trialPush(room, { type: 'narration', text: `【${script.title}】\n${script.scenes.join('\n')}` });
      io.to(room.code).emit('execution:play', { charId: k.id, title: script.title, scenes: script.scenes });
      notice(room, `── ${room.day}일째 · 처형 ── ${k.name}의 오시오키`, [], { kind: 'phase' });
      broadcast(room);
    },
    { gm: true }
  );

  // ---------- 반론 쇼다운 ----------
  // 누군가의 주장에 1:1로 반론. 상대가 약점을 베면, 반론한 쪽(또는 GM)이 수긍/계속을 고른다
  const showdownOwner = (sd) => sd && (room.characters[sd.attackerId]?.ownerId === pid || isGM());
  function showdownLine(sd) {
    if (presentClues(room, sd.lines[sd.index], room.characters[sd.attackerId])) broadcast(room);
    trialPush(room, {
      type: 'showdown', showdownId: sd.id, charId: sd.attackerId, targetId: sd.targetId,
      line: sd.index + 1, total: sd.lines.length, text: sd.lines[sd.index], author: me().nickname, authorId: pid,
    });
  }

  on('showdown:start', ({ charId, targetId, lines }, reply) => {
    const a = ownChar(charId);
    const t = room.characters[targetId];
    if (!a || !t || a === t) return reply({ error: '반론할 캐릭터와 상대를 고르세요.' });
    if (room.trial.showdown) return reply({ error: '이미 반론 쇼다운이 진행 중입니다.' });
    lines = arr(lines, 6).map((l) => str(l, 300).trim()).filter(Boolean);
    if (!lines.length) return reply({ error: '반론 대사를 적어 주세요.' });
    if (!lines.some((l) => /\{[^{}]+\}/.test(l))) return reply({ error: '대사 중 하나에는 {약점}이 있어야 합니다.' });
    const sd = (room.trial.showdown = { id: uid(), attackerId: a.id, targetId: t.id, lines, index: 0 });
    splash(room, { kind: 'showdown', name: `${a.name} ⚔ ${t.name}`, color: a.color });
    showdownLine(sd);
    broadcast(room);
  });

  on('showdown:next', (_, reply) => {
    const sd = room.trial.showdown;
    if (!showdownOwner(sd)) return reply({ error: '반론한 사람만 진행할 수 있습니다.' });
    if (sd.index + 1 >= sd.lines.length) return reply({ error: '남은 대사가 없습니다.' });
    sd.index += 1;
    showdownLine(sd);
    broadcast(room);
  });

  on('showdown:resolve', ({ ok }, reply) => {
    const sd = room.trial.showdown;
    if (!showdownOwner(sd)) return reply({ error: '반론한 사람만 판정할 수 있습니다.' });
    const cut = [...room.trial.messages].reverse().find((m) => m.type === 'shoot' && m.showdownId === sd.id && m.result === 'pending');
    if (cut) {
      cut.result = ok ? 'break' : 'miss';
      trialUpdate(room, cut);
    }
    if (ok) {
      const target = room.trial.messages.find((m) => m.id === cut?.targetId);
      if (target) {
        target.broken = true;
        trialUpdate(room, target);
      }
      const a = room.characters[sd.attackerId];
      room.trial.showdown = null;
      trialPush(room, { type: 'dice', text: `⚔ 반론 쇼다운 종료 — ${a?.name || ''}의 반론이 베어졌다!` });
      splash(room, { kind: 'break' });
    } else splash(room, { kind: 'still', name: room.characters[sd.attackerId]?.name });
    broadcast(room);
  });

  on('showdown:end', (_, reply) => {
    const sd = room.trial.showdown;
    if (!showdownOwner(sd)) return reply({ error: '반론한 사람만 끝낼 수 있습니다.' });
    room.trial.showdown = null;
    trialPush(room, { type: 'dice', text: '⚔ 반론 쇼다운이 끝났다.' });
    broadcast(room);
  });

  // 투표는 캐릭터 단위 (한 계정이 여러 캐릭터를 굴리므로)
  on(
    'vote:open',
    () => {
      Object.assign(room.trial, { voting: true, revealed: false, votes: {} });
      trialPush(room, { type: 'announce', text: '그럼 투표 타임입니다! 범인이라고 생각하는 사람에게 투표해 주세요! 과연 정답일까요~?' });
      splash(room, { kind: 'vote' });
      broadcast(room);
    },
    { gm: true }
  );

  on('vote:cast', ({ voterId, targetId }, reply) => {
    const voter = ownChar(voterId);
    if (!room.trial.voting || !voter || !voter.alive || voter.npc || !room.characters[targetId])
      return reply({ error: '투표할 수 없습니다.' });
    room.trial.votes[voter.id] = targetId;
    broadcast(room);
    reply({ ok: true });
  });

  on(
    'vote:reveal',
    () => {
      Object.assign(room.trial, { voting: false, revealed: true });
      const tally = {};
      Object.values(room.trial.votes).forEach((t) => (tally[t] = (tally[t] || 0) + 1));
      const lines = Object.entries(tally)
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${room.characters[id]?.name || '?'} ${n}표`);
      trialPush(room, { type: 'announce', text: `투표 결과 — ${lines.join(' / ') || '투표 없음'}` });
      splash(room, { kind: 'result' });
      const c = [...room.cases].reverse().find((x) => x.sentAt && x.status !== 'closed' && !x.revealed);
      if (c) {
        const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
        const top = sorted[0] && (!sorted[1] || sorted[1][1] < sorted[0][1]) ? sorted[0][0] : null;
        const correct = top === c.culpritId;
        setTimeout(() => {
          revealCase(c, correct ? '정답입니다~!! ' : '아쉽게도 오답! ');
          splash(room, { kind: correct ? 'correct' : 'wrong' });
          broadcast(room);
        }, 2500);
      }
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'vote:reset',
    () => {
      Object.assign(room.trial, { voting: false, revealed: false, votes: {} });
      broadcast(room);
    },
    { gm: true }
  );

  // ---------- GM 진행 ----------
  on(
    'gm:phase',
    ({ phase }) => {
      if (!PHASES[phase]) return;
      room.phase = phase;
      if (phase === 'trial' || phase === 'execution') trialPush(room, { type: 'phase', text: PHASES[phase], phase });
      notice(room, `── ${room.day}일째 · ${PHASES[phase]} ──`, [], { kind: 'phase' });
      splash(room, { kind: phase });
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'gm:body',
    ({ text }) => {
      bodyDiscovered(room, pid, str(text, 5000));
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'gm:day',
    ({ delta }) => {
      room.day = Math.max(1, room.day + (delta > 0 ? 1 : -1));
      if (delta > 0) Object.values(room.characters).forEach((c) => (c.tickets = room.freeTime.ticketsPerDay));
      notice(room, `── ${room.day}일째 ──${delta > 0 ? ' 자유시간 티켓이 충전되었습니다.' : ''}`, [], { kind: 'phase' });
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'gm:settings',
    (d) => {
      if (typeof d.title === 'string') room.title = str(d.title, 60).trim() || room.title;
      if (Array.isArray(d.locations)) room.locations = arr(d.locations, 60).map((l) => str(l, 40).trim()).filter(Boolean);
      if (Array.isArray(d.rules)) room.rules = arr(d.rules, 60).map((l) => str(l, 500).trim()).filter(Boolean);
      if (d.chapterStart !== undefined) room.chapterStart = int(d.chapterStart, 1, 1, 99);
      if (Array.isArray(d.nightClosed)) room.nightClosed = arr(d.nightClosed, 60).map((l) => str(l, 40).trim()).filter(Boolean);
      if (typeof d.mapImage === 'string') room.mapImage = imgRef(room, d.mapImage);
      broadcast(room);
    },
    { gm: true }
  );

  // 지난 이야기: 카페 등 사이트 밖에서 진행한 챕터를 기록해 두면 AI 사건 설계에 참고된다
  on(
    'gm:lore',
    ({ id, title, text, public: isPublic }, reply) => {
      title = str(title, 80).trim();
      text = str(text, 60000);
      if (!title || !text.trim()) return reply({ error: '제목과 내용을 적어 주세요.' });
      const l = id && room.lore.find((x) => x.id === id);
      if (l) Object.assign(l, { title, text, public: !!isPublic, updatedAt: Date.now() });
      else room.lore.push({ id: uid(), title, text, public: !!isPublic, ts: Date.now() });
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'gm:loreDelete',
    ({ id }) => {
      room.lore = room.lore.filter((l) => l.id !== id);
      broadcast(room);
    },
    { gm: true }
  );

  // 아침/낮/야간: 아침 방송은 다음 날로 넘기면서 티켓 충전
  const TIME_TEXT = {
    morning: '오전 7시가 되었습니다! 기상 시간이에요~ 오늘도 힘차게, 절망적인 하루를 보내 볼까요?',
    day: '자, 자유 시간입니다~ 마음껏 교류해 주세요!',
    night: '오후 10시가 되었습니다. 곧 출입 금지 구역의 문이 잠깁니다. 그럼 좋은 꿈 꾸세요~ 잘 자요!',
  };
  on(
    'gm:time',
    ({ time, text, nextDay }) => {
      if (!TIMES[time]) return;
      if (time === 'morning' && nextDay) {
        room.day += 1;
        Object.values(room.characters).forEach((c) => (c.tickets = room.freeTime.ticketsPerDay));
      }
      room.timeOfDay = time;
      const msg = str(text, 1000).trim() || TIME_TEXT[time];
      notice(room, `── ${room.day}일째 · ${TIMES[time]} ── 📺 모노쿠마: ${msg}`, [], { kind: 'announce' });
      if (time === 'night' && room.nightClosed.length) notice(room, `🔒 야간 출입 금지: ${room.nightClosed.join(', ')}`, [], { kind: 'announce' });
      splash(room, { kind: 'announce', text: msg });
      broadcast(room);
    },
    { gm: true }
  );

  // 동기 발표: 모두에게 방송 + 캐릭터별 비밀 메일
  on(
    'gm:motive',
    ({ text, perChar }, reply) => {
      text = str(text, 2000).trim();
      const mails = Object.entries(perChar && typeof perChar === 'object' ? perChar : {})
        .map(([id, body]) => [id, str(body, 5000).trim()])
        .filter(([id, body]) => room.characters[id] && body);
      if (!text && !mails.length) return reply({ error: '방송 내용이나 캐릭터별 동기를 적어 주세요.' });
      if (text) {
        notice(room, `📼 동기 발표 — 모노쿠마: ${text}`, [], { kind: 'announce' });
        splash(room, { kind: 'announce', text });
      }
      mails.forEach(([id, body]) => sendMail(room, id, '📼 당신에게 주는 「동기」', body, { kind: 'motive' }));
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'gm:announce',
    ({ text }) => {
      text = str(text, 1000).trim();
      if (!text) return;
      notice(room, `📺 모노쿠마: ${text}`, [], { kind: 'announce' });
      splash(room, { kind: 'announce', text });
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'gm:role',
    ({ playerId, on: enable }, reply) => {
      const p = room.players[playerId];
      if (!p) return;
      if (enable) {
        if (!room.gmIds.includes(p.id)) room.gmIds.push(p.id);
        notice(room, `${p.nickname} 님이 GM이 되었습니다.`);
      } else {
        if (room.gmIds.length <= 1) return reply({ error: 'GM은 최소 한 명 있어야 합니다.' });
        room.gmIds = room.gmIds.filter((id) => id !== p.id);
        notice(room, `${p.nickname} 님의 GM 권한이 해제되었습니다.`);
      }
      broadcast(room);
      sendTrialLog(room);
    },
    { gm: true }
  );

  on(
    'gm:giveChar',
    ({ charId, playerId }) => {
      const c = room.characters[charId];
      if (!c || !room.players[playerId]) return;
      c.ownerId = playerId;
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'gm:export',
    (_, reply) => {
      const { players, sessions, gmIds, ...rest } = room;
      reply(rest);
    },
    { gm: true }
  );

  // 백업 데이터로 방 내용을 바꾼다 (계정과 GM은 그대로)
  function applyBackup(data) {
    const keep = { code: room.code, players: room.players, sessions: room.sessions, gmIds: room.gmIds };
    const base = createRoom(room.code);
    for (const k of Object.keys(base)) if (k in data) base[k] = data[k];
    let next = { ...base, ...keep };
    // 이미지 주소의 방 코드를 현재 방 코드로 바꾼다
    if (data.code && data.code !== room.code) {
      next = JSON.parse(JSON.stringify(next).split(`/img/${data.code}/`).join(`/img/${room.code}/`));
    }
    Object.keys(room).forEach((k) => delete room[k]);
    Object.assign(room, migrate(next));
    // 주인 계정이 없는 캐릭터는 현재 GM 소유로
    Object.values(room.characters).forEach((c) => !room.players[c.ownerId] && (c.ownerId = room.gmIds[0]));
    sendTrialLog(room);
    broadcast(room);
  }

  on(
    'gm:import',
    ({ data }, reply) => {
      if (!data || data.version !== VERSION) return reply({ error: '이 버전의 백업 파일이 아닙니다.' });
      snapshot(room, 'before-import');
      applyBackup(data);
    },
    { gm: true }
  );

  const backupPath = (name) => /^\d+-[\w-]+\.json$/.test(String(name)) && path.join(BACKUP_DIR, room.code, name);

  on('gm:backups', (_, reply) => reply({ list: listBackups(room.code) }), { gm: true });

  on(
    'gm:backupNow',
    (_, reply) => {
      snapshot(room, 'manual');
      reply({ list: listBackups(room.code) });
    },
    { gm: true }
  );

  on(
    'gm:backupGet',
    ({ name }, reply) => {
      const f = backupPath(name);
      if (!f || !fs.existsSync(f)) return reply({ error: '백업을 찾을 수 없습니다.' });
      const { players, gmIds, ...rest } = JSON.parse(fs.readFileSync(f, 'utf8'));
      reply({ data: rest });
    },
    { gm: true }
  );

  on(
    'gm:backupRestore',
    ({ name }, reply) => {
      const f = backupPath(name);
      if (!f || !fs.existsSync(f)) return reply({ error: '백업을 찾을 수 없습니다.' });
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      snapshot(room, 'before-restore');
      applyBackup(data);
      notice(room, `💾 GM이 ${new Date(Number(name.split('-')[0])).toLocaleString('ko-KR')} 시점의 백업으로 되돌렸습니다.`);
    },
    { gm: true }
  );
});

server.listen(PORT, () => {
  console.log(`단간론파 역극 서버 실행 중: http://localhost:${PORT}`);
});
