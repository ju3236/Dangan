// AI 사건 생성: 피해자/흑막이 정해진 상태에서 Claude가 사건 파일(동기, 수법, 단서, 재판 논점)을 설계한다
const Anthropic = require('@anthropic-ai/sdk').default;
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { z } = require('zod');

const MODEL = process.env.CASE_AI_MODEL || 'claude-opus-5-5';

const CaseSchema = z.object({
  // 맨 앞에 두어 사건을 쓰기 전에 먼저 따져 보게 한다
  plausibility: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .describe(
      '사건 파일을 쓰기 전에 먼저 하는 개연성 점검 (6~10개). 최소한 다음을 묻고 답한다: ' +
        '①흑막은 왜 하필 지금, 하필 이 피해자를 죽였나(프로필·관계·지난 이야기·동기 발표에 근거) ' +
        '②흑막은 흉기와 도구를 언제 어디서 어떻게 손에 넣었나 ③흑막의 재능·체격·지식으로 그 수법이 실제로 가능한가 ' +
        '④피해자는 왜 그 시각 그 장소에 있었나 ⑤다른 학생들은 그 시각 어디서 무엇을 하고 있었고, 왜 목격하지 못했나 ' +
        '⑥흑막은 왜 이런 트릭/위장이 필요했나(단순한 방법 대신) ⑦흑막이 남긴 실수 = 결정적 단서는 무엇이고 왜 지우지 못했나 ' +
        '⑧우연이나 운에 기대는 부분은 없나(있으면 고친다) ⑨교칙·야간 출입 제한과 모순은 없나'
    ),
  title: z.string().describe('사건 제목. 예: "제1장 — 절망의 티타임"'),
  overview: z.string().describe('GM용 사건 전체 요약 (5~10문장). 누가, 왜, 어떻게, 무엇이 결정적 증거인지'),
  motive: z.string().describe('흑막의 동기'),
  method: z.string().describe('살해 방법과 트릭, 위장 공작'),
  weapon: z.string().describe('흉기'),
  crimeScene: z.string().describe('실제 살해 장소 (주어진 장소 목록 중 하나)'),
  timeOfDeath: z.string().describe('사망 시각'),
  timeline: z.array(z.object({ time: z.string(), event: z.string() })).describe('사건 전후 시간순 경위. 흑막·피해자·다른 학생들의 동선 포함'),
  monokumaFile: z.string().describe('모두에게 공개되는 모노쿠마 파일: 피해자, 사망 추정 시각, 발견 장소, 사인, 외상. 흑막의 이름이나 흑막을 가리키는 정보는 절대 쓰지 않는다'),
  culpritMail: z.object({ subject: z.string(), body: z.string() }).describe('흑막 캐릭터에게 보내는 비밀 메일. 당신이 흑막이라는 사실, 사건 경위, 남긴 흔적, 재판에서 들키지 않기 위한 행동 지침'),
  clues: z
    .array(
      z.object({
        name: z.string().describe('언령 이름 (짧게)'),
        desc: z.string().describe('학생수첩에 표시될 언령 설명'),
        location: z.string().describe('발견 장소 (장소 목록 중 하나) 또는 증언한 캐릭터'),
        kind: z.enum(['핵심', '보조', '미스디렉션']),
        howFound: z.string().describe('GM 참고: 플레이어가 어떤 조사를 하면 이 단서를 줄지'),
      })
    )
    .describe('8~14개. 핵심 단서만으로 흑막을 논리적으로 특정할 수 있어야 한다'),
  trialPoints: z
    .array(
      z.object({
        topic: z.string().describe('논점'),
        falseClaim: z.string().describe('논스톱 의논에서 나올 틀린 주장 예시. 논파할 부분을 {중괄호}로 감싼다'),
        answerClue: z.string().describe('그 주장을 논파하는 언령 이름 (clues 중 하나와 정확히 같아야 함)'),
        explanation: z.string().describe('왜 그 언령으로 논파되는지'),
      })
    )
    .describe('재판 흐름 순서대로 4~8개. 마지막은 흑막을 지목하게 되는 논점'),
  gmNotes: z.array(z.string()).describe('GM 진행 팁: 막혔을 때 줄 힌트, 예상 질문과 대답, 주의할 점'),
  climax: z
    .array(z.string())
    .describe('클라이맥스 추리용 사건 재구성 컷 5~8개 (시간순, 각 1~2문장). 흑막의 이름은 절대 쓰지 말고 "범인"이라고만 쓴다'),
  execution: z
    .object({
      title: z.string().describe('예: "초고교급 탐정 ○○의 오시오키 — 〈마지막 수수께끼〉"'),
      scenes: z.array(z.string()).describe('처형 연출 장면 4~6개. 흑막의 재능을 살린 만화적 블랙코미디 톤, 잔혹 묘사는 절제'),
    })
    .describe('흑막이 밝혀진 뒤 재생되는 오시오키(처형) 연출'),
});

