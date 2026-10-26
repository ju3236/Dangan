// AI 사건 생성: 피해자/흑막이 정해진 상태에서 Claude가 사건 파일(동기, 수법, 단서, 재판 논점)을 설계한다
const Anthropic = require('@anthropic-ai/sdk').default;
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { z } = require('zod');

const MODEL = process.env.CASE_AI_MODEL || 'claude-opus-5-5';

const CaseSchema = z.object({
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
});

const SYSTEM = `당신은 「단간론파」 스타일 학급재판 역극의 사건 설계자입니다. 한국어로 씁니다.
친구들이 캐릭터를 만들어 일상·조사·학급재판을 역극으로 진행하고, 사람 GM이 당신이 만든 사건 파일을 보고 진행합니다.

설계 원칙:
- 피해자와 흑막은 이미 정해져 있습니다. 바꾸지 마세요.
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
        (c.dislikes ? `\n  싫어하는 것: ${c.dislikes}` : '')
    );
  }
  const aff = Object.entries(room.affinity || {})
    .filter(([, v]) => v.points > 0)
    .map(([k, v]) => `${k.split('|').map(name).join(' ↔ ')}: ${v.points}점 (자유시간 ${v.events}회)`);
  if (aff.length) lines.push(`\n## 친밀도\n${aff.join('\n')}`);
  const past = (room.cases || []).filter((c) => c.status !== 'draft' && c.file);
  if (past.length) lines.push(`\n## 이전 사건\n${past.map((c) => `- ${c.file.title}: 피해자 ${name(c.victimId)}, 흑막 ${name(c.culpritId)}`).join('\n')}`);
  const posts = room.posts.filter((p) => p.board !== 'free').slice(-30);
  if (posts.length) {
    lines.push('\n## 최근 역극 기록 (오래된 순)');
    for (const p of posts) {
      const who = [p.charId, p.partnerId].filter(Boolean).map(name).join(' & ') || 'GM';
      lines.push(`### [${p.day}일째${p.location ? ` · ${p.location}` : ''}] ${p.title} — ${who}\n${cut(p.body, 500)}`);
      for (const c of p.comments.slice(0, 8)) lines.push(`  └ ${c.charId ? name(c.charId) : 'GM'}: ${cut(c.body, 160).replace(/\n/g, ' ')}`);
    }
  }
  lines.push(`\n## 이번 사건 조건\n- 피해자: ${name(victimId)}\n- 흑막(범인): ${name(culpritId)}\n- 난이도: ${difficulty}`);
  if (notes) lines.push(`- GM 요청: ${notes}`);
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

// 공개되는 글에서 흑막 이름을 지운다. 지웠으면 true
function scrubName(file, name) {
  if (!name || !file.monokumaFile.includes(name)) return false;
  file.monokumaFile = file.monokumaFile.split(name).join('(비공개)');
  return true;
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
  const res = CaseSchema.safeParse(data);
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

module.exports = { generateCase, buildPrompt, parseCaseText, checkCase, victimMail, scrubName, hasKey, CaseSchema };

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
