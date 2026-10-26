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
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const VERSION = 2;
const MAX_TRIAL_MESSAGES = 3000;
const MAX_NOTICES = 300;
const MAX_IMAGES = 600;
const PHASES = { daily: '일상 파트', investigation: '조사 파트', trial: '학급재판', execution: '처형' };
const BOARDS = ['notice', 'daily', 'investigation', 'freetime', 'free'];
const FREE_TIME_DEFAULTS = { ticketsPerDay: 2, eventPoints: 3, levelPoints: 5, maxLevel: 5, giftPoints: 1, likedPoints: 3, dislikedPoints: -2 };
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

// 업로드된 이미지는 방 데이터 안에 보관하고 이 주소로 내려준다 (백업에도 함께 포함)
app.get('/img/:code/:id', (req, res) => {
  const data = rooms[req.params.code]?.images?.[req.params.id];
  const m = data && /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(data);
  if (!m) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(m[1]).send(Buffer.from(m[2], 'base64'));
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
    gmId: null,
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
    trial: { messages: [], voting: false, revealed: false, votes: {} },
    freeTime: { ...FREE_TIME_DEFAULTS },
    affinity: {},
    cases: [],
    mails: [],
  };
}

// 예전 데이터에 새 필드 채우기
function migrate(room) {
  room.freeTime = { ...FREE_TIME_DEFAULTS, ...(room.freeTime || {}) };
  room.affinity = room.affinity || {};
  room.cases = room.cases || [];
  room.cases.forEach((c) => (c.generating = false));
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

function canSeeChars(room, pid, charIds) {
  if (!charIds?.length || pid === room.gmId) return true;
  return charIds.some((id) => room.characters[id]?.ownerId === pid);
}

function publicState(room, pid) {
  const gm = pid === room.gmId;
  const online = onlineSet(room);
  const visibleEvidence = new Set();
  const characters = Object.values(room.characters).map((c) => {
    const own = gm || c.ownerId === pid;
    const v = {
      id: c.id, ownerId: c.ownerId, name: c.name, talent: c.talent, color: c.color, profile: c.profile,
      sprites: c.sprites, skills: c.skills, alive: c.alive, npc: c.npc, mine: c.ownerId === pid,
    };
    if (own) {
      Object.assign(v, { coins: c.coins, inventory: c.inventory, bullets: c.bullets, tickets: c.tickets, likes: c.likes, dislikes: c.dislikes });
      c.bullets.forEach((id) => visibleEvidence.add(id));
    }
    return v;
  });
  const evidence = Object.values(room.evidence)
    .filter((e) => gm || visibleEvidence.has(e.id))
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
    locations: room.locations,
    mapImage: room.mapImage,
    rules: room.rules,
    me: { id: pid, isGM: gm, nickname: room.players[pid]?.nickname },
    players: Object.values(room.players).map((p) => ({ id: p.id, nickname: p.nickname, isGM: p.id === room.gmId, online: online.has(p.id) })),
    characters,
    evidence,
    posts: room.posts,
    notices: room.notices.filter((n) => canSeeChars(room, pid, n.charIds)).slice(-100),
    shop: room.shop,
    freeTime: room.freeTime,
    mails: room.mails.filter((m) => canSeeChars(room, pid, [m.charId])),
    cases: gm ? room.cases : undefined,
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
    },
  };
}

function trialMsgView(m, gm) {
  if (gm || !m.answerId) return m;
  const { answerId, ...rest } = m;
  return { ...rest, hasAnswer: true };
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
  eachSocket(room, (s, pid) => canSeeChars(room, pid, charIds) && s.emit('notice', n));
}

function trialPush(room, msg) {
  const m = { id: uid(), ts: Date.now(), ...msg };
  room.trial.messages.push(m);
  if (room.trial.messages.length > MAX_TRIAL_MESSAGES) room.trial.messages.splice(0, room.trial.messages.length - MAX_TRIAL_MESSAGES);
  eachSocket(room, (s, pid) => s.emit('trial:msg', trialMsgView(m, pid === room.gmId)));
  scheduleSave();
  return m;
}

function trialUpdate(room, m) {
  eachSocket(room, (s, pid) => s.emit('trial:update', trialMsgView(m, pid === room.gmId)));
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
  notice(room, `📩 ${room.characters[charId]?.name || ''} 의 학생수첩에 새 메일이 도착했습니다.`, [charId], { kind: 'mail' });
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
  } else if (after < before) {
    notice(room, `💔 ${a.name} 와(과) ${b.name} 의 친밀도가 Lv.${after} (으)로 내려갔다…`, [a.id, b.id], { kind: 'affinity' });
  }
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
      };
    })
    .filter((s) => s.name);
}

