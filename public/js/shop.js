// 매점 + 모노모노 머신
import { $, $$, esc, emit, store, render as paint, modal, isGM, charById, myChars, avatar, charSelectHTML, speakAs } from './core.js';

export function render(el, name, args, what) {
  if (what && what.startsWith('trial')) return;
  const s = store.state;
  const chars = myChars().filter((c) => c.mine || isGM());
  const buyerId = $('#buyer')?.value || speakAs();
  const buyer = charById(buyerId);
  paint(
    el,
    `<div class="shop">
      <div class="shop-head">
        <div><h2>🏪 학원 매점</h2><p class="hint">모노쿠마 메달로 물건을 사거나 모노모노 머신을 돌려 보세요. 산 물건은 소지품에 들어가고, 다른 학생에게 선물할 수 있어요.</p></div>
        <div class="buyer">${chars.length ? `${charSelectHTML('buyer', buyer?.id, { chars })}<span class="coins">🪙 <b>${buyer?.coins ?? 0}</b></span>` : '<a class="btn small pink" href="#/handbook/me">캐릭터 만들기</a>'}</div>
      </div>
      <div class="monomono">
        <div class="machine"><div class="globe">${s.shop.items.filter((i) => i.gacha).slice(0, 8).map((i) => `<span>${esc(i.icon)}</span>`).join('')}</div><div class="slot"></div></div>
        <div><h3>모노모노 머신</h3><p>메달 <b>${s.shop.gachaPrice}</b>개로 무작위 경품 하나! 무엇이 나올지는 모노쿠마만 알아요.</p>
          <button class="btn pink" id="gacha" ${chars.length ? '' : 'disabled'}>돌리기 (🪙${s.shop.gachaPrice})</button></div>
      </div>
      <div class="shop-grid">
        ${s.shop.items
          .map((i) => {
            const soldOut = i.stock !== null && i.stock <= 0;
            return `<div class="shop-item ${soldOut ? 'soldout' : ''}">
              <div class="icon">${esc(i.icon)}</div><b>${esc(i.name)}</b><p>${esc(i.desc)}</p>
              <div class="row"><span class="price">🪙 ${i.price}</span><small>${i.stock === null ? '' : soldOut ? '품절' : `재고 ${i.stock}`}</small>
              <button class="btn tiny pink" data-buy="${i.id}" ${soldOut || !chars.length ? 'disabled' : ''}>구매</button></div></div>`;
          })
          .join('') || '<p class="hint">진열된 상품이 없습니다.</p>'}
      </div>
      ${isGM() ? '<p class="hint">상품과 가격은 GM 화면 → 매점 관리에서 바꿀 수 있어요.</p>' : ''}
    </div>`
  );
  const b = $('#buyer', el);
  if (b) b.onchange = () => (speakAs(b.value), render(el, name, args));
  $$('[data-buy]', el).forEach(
    (btn) =>
      (btn.onclick = async () => {
        const item = s.shop.items.find((i) => i.id === btn.dataset.buy);
        if (confirm(`${charById($('#buyer').value)?.name}(으)로 「${item.name}」을(를) 🪙${item.price}에 살까요?`))
          await emit('shop:buy', { charId: $('#buyer').value, itemId: item.id });
      })
  );
  const g = $('#gacha', el);
  if (g)
    g.onclick = async () => {
      g.disabled = true;
      $('.machine', el)?.classList.add('spin');
      const res = await emit('shop:gacha', { charId: $('#buyer').value });
      setTimeout(() => {
        $('.machine')?.classList.remove('spin');
        if (g.isConnected) g.disabled = false;
        if (res?.item)
          modal(`<div class="capsule-result"><div class="capsule">${esc(res.item.icon)}</div><h2>${esc(res.item.name)}</h2><p>${esc(res.item.desc)}</p><p class="hint">소지품에 추가되었습니다.</p></div>`);
      }, 900);
    };
}
