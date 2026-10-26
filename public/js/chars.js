// 캐릭터 편집 (기본 정보 / 표정 스프라이트 / 고유 스킬) 과 프로필 보기
import { $, $$, esc, emit, store, modal, toast, isGM, charById, playerById, avatar, uploadImage } from './core.js';

export function openProfile(id) {
  const c = charById(id);
  if (!c) return;
  const canEdit = c.mine || isGM();
  const owner = playerById(c.ownerId);
  const d = modal(
    `<div class="profile">
      <div class="profile-art" style="--c:${c.color}">
        ${c.sprites[0] ? `<img id="pfImg" src="${esc(c.sprites[0].img)}" alt="">` : `<div class="profile-initial">${esc(c.name.slice(0, 1))}</div>`}
        ${c.alive ? '' : '<div class="dead-stamp">사망</div>'}
      </div>
      <div class="profile-info">
        <div class="talent">${esc(c.talent || '초고교급 ???')}</div>
        <h2 style="color:${c.color}">${esc(c.name)}</h2>
        <div class="hint">${c.npc ? 'NPC · ' : ''}플레이어: ${esc(owner?.nickname || '?')}</div>
        ${c.sprites.length > 1 ? `<div class="sprite-thumbs">${c.sprites.map((s) => `<button data-img="${esc(s.img)}" title="${esc(s.label)}"><img src="${esc(s.img)}" alt=""><span>${esc(s.label)}</span></button>`).join('')}</div>` : ''}
        <pre class="profile-text">${esc(c.profile || '프로필이 없습니다.')}</pre>
        <h3>고유 스킬</h3>
        ${c.skills.map((s) => `<div class="skill-card"><div><b>✨ ${esc(s.name)}</b> <small>${s.maxUses > 0 ? `재판당 ${s.maxUses}회` : '무제한'}</small><p>${esc(s.desc)}</p></div></div>`).join('') || '<p class="hint">스킬 없음</p>'}
        <div class="row end">
          ${isGM() ? `<button class="btn small ${c.alive ? 'red' : ''}" id="pfAlive">${c.alive ? '사망 처리' : '되살리기'}</button>` : ''}
          ${canEdit ? '<button class="btn small pink" id="pfEdit">수정</button>' : ''}
        </div>
      </div>
    </div>`,
    { wide: true }
  );
  $$('[data-img]', d).forEach((b) => (b.onclick = () => ($('#pfImg', d).src = b.dataset.img)));
  const edit = $('#pfEdit', d);
  if (edit) edit.onclick = () => (d.close(), openEditor(id));
  const alive = $('#pfAlive', d);
  if (alive)
    alive.onclick = () => {
      if (!c.alive || confirm(`${c.name}을(를) 사망 처리할까요?`)) emit('character:alive', { id, alive: !c.alive });
      d.close();
    };
}