// ---------- 소켓 ----------
io.on('connection', (socket) => {
  let room = null;
  let pid = null;
  const isGM = () => !!room && pid === room.gmId;
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
    socket.emit('trial:log', r.trial.messages.map((m) => trialMsgView(m, isGM())));
    broadcast(r);
    reply({ code: r.code, session });
  }

  function newPlayer(r, nickname, password) {
    const salt = crypto.randomBytes(8).toString('hex');
    const p = { id: uid(), nickname, salt, hash: hashPw(password, salt), joinedAt: Date.now() };
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
      r.gmId = p.id;
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
      Object.assign(c, fields, { skills: sanitizeSkills(d.skills, c.skills) });
    } else {
      c = {
        id: uid(), ownerId: pid, ...fields, skills: sanitizeSkills(d.skills),
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
  const drawPool = (excludeGM) =>
    Object.values(room.characters).filter((c) => c.alive && !c.npc && !(excludeGM && c.ownerId === room.gmId));
  const pick = (list) => list[crypto.randomInt(list.length)];

  on(
    'case:draw',
    (d, reply) => {
      const pool = drawPool(!!d.excludeGM);
      const victim = room.characters[d.victimId] || (pool.length ? pick(pool) : null);
      const rest = pool.filter((c) => c !== victim);
      const culprit = room.characters[d.culpritId] || (rest.length ? pick(rest) : null);
      if (!victim || !culprit || victim === culprit) return reply({ error: '추첨할 수 있는 학생이 2명 이상 필요합니다.' });
      room.cases.forEach((c) => c.status === 'draft' && !c.file && (c.status = 'closed'));
      const c = {
        id: uid(), status: 'draft', createdAt: Date.now(), day: room.day, victimId: victim.id, culpritId: culprit.id,
        excludeGM: !!d.excludeGM, difficulty: str(d.difficulty, 20) || '보통', notes: str(d.notes, 1000), file: null, warnings: [],
        clueGiven: {}, sentAt: null, bodyAt: null,
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
      const res = caseAI.parseCaseText(str(text, 300000));
      if (res.error) return reply({ error: res.error });
      c.file = res.file;
      c.warnings = res.warnings;
      c.clueGiven = {};
      broadcast(room);
      reply({ ok: true, warnings: res.warnings });
    },
    { gm: true }
  );

  on(
    'case:generate',
    async ({ id }, reply) => {
      const c = findCase(id);
      if (!c) return reply({ error: '사건을 찾을 수 없습니다.' });
      if (c.generating) return reply({ error: '이미 생성 중입니다.' });
      c.generating = true;
      broadcast(room);
      try {
        const file = await caseAI.generateCase(room, c);
        c.file = file;
        c.warnings = caseAI.checkCase(file);
        c.clueGiven = {};
      } finally {
        c.generating = false;
        broadcast(room);
      }
      reply({ ok: true, warnings: c.warnings });
    },
    { gm: true }
  );

  on(
    'case:update',
    ({ id, file }, reply) => {
      const c = findCase(id);
      if (!c) return reply({ error: '사건을 찾을 수 없습니다.' });
      const res = caseAI.CaseSchema.safeParse(file);
      if (!res.success) return reply({ error: `형식 오류: ${res.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join(' / ')}` });
      c.file = res.data;
      c.warnings = caseAI.checkCase(res.data);
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
      const f = c.file;
      const timeline = f.timeline.map((t) => `· ${t.time} — ${t.event}`).join('\n');
      sendMail(room, c.culpritId, f.culpritMail.subject, `${f.culpritMail.body}\n\n──── 사건 경위 ────\n${timeline}`, { caseId: c.id, kind: 'culprit' });
      sendMail(room, c.victimId, f.victimMail.subject, f.victimMail.body, { caseId: c.id, kind: 'victim' });
      c.sentAt = Date.now();
      c.status = 'sent';
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'case:clue',
    ({ id, index, charIds }, reply) => {
      const c = findCase(id);
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

  on(
    'case:close',
    ({ id }) => {
      const c = findCase(id);
      if (c) c.status = 'closed';
      broadcast(room);
    },
    { gm: true }
  );

  on(
    'case:delete',
    ({ id }) => {
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
    trialPush(room, {
      type, text, charId: c?.id || null, spriteId: c ? str(d.spriteId, 20) || null : null,
      author: me().nickname, authorId: pid, answerId,
    });
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
    const agree = kind === 'agree';
    const result = target.answerId ? (target.answerId === evidenceId ? 'break' : 'miss') : 'pending';
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
      room.trial.messages = [];
      io.to(room.code).emit('trial:log', []);
      scheduleSave();
    },
    { gm: true }
  );

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
      if (typeof d.mapImage === 'string') room.mapImage = imgRef(room, d.mapImage);
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
    'gm:transfer',
    ({ playerId }) => {
      const p = room.players[playerId];
      if (!p) return;
      room.gmId = p.id;
      notice(room, `${p.nickname} 님이 새 GM이 되었습니다.`);
      broadcast(room);
      eachSocket(room, (s, id) => s.emit('trial:log', room.trial.messages.map((m) => trialMsgView(m, id === room.gmId))));
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
      const { players, sessions, gmId, ...rest } = room;
      reply(rest);
    },
    { gm: true }
  );

  on(
    'gm:import',
    ({ data }, reply) => {
      if (!data || data.version !== VERSION) return reply({ error: '이 버전의 백업 파일이 아닙니다.' });
      const keep = { code: room.code, players: room.players, sessions: room.sessions, gmId: room.gmId };
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
      Object.values(room.characters).forEach((c) => !room.players[c.ownerId] && (c.ownerId = room.gmId));
      eachSocket(room, (s, id) => s.emit('trial:log', room.trial.messages.map((m) => trialMsgView(m, id === room.gmId))));
      broadcast(room);
      reply({ ok: true });
    },
    { gm: true }
  );
});

server.listen(PORT, () => {
  console.log(`단간론파 역극 서버 실행 중: http://localhost:${PORT}`);
});