// 예전에 만든 사건 파일(클라이맥스/오시오키 없음)도 불러올 수 있게
const ImportSchema = CaseSchema.extend({
  plausibility: CaseSchema.shape.plausibility.optional(),
  climax: CaseSchema.shape.climax.optional(),
  execution: CaseSchema.shape.execution.optional(),
});

const SYSTEM = `당신은 「단간론파」 스타일 학급재판 역극의 사건 설계자입니다. 한국어로 씁니다.
친구들이 캐릭터를 만들어 일상·조사·학급재판을 역극으로 진행하고, 사람 GM이 당신이 만든 사건 파일을 보고 진행합니다.

설계 원칙:
- 피해자와 흑막은 이미 정해져 있습니다. 바꾸지 마세요.
- 「GM 요청」이 있으면 아래 원칙보다 우선합니다. 요청이 원칙과 부딪히면(예: "동기 없음", "운으로 성공") 요청대로 하되, 그 안에서 최대한 납득되게 만드세요.
  · "동기 없음" → 이해관계 대신 그 캐릭터의 성격·호기심·지난 사건에서 받은 영향으로 설명되는 '이유'를 만듭니다.
  · "행운이 작용" 같은 요청 → 흑막이 운을 믿고 세운 계획으로 짜고, 운이 따른 지점을 타임라인과 개연성 점검에 분명히 적되, 재판에서 진상을 증명하는 데는 운이 아니라 단서가 쓰이게 합니다.
- 가장 중요한 것은 개연성입니다. 플레이어가 진상을 듣고 "그래서 그랬구나" 하고 납득해야 합니다.
  · 동기: 흑막의 프로필·성격·관계·지난 이야기·모노치라가 준 동기에서 자연스럽게 나와야 합니다. "갑자기 미쳐서" 같은 동기는 금지.
  · 수단: 흉기와 도구는 사이트의 아이템 목록에 얽매이지 마세요. 그 장소에 실제로 있을 법한 물건이면 무엇이든 됩니다.
    (예: 식당의 식칼·냄비, 창고의 공구·밧줄·쇠공·카트, 양호실의 약품·주사기, 세탁실의 세제·다리미, 체육관의 운동기구, 수영장의 소독약, 시청각실의 전선·조명, 도서관의 책장·사다리, 개인실의 가구·개인 물건)
    매점 상품과 캐릭터 소지품은 참고용입니다. 흑막이 그 도구를 언제 어디서 손에 넣었는지 정하고, 사라진 자리나 흔적을 단서로 남기세요.
    새로 등장하는 도구는 gmNotes에 "어느 장소에 무엇이 있다고 묘사해 둘지"를 적어 GM이 조사 파트 전에 자연스럽게 깔아 둘 수 있게 하세요.
  · 기회: 흑막·피해자·다른 학생 모두의 동선을 정하세요. 피해자가 그 장소에 간 이유가 있어야 하고, 다른 학생이 목격하지 못한 이유도 있어야 합니다.
  · 트릭은 사람이 실제로 할 수 있는 크기로. 흑막의 재능·체격·지식으로 가능한지 따지고, 운이나 우연에 기대는 장치는 쓰지 마세요.
  · 흑막은 완벽하지 않습니다. 계획에 없던 작은 실수 하나가 결정적 단서가 되게 하고, 왜 그걸 지우지 못했는지도 정하세요.
  · 단순한 계획이 더 설득력 있습니다. 트릭이 필요하다면 흑막이 왜 그런 수고를 했는지(알리바이 확보, 다른 사람에게 혐의 돌리기 등) 이유가 있어야 합니다.
- 흑막 플레이어는 사건 전후를 직접 역극으로 연기해야 합니다. 흑막 메일에 "사건 전까지 해 둘 행동"과 "조사·재판에서 해도 되는 거짓말, 하면 안 되는 말"을 구체적으로 적어 주세요.
- 페어플레이: 핵심 단서만으로 흑막을 논리적으로 특정할 수 있어야 하고, 모든 재판 논점의 answerClue는 clues 안의 이름과 정확히 같아야 합니다.
- 트릭은 난이도에 맞추되, 단서로 증명 가능한 것만 사용하세요. 초자연적 요소는 금지입니다.
- 캐릭터의 재능·프로필·스킬·관계(친밀도)·지금까지의 역극 내용을 활용하고, 이미 일어난 일과 모순되지 않게 하세요.
- 장소는 주어진 장소 목록 안에서 고르세요.
- 학원의 교칙을 지키는 사건이어야 합니다.
- 잔혹한 묘사는 원작 수준(만화적인 톤)으로 절제하세요.
- 피해자에게 가는 메일은 사이트가 고정 문구로 보내므로 쓰지 않습니다. 피해자는 흑막이 누구인지 몰라야 합니다.
- 메일은 모노쿠마의 말투(「우푸푸푸…」 등)로 쓰고, 플레이어가 바로 역극에 쓸 수 있을 만큼 구체적으로 쓰세요.`;

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const hasKey = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