export function openEditor(id = null, { npc = false } = {}) {
  const src = id ? charById(id) : null;
  const draft = {
    name: src?.name || '',
    talent: src?.talent || '',
    color: src?.color || '#ff3e8a',
    profile: src?.profile || '키: \n생일: \n좋아하는 것: \n싫어하는 것: \n\n',
    sprites: (src?.sprites || []).map((s) => ({ ...s })),
    skills: (src?.skills || []).map((s) => ({ ...s })),
  };
  const d = modal(
    `<h2>${src ? '캐릭터 수정' : npc ? 'NPC 만들기' : '새 캐릭터 만들기'}</h2>
    <nav class="ed-tabs"><button data-tab="info" class="active">기본 정보</button><button data-tab="sprites">표정 스프라이트</button><button data-tab="skills">고유 스킬</button></nav>
    <form id="edForm" class="stack">
      <section data-pane="info" class="stack">
        <div class="row"><label class="grow">이름<input id="edName" maxlength="40" required></label><label>이름 색<input type="color" id="edColor"></label></div>
        <label>재능<input id="edTalent" maxlength="60" placeholder="초고교급 ○○"></label>
        <label>프로필<textarea id="edProfile" rows="9"></textarea></label>
      </section>
      <section data-pane="sprites" class="stack hidden">
        <p class="hint">첫 번째 스프라이트가 기본 표정이자 프로필 사진이 됩니다. 배경이 투명한 PNG를 추천해요. 학급재판에서 Alt+숫자로 표정을 빠르게 바꿀 수 있어요.</p>
        <div class="sprite-grid" id="edSprites"></div>
        <div class="row wrap">
          <label class="btn small pink">이미지 업로드 (여러 장 가능)<input type="file" id="edFiles" accept="image/*" multiple hidden></label>
          <input id="edUrl" placeholder="또는 이미지 URL" class="grow"><button type="button" class="btn small" id="edAddUrl">URL 추가</button>
        </div>
      </section>
      <section data-pane="skills" class="stack hidden">
        <p class="hint">캐릭터마다 고유 스킬을 정해 주세요. 사용 횟수는 재판마다 GM이 초기화합니다. (0 = 무제한)</p>
        <div id="edSkills" class="stack"></div>
        <button type="button" class="btn small" id="edAddSkill">+ 스킬 추가</button>
      </section>
      <div class="row end">
        ${src ? '<button type="button" class="btn small red" id="edDelete">삭제</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn small ghost" id="edCancel">취소</button>
        <button class="btn small pink">저장</button>
      </div>
    </form>`,
    { wide: true }
  );
  $('#edName', d).value = draft.name;
  $('#edTalent', d).value = draft.talent;
  $('#edColor', d).value = draft.color;
  $('#edProfile', d).value = draft.profile;

  $$('.ed-tabs button', d).forEach(
    (b) =>
      (b.onclick = () => {
        $$('.ed-tabs button', d).forEach((x) => x.classList.toggle('active', x === b));
        $$('[data-pane]', d).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      })
  );

  const drawSprites = () => {
    $('#edSprites', d).innerHTML =
      draft.sprites
        .map(
          (s, i) => `<div class="sprite-cell ${i === 0 ? 'default' : ''}">
          <img src="${esc(s.img)}" alt="">
          <input data-label="${i}" value="${esc(s.label)}" maxlength="20">
          <div class="row"><button type="button" data-mv="${i}:-1">◀</button><button type="button" data-mv="${i}:1">▶</button><button type="button" data-rm="${i}">삭제</button></div>
        </div>`
        )
        .join('') || '<p class="hint">아직 스프라이트가 없습니다.</p>';
    $$('[data-label]', d).forEach((inp) => (inp.oninput = () => (draft.sprites[+inp.dataset.label].label = inp.value)));
    $$('[data-mv]', d).forEach(
      (b) =>
        (b.onclick = () => {
          const [i, dir] = b.dataset.mv.split(':').map(Number);
          const j = i + dir;
          if (j < 0 || j >= draft.sprites.length) return;
          [draft.sprites[i], draft.sprites[j]] = [draft.sprites[j], draft.sprites[i]];
          drawSprites();
        })
    );
    $$('[data-rm]', d).forEach((b) => (b.onclick = () => (draft.sprites.splice(+b.dataset.rm, 1), drawSprites())));
  };
  drawSprites();

  $('#edFiles', d).onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      toast(`업로드 중… ${f.name}`);
      const url = await uploadImage(f, 700, 1000);
      if (url) {
        draft.sprites.push({ id: Math.random().toString(36).slice(2, 10), label: f.name.replace(/\.[^.]+$/, '').slice(0, 20) || `표정 ${draft.sprites.length + 1}`, img: url });
        drawSprites();
      }
    }
  };
  $('#edAddUrl', d).onclick = () => {
    const url = $('#edUrl', d).value.trim();
    if (!/^https?:\/\//.test(url)) return toast('http(s)로 시작하는 주소를 넣어 주세요.', 'error');
    draft.sprites.push({ id: Math.random().toString(36).slice(2, 10), label: `표정 ${draft.sprites.length + 1}`, img: url });
    $('#edUrl', d).value = '';
    drawSprites();
  };

  const drawSkills = () => {
    $('#edSkills', d).innerHTML =
      draft.skills
        .map(
          (s, i) => `<div class="skill-edit">
          <div class="row"><input data-sk="${i}:name" value="${esc(s.name)}" placeholder="스킬 이름 (예: 탐정의 직감)" maxlength="40" class="grow">
          <label class="uses">횟수<input type="number" min="0" max="99" data-sk="${i}:maxUses" value="${s.maxUses ?? 1}"></label>
          <button type="button" class="btn tiny ghost" data-rmsk="${i}">✕</button></div>
          <textarea data-sk="${i}:desc" rows="2" placeholder="효과 설명 (예: 논스톱 의논에서 약점 하나를 GM에게 힌트로 받는다)">${esc(s.desc)}</textarea>
        </div>`
        )
        .join('') || '<p class="hint">스킬이 없습니다.</p>';
    $$('[data-sk]', d).forEach((inp) => {
      inp.oninput = () => {
        const [i, k] = inp.dataset.sk.split(':');
        draft.skills[+i][k] = k === 'maxUses' ? +inp.value : inp.value;
      };
    });
    $$('[data-rmsk]', d).forEach((b) => (b.onclick = () => (draft.skills.splice(+b.dataset.rmsk, 1), drawSkills())));
  };
  drawSkills();
  $('#edAddSkill', d).onclick = () => {
    draft.skills.push({ name: '', desc: '', maxUses: 1 });
    drawSkills();
  };

  $('#edCancel', d).onclick = () => d.close();
  const del = $('#edDelete', d);
  if (del)
    del.onclick = async () => {
      if (!confirm(`${src.name}을(를) 정말 삭제할까요? 소지품과 언령도 함께 사라집니다.`)) return;
      if (await emit('character:delete', { id })) d.close();
    };
  $('#edForm', d).onsubmit = async (e) => {
    e.preventDefault();
    const res = await emit('character:save', {
      id,
      npc,
      name: $('#edName', d).value,
      talent: $('#edTalent', d).value,
      color: $('#edColor', d).value,
      profile: $('#edProfile', d).value,
      sprites: draft.sprites,
      skills: draft.skills,
    });
    if (res) {
      toast('저장했습니다.');
      d.close();
    }
  };
}

export function charCard(c) {
  return `<button class="char-card ${c.alive ? '' : 'dead'}" data-profile="${c.id}" style="--c:${c.color}">
    ${avatar(c, 84)}
    <b>${esc(c.name)}</b><small>${esc(c.talent || '초고교급 ???')}</small>
    ${c.alive ? '' : '<i class="dead-mark">✝</i>'}
  </button>`;
}

export function bindCards(el) {
  $$('[data-profile]', el).forEach((b) => (b.onclick = () => openProfile(b.dataset.profile)));
}

export const ownerName = (c) => playerById(c.ownerId)?.nickname || '?';
