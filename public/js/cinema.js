// 전체 화면 연출: 클라이맥스 추리 재생, 오시오키
import { esc, charById, spriteOf } from './core.js';
import { overrideBGM, se } from './audio.js';

let current = null;

// frames: [{ html, cls, ms }] 를 차례로 보여준다. 클릭하면 다음, Esc면 닫기
function play(frames, theme, bgm) {
  stop();
  overrideBGM(bgm);
  const el = document.createElement('div');
  el.className = `cinema ${theme}`;
  el.innerHTML = '<div class="cinema-frame"></div><div class="cinema-hint">클릭: 다음 · Esc: 건너뛰기</div>';
  document.body.appendChild(el);
  const box = el.querySelector('.cinema-frame');
  let i = -1;
  let timer = null;
  const next = () => {
    clearTimeout(timer);
    i += 1;
    if (i >= frames.length) return stop();
    const f = frames[i];
    box.className = `cinema-frame ${f.cls || ''}`;
    box.innerHTML = f.html;
    void box.offsetWidth;
    box.classList.add('in');
    timer = setTimeout(next, f.ms || 4200);
  };
  const onKey = (e) => e.key === 'Escape' && stop();
  el.onclick = next;
  document.addEventListener('keydown', onKey);
  current = { el, stop: () => (clearTimeout(timer), document.removeEventListener('keydown', onKey), el.remove()) };
  next();
}

function stop() {
  if (current) overrideBGM(null);
  current?.stop();
  current = null;
}

export function playClimax({ panels }) {
  const frames = [
    { cls: 'title', html: '<small>CLIMAX INFERENCE</small><b>클라이맥스 추리</b><span>사건을 처음부터 되짚어 보자…</span>', ms: 2600 },
    ...panels.map((t, i) => ({
      cls: `panel ${i % 2 ? 'right' : 'left'}`,
      html: `<div class="comic"><i>ACT ${i + 1}</i><p>${esc(t)}</p></div>`,
      ms: Math.max(3600, t.length * 90),
    })),
    { cls: 'title end', html: '<b>이게 사건의 전말이다!</b><small>COMPLETE!!</small>', ms: 3200 },
  ];
  play(frames, 'climax', 'climax');
}

export function playExecution({ charId, title, scenes }) {
  const c = charById(charId);
  const s = spriteOf(c);
  const portrait = s ? `<img class="exec-sprite" src="${esc(s.img)}" alt="">` : `<div class="exec-initial" style="--c:${c?.color || '#f33'}">${esc((c?.name || '?').slice(0, 1))}</div>`;
  const frames = [
    { cls: 'gameover', html: `<b>GAME OVER</b><span>${esc(c?.name || '')} 이(가) 쿠로로 결정되었습니다.<br>오시오키를 시작합니다!</span>`, ms: 3800 },
    { cls: 'exec-title', html: `${portrait}<div class="exec-name"><small>PUNISHMENT TIME</small>${esc(title)}</div>`, ms: 4200 },
    ...scenes.map((t, i) => ({ cls: `exec-scene s${i % 3}`, html: `${portrait}<p>${esc(t)}</p>`, ms: Math.max(3800, t.length * 95) })),
    { cls: 'exec-end', html: '<b>THE END</b><span>🐻 우푸푸푸푸…!</span>', ms: 3200 },
  ];
  se('gameover');
  play(frames, 'execution', 'execution');
}