// 방 상태 → 프롬프트용 요약
function buildContext(room, { victimId, culpritId, difficulty, notes }) {
  const chars = Object.values(room.characters);
  const name = (id) => room.characters[id]?.name || '?';
  const lines = [];
  lines.push(`# 학원: ${room.title} (현재 ${room.day}일째)`);
  lines.push(`\n## 장소 목록\n${room.locations.join(', ')}`);
  if (room.nightClosed?.length) lines.push(`(야간에는 출입 금지: ${room.nightClosed.join(', ')})`);
  if (room.shop?.items?.length) lines.push(`\n## 매점 상품 (참고용 — 트릭 도구는 이것에 한정되지 않음)\n${room.shop.items.map((i) => `${i.name}${i.desc ? `(${cut(i.desc, 60)})` : ''}`).join(', ')}`);
  lines.push(`\n## 교칙\n${room.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
  lines.push('\n## 학생');
  for (const c of chars) {
    if (!c.alive && c.id !== victimId) {
      lines.push(`- ${c.name} (사망)`);
      continue;
    }
    lines.push(
      `- ${c.name} / ${c.talent || '재능 미상'}${c.npc ? ' / NPC' : ''}\n  프로필: ${cut(c.profile, 600).replace(/\n/g, ' ')}` +
        (c.skills.length ? `\n  스킬: ${c.skills.map((s) => `${s.name}(${cut(s.desc, 100)})`).join('; ')}` : '') +
        (c.likes ? `\n  좋아하는 것: ${c.likes}` : '') +
        (c.dislikes ? `\n  싫어하는 것: ${c.dislikes}` : '') +
        (c.inventory?.length ? `\n  소지품: ${c.inventory.map((i) => i.name).join(', ')}` : '')
    );
  }
  const aff = Object.entries(room.affinity || {})
    .filter(([, v]) => v.points > 0)
    .map(([k, v]) => `${k.split('|').map(name).join(' ↔ ')}: ${v.points}점 (자유시간 ${v.events}회)`);
  if (aff.length) lines.push(`\n## 친밀도\n${aff.join('\n')}`);
  if (room.lore?.length) {
    lines.push('\n## 지난 이야기 (이미 일어난 일 — 여기와 모순되지 않게, 복선과 관계를 이어받아 주세요)');
    for (const l of room.lore) lines.push(`### ${l.title}\n${cut(l.text, 30000)}`);
  }
  // 모노치라가 준 동기 (전체 방송 + 이번 피해자·흑막에게 간 개인 동기 메일)
  const motives = (room.notices || []).filter((n) => n.text?.startsWith('📼 동기 발표')).slice(-3).map((n) => n.text);
  const personal = (room.mails || []).filter((m) => m.kind === 'motive' && [victimId, culpritId].includes(m.charId)).slice(-4);
  if (motives.length || personal.length) {
    lines.push('\n## 모노치라가 준 동기');
    motives.forEach((t) => lines.push(`- ${cut(t, 600)}`));
    personal.forEach((m) => lines.push(`- ${name(m.charId)} 에게 온 개인 동기: ${cut(m.body, 800).replace(/\n/g, ' ')}`));
  }
  const past = (room.cases || []).filter((c) => c.status !== 'draft' && c.file);
  if (past.length) lines.push(`\n## 이전 사건\n${past.map((c) => `- ${c.file.title}: 피해자 ${name(c.victimId)}, 흑막 ${name(c.culpritId)}`).join('\n')}`);
  const posts = room.posts.filter((p) => p.board !== 'free').slice(-40);
  if (posts.length) {
    lines.push('\n## 최근 역극 기록 (오래된 순)');
    for (const p of posts) {
      const who = [p.charId, p.partnerId].filter(Boolean).map(name).join(' & ') || p.displayName || 'GM';
      lines.push(`### [${p.day}일째${p.location ? ` · ${p.location}` : ''}] ${p.title} — ${who}\n${cut(p.body, 500)}`);
      for (const c of p.comments.slice(0, 8)) lines.push(`  └ ${c.charId ? name(c.charId) : c.displayName || 'GM'}: ${cut(c.body, 160).replace(/\n/g, ' ')}`);
    }
  }
  const chapter = (room.chapterStart || 1) + (room.cases || []).filter((c) => c.file && c.status === 'closed').length;
  lines.push(`\n## 이번 사건 조건\n- 이번 사건은 「제${chapter}장」입니다 (사건 제목에 반영)\n- 피해자: ${name(victimId)}\n- 흑막(범인): ${name(culpritId)}\n- 난이도: ${difficulty}`);
  if (notes) lines.push(`\n## GM 요청 (설계 원칙보다 우선)\n${notes}`);
  lines.push('\n위 정보를 바탕으로 사건 파일을 설계해 주세요.');
  return lines.join('\n');
}

// 피해자 메일은 AI가 쓰지 않고 고정 문구로 보낸다 (흑막에 대한 단서가 새지 않도록)
function victimMail(name) {
  return {
    subject: '우푸푸… 당신은 이번 사건의 피해자입니다',
    body: `${name} 에게.\n\n안타깝지만~ 당신은 이번 사건의 「피해자」로 뽑혔습니다!\n누가 당신을 노리는지는 비밀이에요. 시체 발견 방송이 나올 때까지 평소처럼 지내 주세요.\n\n이 메일은 다른 누구에게도 보여 주지 마세요. 우푸푸푸…!`,
  };
}

// 흑막이 밝혀지기 전에 공개되는 글(모노쿠마 파일, 클라이맥스 컷)에서 흑막 이름을 지운다. 지웠으면 true
function scrubName(file, name) {
  if (!name) return false;
  let hit = false;
  if (file.monokumaFile.includes(name)) {
    file.monokumaFile = file.monokumaFile.split(name).join('(비공개)');
    hit = true;
  }
  if (file.climax) {
    file.climax = file.climax.map((t) => {
      if (!t.includes(name)) return t;
      hit = true;
      return t.split(name).join('범인');
    });
  }
  return hit;
}

// 클라이맥스 컷: 사건 파일에 없으면 타임라인으로 대신 (흑막 이름은 '범인'으로)
function climaxPanels(file, culpritName) {
  const list = file.climax?.length ? file.climax : file.timeline.map((t) => `${t.time} — ${t.event}`);
  return list.map((t) => (culpritName ? t.split(culpritName).join('범인') : t)).map((t) => t.replace(/흑막/g, '범인'));
}

// 오시오키: 사건 파일에 없으면 기본 연출
function executionScript(file, culprit) {
  if (file?.execution?.scenes?.length) return file.execution;
  const talent = culprit?.talent || '초고교급 ???';
  return {
    title: `${talent} ${culprit?.name || ''} 의 오시오키`,
    scenes: [
      `${culprit?.name || '흑막'} 의 목에 사슬이 걸리고, 어딘가로 끌려간다.`,
      `무대 위에 「${talent}」을(를) 비튼 거대한 장치가 모습을 드러낸다.`,
      '모노쿠마가 신나게 버튼을 누른다. 우푸푸푸푸!',
      '…그리고 막이 내린다.',
    ],
  };
}

// API 없이 쓸 때: claude.ai 채팅에 붙여넣을 요청문
function buildPrompt(room, opts) {
  const schema = JSON.stringify(z.toJSONSchema(CaseSchema), null, 1);
  return `⚠️ GM에게: 이 요청문과 답변에는 사건의 진상이 담겨 있습니다. 읽지 말고 그대로 보낸 뒤, 답변이 끝나면 코드 블록의 복사 버튼만 누르세요.

${SYSTEM}

${buildContext(room, opts)}

## 출력 형식
아래 JSON 스키마를 따르는 JSON 객체 하나만 \`\`\`json 코드 블록으로 출력하세요. 이 요청을 보낸 사람도 사건 내용을 보면 안 되므로, 코드 블록 앞뒤에 요약·설명·인사를 절대 쓰지 마세요.
${schema}`;
}

// 붙여넣은 텍스트에서 JSON을 꺼내 형식 검사. 치명적이지 않은 문제는 warnings로
function parseCaseText(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  let raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return { error: 'JSON을 찾지 못했습니다. AI 답변 전체를 붙여넣어 주세요.' };
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return { error: `JSON 형식이 올바르지 않습니다: ${e.message}` };
  }
  const res = ImportSchema.safeParse(data);
  if (!res.success) {
    const issues = res.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || '(전체)'}: ${i.message}`);
    return { error: `사건 파일 형식이 맞지 않습니다.\n${issues.join('\n')}` };
  }
  return { file: res.data, warnings: checkCase(res.data) };
}

// 페어플레이 점검: 재판 논점의 정답 언령이 단서 목록에 있는지 등
function checkCase(file) {
  const names = new Set(file.clues.map((c) => c.name));
  const warnings = [];
  file.trialPoints.forEach((t, i) => {
    if (!names.has(t.answerClue)) warnings.push(`재판 논점 ${i + 1}의 정답 언령 「${t.answerClue}」이(가) 단서 목록에 없습니다.`);
  });
  if (!file.clues.some((c) => c.kind === '핵심')) warnings.push('핵심 단서가 하나도 없습니다.');
  return warnings;
}

async function generateCase(room, opts) {
  if (!hasKey()) throw new Error('서버에 ANTHROPIC_API_KEY가 설정되어 있지 않습니다.');
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: betaZodOutputFormat(CaseSchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: buildContext(room, opts) }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('AI가 이 사건 생성을 거절했습니다. GM 요청 문구를 바꿔 다시 시도해 주세요.');
  if (msg.stop_reason === 'max_tokens') throw new Error('사건 파일이 너무 길어 중간에 끊겼습니다. 다시 시도해 주세요.');
  if (!msg.parsed_output) throw new Error('AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.');
  return msg.parsed_output;
}

module.exports = { generateCase, buildPrompt, parseCaseText, checkCase, victimMail, scrubName, climaxPanels, executionScript, hasKey, CaseSchema, ImportSchema };

// API 오류를 GM에게 보여줄 한국어 문장으로
function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'API 키가 올바르지 않습니다.';
  if (e instanceof Anthropic.PermissionDeniedError) return '이 API 키로는 해당 모델을 쓸 수 없습니다.';
  if (e instanceof Anthropic.RateLimitError) return 'AI 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if (e instanceof Anthropic.APIConnectionError) return 'AI 서버에 연결하지 못했습니다.';
  if (e instanceof Anthropic.APIError) return `AI 오류 (${e.status}): ${e.message}`;
  return e?.message || String(e);
}

module.exports.describeError = describeError;
