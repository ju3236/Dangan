// 단간론파 역극 사이트 서버
// 방(room) 단위로 상태를 관리하고 Socket.IO로 실시간 동기화한다.
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const MAX_MESSAGES = 3000;
const PHASES = ['daily', 'investigation', 'trial', 'execution'];
const MSG_TYPES = ['say', 'action', 'narration', 'announce'];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });

// ---------- 저장 ----------
let rooms = {};
try {
  rooms = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  rooms = {};
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFile(DATA_FILE, JSON.stringify(rooms), (err) => {
      if (err) console.error('저장 실패:', err);
    });
  }, 1000);
}

// ---------- 유틸 ----------
const uid = () => crypto.randomBytes(6).toString('hex');
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

function newRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function createRoom(code, gmToken, title) {
  return {
    code,
    title: title || '희망과 절망의 학원',
    createdAt: Date.now(),
    gmToken,
    day: 1,
    phase: 'daily',
    location: '교실',
    locations: ['교실', '식당', '체육관', '도서실', '기숙사', '정원', '수영장', '창고'],
    monokumaFile: '',
    players: {},
    characters: {},
    messages: [],
    evidence: [],
    trial: { statements: [], voting: false, votes: {}, revealed: false },
  };
}

// 클라이언트에 보낼 상태 (메시지 제외, 토큰 숨김)
function publicState(room, token) {
  const players = Object.values(room.players).map((p) => ({
    id: p.id,
    nickname: p.nickname,
    isGM: p.token === room.gmToken,
    online: p.online,
    characterId: p.characterId,
  }));
  const me = room.players[token];
  const votes = room.trial.votes;
  const tally = {};
  Object.values(votes).forEach((cid) => (tally[cid] = (tally[cid] || 0) + 1));
  return {
    code: room.code,
    title: room.title,
    day: room.day,
    phase: room.phase,
    location: room.location,
    locations: room.locations,
    monokumaFile: room.monokumaFile,
    players,
    me: me ? { id: me.id, isGM: token === room.gmToken, characterId: me.characterId } : null,
    characters: Object.values(room.characters).map((c) => ({ ...c, ownerId: room.players[c.ownerToken]?.id || null, ownerToken: undefined })),
    evidence: room.evidence,
    trial: {
      // 정답 언령은 GM에게만 보인다
      statements: room.trial.statements.map((s) =>
        token === room.gmToken ? s : { ...s, answerId: s.answerId ? 'hidden' : null }
      ),
      voting: room.trial.voting,
      revealed: room.trial.revealed,
      voteCount: Object.keys(votes).length,
      myVote: votes[token] || null,
      tally: room.trial.revealed ? tally : null,
    },
  };
}

function broadcastState(room) {
  const sockets = io.sockets.adapter.rooms.get(room.code);
  if (!sockets) return;
  for (const sid of sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit('state', publicState(room, s.data.token));
  }
  scheduleSave();
}

function pushMessage(room, msg) {
  const full = { id: uid(), ts: Date.now(), day: room.day, phase: room.phase, location: room.location, ...msg };
  room.messages.push(full);
  if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
  io.to(room.code).emit('message', full);
  scheduleSave();
  return full;
}

function system(room, text) {
  return pushMessage(room, { type: 'system', text });
}

function sanitizeCharacter(c) {
  return {
    name: str(c.name, 40) || '이름 없음',
    talent: str(c.talent, 60),
    color: /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#ff3e8a',
    image: typeof c.image === 'string' && (c.image.startsWith('data:image/') || /^https?:\/\//.test(c.image)) ? c.image.slice(0, 600000) : '',
    profile: str(c.profile, 2000),
  };
}

// ---------- 소켓 ----------
io.on('connection', (socket) => {
  let room = null;
  const isGM = () => room && socket.data.token === room.gmToken;
  const me = () => room && room.players[socket.data.token];
  const ownsChar = (cid) => {
    const c = room && room.characters[cid];
    return c && (c.ownerToken === socket.data.token || isGM());
  };

  function enter(r, token, nickname) {
    room = r;
    socket.data.token = token;
    socket.join(r.code);
    let p = r.players[token];
    const isNew = !p;
    if (!p) {
      p = r.players[token] = { id: uid(), token, nickname, characterId: null, online: true };
    }
    p.nickname = nickname || p.nickname;
    p.online = true;
    socket.emit('joined', { code: r.code, messages: r.messages });
    if (isNew) system(r, `${p.nickname} 님이 입장했습니다.`);
    broadcastState(r);
  }

  socket.on('room:create', ({ token, nickname, title }, cb) => {
    token = str(token, 64);
    if (!token) return cb?.({ error: '잘못된 요청' });
    const code = newRoomCode();
    rooms[code] = createRoom(code, token, str(title, 60));
    enter(rooms[code], token, str(nickname, 20) || 'GM');
    system(rooms[code], '방이 만들어졌습니다. 방 코드를 친구에게 알려주세요!');
    cb?.({ code });
  });

  socket.on('room:join', ({ token, nickname, code }, cb) => {
    token = str(token, 64);
    code = str(code, 10).toUpperCase().trim();
    const r = rooms[code];
    if (!r || !token) return cb?.({ error: '방을 찾을 수 없습니다.' });
    enter(r, token, str(nickname, 20) || '참가자');
    cb?.({ code });
  });

  socket.on('disconnect', () => {
    const p = me();
    if (!p) return;
    // 같은 토큰으로 다른 탭이 남아있으면 온라인 유지
    const still = [...(io.sockets.adapter.rooms.get(room.code) || [])].some(
      (sid) => io.sockets.sockets.get(sid)?.data.token === p.token
    );
    if (!still) {
      p.online = false;
      broadcastState(room);
    }
  });

  // --- 캐릭터 ---
  socket.on('character:save', (data = {}) => {
    if (!room) return;
    const fields = sanitizeCharacter(data);
    if (data.id && room.characters[data.id]) {
      if (!ownsChar(data.id)) return;
      Object.assign(room.characters[data.id], fields);
    } else {
      const id = uid();
      // GM이 만드는 캐릭터는 NPC로 취급할 수 있도록 npc 플래그
      room.characters[id] = { id, ...fields, alive: true, npc: !!data.npc && isGM(), ownerToken: socket.data.token };
      const p = me();
      if (p && !p.characterId && !room.characters[id].npc) p.characterId = id;
    }
    broadcastState(room);
  });

  socket.on('character:select', ({ id }) => {
    const p = me();
    if (!p) return;
    if (id && !ownsChar(id)) return;
    p.characterId = id || null;
    broadcastState(room);
  });

  socket.on('character:delete', ({ id }) => {
    if (!room || !ownsChar(id)) return;
    delete room.characters[id];
    Object.values(room.players).forEach((p) => p.characterId === id && (p.characterId = null));
    broadcastState(room);
  });

  socket.on('character:alive', ({ id, alive }) => {
    if (!isGM() || !room.characters[id]) return;
    room.characters[id].alive = !!alive;
    system(room, `${room.characters[id].name} — ${alive ? '생존 상태로 변경' : '사망'}`);
    broadcastState(room);
  });

  // --- 메시지 ---
  socket.on('message:send', ({ type, text, charId }) => {
    if (!room) return;
    text = str(text, 2000).trim();
    if (!text || !MSG_TYPES.includes(type)) return;
    if ((type === 'narration' || type === 'announce') && !isGM()) return;
    const p = me();
    let character = null;
    if ((type === 'say' || type === 'action') && charId) {
      if (!ownsChar(charId)) return;
      character = room.characters[charId];
    }
    pushMessage(room, {
      type,
      text,
      authorId: p.id,
      author: p.nickname,
      charId: character?.id || null,
    });
  });

  socket.on('dice', ({ sides, charId }) => {
    if (!room) return;
    sides = Math.min(Math.max(parseInt(sides, 10) || 6, 2), 1000);
    const p = me();
    const c = charId && ownsChar(charId) ? room.characters[charId] : null;
    const result = 1 + Math.floor(Math.random() * sides);
    pushMessage(room, { type: 'dice', text: `${c ? c.name : p.nickname}의 주사위 (d${sides}) → ${result}`, authorId: p.id, author: p.nickname });
  });

  // --- GM: 진행 ---
  socket.on('gm:phase', ({ phase }) => {
    if (!isGM() || !PHASES.includes(phase)) return;
    room.phase = phase;
    const labels = { daily: '일상 파트', investigation: '조사 파트', trial: '학급재판', execution: '처형' };
    pushMessage(room, { type: 'phase', text: labels[phase], phase });
    io.to(room.code).emit('splash', { kind: phase });
    broadcastState(room);
  });

  socket.on('gm:day', ({ delta }) => {
    if (!isGM()) return;
    room.day = Math.max(1, room.day + (delta > 0 ? 1 : -1));
    pushMessage(room, { type: 'phase', text: `${room.day}일째` });
    broadcastState(room);
  });

  socket.on('gm:location', ({ location }) => {
    if (!isGM()) return;
    location = str(location, 40).trim();
    if (!location) return;
    room.location = location;
    if (!room.locations.includes(location)) room.locations.push(location);
    system(room, `장소 이동 → ${location}`);
    broadcastState(room);
  });

  socket.on('gm:locations', ({ locations }) => {
    if (!isGM() || !Array.isArray(locations)) return;
    room.locations = locations.map((l) => str(l, 40).trim()).filter(Boolean).slice(0, 50);
    broadcastState(room);
  });

  socket.on('gm:title', ({ title }) => {
    if (!isGM()) return;
    room.title = str(title, 60) || room.title;
    broadcastState(room);
  });

  socket.on('gm:body', () => {
    if (!isGM()) return;
    pushMessage(room, { type: 'announce', text: '시체가 발견되었습니다! 일정 시간의 「수사」 후, 「학급재판」을 시작합니다!', author: '모노쿠마' });
    room.phase = 'investigation';
    io.to(room.code).emit('splash', { kind: 'body' });
    broadcastState(room);
  });

  socket.on('gm:file', ({ text }) => {
    if (!isGM()) return;
    room.monokumaFile = str(text, 5000);
    system(room, '모노쿠마 파일이 갱신되었습니다.');
    broadcastState(room);
  });

  socket.on('gm:transfer', ({ playerId }) => {
    if (!isGM()) return;
    const target = Object.values(room.players).find((p) => p.id === playerId);
    if (!target) return;
    room.gmToken = target.token;
    system(room, `${target.nickname} 님이 새 GM이 되었습니다.`);
    broadcastState(room);
  });

  socket.on('gm:clearLog', () => {
    if (!isGM()) return;
    room.messages = [];
    io.to(room.code).emit('joined', { code: room.code, messages: [] });
    system(room, '로그가 초기화되었습니다.');
  });

  socket.on('gm:export', (_, cb) => {
    if (!isGM()) return;
    // 플레이어 토큰은 내보내지 않는다
    const { players, gmToken, ...rest } = room;
    cb?.(rest);
  });

  socket.on('gm:import', ({ data }, cb) => {
    if (!isGM() || !data || typeof data !== 'object') return cb?.({ error: '권한 없음' });
    try {
      const keep = { code: room.code, gmToken: room.gmToken, players: room.players };
      delete data.players;
      delete data.gmToken;
      const base = createRoom(room.code, room.gmToken);
      Object.assign(room, base, data, keep);
      room.trial = { ...base.trial, ...(data.trial || {}) };
      io.to(room.code).emit('joined', { code: room.code, messages: room.messages });
      broadcastState(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ error: String(e) });
    }
  });

  // --- 조사: 언령(증거) ---
  socket.on('evidence:add', ({ name, desc, location }) => {
    if (!room) return;
    name = str(name, 60).trim();
    if (!name) return;
    const p = me();
    const ev = { id: uid(), name, desc: str(desc, 1000), location: str(location, 40) || room.location, foundBy: p.nickname, ts: Date.now() };
    room.evidence.push(ev);
    pushMessage(room, { type: 'evidence', text: `언령 「${name}」 을(를) 입수했다!`, evidenceId: ev.id, author: p.nickname });
    broadcastState(room);
  });

  socket.on('evidence:update', ({ id, name, desc }) => {
    if (!room) return;
    const ev = room.evidence.find((e) => e.id === id);
    if (!ev) return;
    ev.name = str(name, 60).trim() || ev.name;
    ev.desc = str(desc, 1000);
    broadcastState(room);
  });

  socket.on('evidence:delete', ({ id }) => {
    if (!isGM()) return;
    room.evidence = room.evidence.filter((e) => e.id !== id);
    broadcastState(room);
  });

  // --- 학급재판: 논스톱 의논 ---
  socket.on('trial:statement', ({ text, charId, answerId }) => {
    if (!room) return;
    text = str(text, 500).trim();
    if (!text) return;
    if (charId && !ownsChar(charId)) return;
    const st = {
      id: uid(),
      text,
      charId: charId || null,
      answerId: isGM() && answerId ? str(answerId, 20) : null,
      broken: false,
    };
    room.trial.statements.push(st);
    broadcastState(room);
  });

  socket.on('trial:deleteStatement', ({ id }) => {
    if (!isGM()) return;
    room.trial.statements = room.trial.statements.filter((s) => s.id !== id);
    broadcastState(room);
  });

  socket.on('trial:clear', () => {
    if (!isGM()) return;
    room.trial.statements = [];
    broadcastState(room);
  });

  socket.on('trial:shoot', ({ statementId, evidenceId, charId, kind }) => {
    if (!room) return;
    const st = room.trial.statements.find((s) => s.id === statementId);
    const ev = room.evidence.find((e) => e.id === evidenceId);
    if (!st || !ev) return;
    const p = me();
    const c = charId && ownsChar(charId) ? room.characters[charId] : null;
    const shooter = c ? c.name : p.nickname;
    const agree = kind === 'agree';
    let result = 'pending';
    if (st.answerId) result = st.answerId === evidenceId ? 'break' : 'miss';
    const target = st.charId && room.characters[st.charId] ? room.characters[st.charId].name + ': ' : '';
    pushMessage(room, {
      type: 'shoot',
      kind: agree ? 'agree' : 'refute',
      result,
      charId: c?.id || null,
      author: p.nickname,
      text: `${shooter} — 「${ev.name}」 으로 ${agree ? '동의' : '논파'}! ▶ “${target}${st.text.replace(/[{}]/g, '')}”`,
    });
    io.to(room.code).emit('splash', { kind: agree ? 'agree' : 'refute', name: shooter, color: c?.color });
    if (result === 'break') {
      st.broken = true;
      setTimeout(() => io.to(room.code).emit('splash', { kind: 'break' }), 1600);
    } else if (result === 'miss') {
      setTimeout(() => io.to(room.code).emit('splash', { kind: 'miss' }), 1600);
    }
    broadcastState(room);
  });

  socket.on('trial:judge', ({ statementId, ok }) => {
    if (!isGM()) return;
    const st = room.trial.statements.find((s) => s.id === statementId);
    if (!st) return;
    st.broken = !!ok;
    io.to(room.code).emit('splash', { kind: ok ? 'break' : 'miss' });
    broadcastState(room);
  });

  // --- 학급재판: 투표 ---
  socket.on('vote:open', () => {
    if (!isGM()) return;
    room.trial.voting = true;
    room.trial.revealed = false;
    room.trial.votes = {};
    pushMessage(room, { type: 'announce', text: '그럼 투표 타임입니다! 각자 손에 있는 스위치로 범인이라 생각하는 사람에게 투표해 주세요!', author: '모노쿠마' });
    io.to(room.code).emit('splash', { kind: 'vote' });
    broadcastState(room);
  });

  socket.on('vote:cast', ({ charId }) => {
    if (!room || !room.trial.voting || room.trial.revealed) return;
    if (!room.characters[charId]) return;
    room.trial.votes[socket.data.token] = charId;
    broadcastState(room);
  });

  socket.on('vote:reveal', () => {
    if (!isGM()) return;
    room.trial.revealed = true;
    room.trial.voting = false;
    const tally = {};
    Object.values(room.trial.votes).forEach((cid) => (tally[cid] = (tally[cid] || 0) + 1));
    const lines = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([cid, n]) => `${room.characters[cid]?.name || '?'} ${n}표`);
    pushMessage(room, { type: 'announce', text: `투표 결과 — ${lines.join(' / ') || '투표 없음'}`, author: '모노쿠마' });
    broadcastState(room);
  });

  socket.on('vote:reset', () => {
    if (!isGM()) return;
    room.trial.voting = false;
    room.trial.revealed = false;
    room.trial.votes = {};
    broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log(`단간론파 역극 서버 실행 중: http://localhost:${PORT}`);
});
