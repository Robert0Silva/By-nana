(() => {
  // O servidor pode sobrescrever este fallback via WHATSAPP_NUMBER sem exigir novo deploy.
  let WHATSAPP_NUMBER = '5531973053380';

  const WA_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M12.02 2C6.5 2 2 6.48 2 12c0 1.85.5 3.58 1.38 5.07L2 22l5.1-1.34A9.94 9.94 0 0 0 12.02 22C17.5 22 22 17.52 22 12S17.5 2 12.02 2Zm5.87 14.14c-.25.7-1.45 1.34-2 1.42-.53.08-1.13.11-1.83-.12-.42-.14-.96-.32-1.66-.62-2.92-1.26-4.83-4.2-4.98-4.4-.15-.2-1.19-1.58-1.19-3.02 0-1.44.76-2.15 1.03-2.44.27-.29.6-.36.8-.36.2 0 .4 0 .57.01.18.01.43-.07.67.51.25.6.85 2.07.92 2.22.07.15.12.33.02.53-.1.2-.15.32-.3.5-.15.18-.31.4-.44.53-.15.15-.3.31-.13.6.17.3.76 1.25 1.63 2.02 1.12 1 2.06 1.31 2.36 1.46.3.15.47.13.65-.08.18-.2.76-.88.96-1.18.2-.3.4-.25.67-.15.27.1 1.73.82 2.03.97.3.15.5.22.57.35.07.13.07.75-.18 1.45Z"/></svg>';

  // Catalog data now lives on the server (data/*.json), managed from /admin.html.
  let PRODUCTS = [];
  let CATEGORIES = [];
  let COLLECTIONS = [];
  let PROMOTIONS = [];
  let COUPONS = [];
  let SHIPPING_RULES = [];
  let CATEGORY_GROUPS = [];
  let CATEGORY_CONTENT = [];
  let STORIES = [];
  let NOVIDADES = [];
  let UPSELL_PRODUCTS = [];
  let BEST_SELLERS = [];

  const money = (v) =>
    v == null ? 'Sob consulta' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Parcelamento no cartão: até 6x sem juros, respeitando parcela mínima de R$ 50.
  const INSTALLMENT_COUNT = 6;
  const MIN_INSTALLMENT_VALUE = 50;
  function installmentText(price) {
    if (price == null) return '';
    const count = Math.min(INSTALLMENT_COUNT, Math.floor(price / MIN_INSTALLMENT_VALUE));
    return count >= 2 ? `ou ${count}x de ${money(price / count)} sem juros` : 'pagamento em 1x no cartão';
  }

  // dica de preço à vista no Pix, exibida no card/PDP para antecipar o desconto que hoje só
  // aparece no fechamento do pedido (mesmo percentual de PromoEngine.bestDiscount — não é um
  // desconto extra, só mostra mais cedo um que o checkout já aplicaria).
  function pixHintText(price) {
    if (price == null) return '';
    const pct = window.PromoEngine.PIX_DISCOUNT_PERCENT;
    const pixPrice = price * (1 - pct / 100);
    return `ou ${money(pixPrice)} no Pix (-${pct}%)`;
  }

  // avaliações trazem texto livre digitado por clientes (nome de conta, comentário) — precisa
  // escapar antes de ir pro innerHTML, ou vira XSS armazenado visível pra qualquer visitante.
  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
  }

  // Resolves the price a customer actually pays for a product right now (item/category/collection/site promos).
  function getEffective(p) {
    if (p.price == null) return { price: null, promo: null };
    const best = PROMOTIONS.length ? window.PromoEngine.bestPromoForProduct(p, PROMOTIONS) : null;
    return best ? { price: best.price, promo: best } : { price: p.price, promo: null };
  }

  // Dados da compra guardados só entre o redirecionamento pro checkout online (gateway ativo
  // em PAYMENT_PROVIDER) e a volta pro site (ver handleCheckoutReturn) — a página recarrega
  // nesse meio tempo, então o estado em memória (checkoutTotal/checkoutItems) não sobrevive,
  // precisa ir pro localStorage.
  const PENDING_PURCHASE_KEY = 'bynana_pending_purchase';

  // ---------- coupon (applied on top of the bag subtotal) ----------
  const COUPON_KEY = 'bynana_coupon';
  let appliedCouponCode = localStorage.getItem(COUPON_KEY) || '';

  function activeCoupon() {
    return appliedCouponCode ? window.PromoEngine.findCoupon(COUPONS, appliedCouponCode) : null;
  }

  // ---------- carrinho: chave por produto+variação (produto sem variação usa variantId nulo) ----------
  function cartKey(productId, variantId) {
    return `${productId}::${variantId || '_'}`;
  }

  function variantLabel(v) {
    if (v.size && v.color) return `${v.size} - ${v.color}`;
    return v.size || v.color || 'Único';
  }

  // ---------- estoque baixo e cores (vitrine + página de produto) ----------
  const LOW_STOCK_THRESHOLD = 3;

  // Nomes de cor são texto livre digitado no admin, sem hex salvo — mapeamos os mais comuns
  // e caímos para um chip de texto quando a cor não está no dicionário (evita mostrar cor errada).
  const COLOR_HEX_MAP = {
    preto: '#1e1c1a',
    branco: '#ffffff',
    'off-white': '#f5f0e6',
    bege: '#e8dcc8',
    marrom: '#6b4a2f',
    camel: '#a9713c',
    caramelo: '#a9713c',
    dourado: '#c9a24b',
    prata: '#c7c7c7',
    prateado: '#c7c7c7',
    vinho: '#7c2a3a',
    bordo: '#7c2a3a',
    nude: '#dcbfa6',
    rosa: '#e3a9b7',
    vermelho: '#b1352f',
    azul: '#33506b',
    'azul marinho': '#1f2c40',
    verde: '#4f6f52',
    cinza: '#9a938a',
    amarelo: '#dcb84f',
    laranja: '#c96f34',
  };

  function colorToHex(name) {
    if (!name) return null;
    return COLOR_HEX_MAP[name.trim().toLowerCase()] || null;
  }

  function uniqueColors(variants) {
    const seen = new Set();
    const list = [];
    (variants || []).forEach((v) => {
      const c = (v.color || '').trim();
      if (c && !seen.has(c.toLowerCase())) {
        seen.add(c.toLowerCase());
        list.push(c);
      }
    });
    return list;
  }

  function colorDotsHtml(variants) {
    const colors = uniqueColors(variants);
    if (!colors.length) return '';
    const shown = colors.slice(0, 5);
    const dots = shown
      .map((c) => {
        const hex = colorToHex(c);
        return hex
          ? `<span class="color-dot" style="background-color:${hex}" title="${escapeHtml(c)}"></span>`
          : `<span class="color-dot color-dot-label" title="${escapeHtml(c)}">${escapeHtml(c.slice(0, 3))}</span>`;
      })
      .join('');
    const extra = colors.length > shown.length ? `<span class="color-dot-more">+${colors.length - shown.length}</span>` : '';
    return `<div class="color-dot-row">${dots}${extra}</div>`;
  }

  function isLowStock(p, soldOut) {
    return !!p.hasVariants && !soldOut && typeof p.totalStock === 'number' && p.totalStock > 0 && p.totalStock <= LOW_STOCK_THRESHOLD;
  }

  // ---------- filtros de tamanho/cor/preço + ordenação (vitrine) ----------
  const CLOTHING_SIZE_ORDER = ['PP', 'P', 'M', 'G', 'GG', 'GG1', 'GG2', 'XG', 'ÚNICO', 'UNICO', 'U'];

  // Tamanhos numéricos (calçados) ordenam por valor; tamanhos de roupa seguem a ordem PP→GG;
  // qualquer coisa fora desses dois grupos cai em ordem alfabética como último recurso.
  function compareSizes(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    const ia = CLOTHING_SIZE_ORDER.indexOf(a.toUpperCase());
    const ib = CLOTHING_SIZE_ORDER.indexOf(b.toUpperCase());
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, 'pt-BR');
  }

  function allVariants() {
    return PRODUCTS.flatMap((p) => p.variants || []);
  }

  function availableSizes() {
    const seen = new Set();
    const list = [];
    allVariants().forEach((v) => {
      const s = (v.size || '').trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        list.push(s);
      }
    });
    return list.sort(compareSizes);
  }

  function availableColors() {
    return uniqueColors(allVariants());
  }

  // Limites não se sobrepõem: min exclusivo (exceto a 1ª faixa) e max inclusivo, exceto a última (sem teto).
  const PRICE_RANGES = [
    { id: 'until-150', label: 'Até R$ 150', min: -Infinity, max: 150 },
    { id: '150-300', label: 'R$ 150 a R$ 300', min: 150, max: 300 },
    { id: '300-500', label: 'R$ 300 a R$ 500', min: 300, max: 500 },
    { id: 'above-500', label: 'Acima de R$ 500', min: 500, max: Infinity },
  ];

  let currentSize = '';
  let currentColor = '';
  let currentPriceRange = '';
  let currentSort = 'recent';

  function cartSubtotal(keys) {
    return keys.reduce((sum, key) => {
      const entry = cart[key];
      if (!entry) return sum;
      const p = PRODUCTS.find((x) => x.id === entry.productId);
      if (!p) return sum;
      const { price } = getEffective(p);
      return price != null ? sum + price * entry.qty : sum;
    }, 0);
  }

  // Escolhe o maior desconto entre cupom, Pix e quantidade de itens — nunca soma os três
  // (mantém o total previsível: "o melhor desconto é aplicado automaticamente").
  function cartDiscountInfo(keys) {
    const subtotal = cartSubtotal(keys);
    // só itens com preço contam pra faixa de desconto por quantidade — peças "sob consulta"
    // não entram no subtotal, então não podem empurrar o carrinho pra uma faixa maior.
    const itemCount = keys.reduce((sum, key) => {
      const entry = cart[key];
      if (!entry) return sum;
      const p = PRODUCTS.find((x) => x.id === entry.productId);
      const { price } = p ? getEffective(p) : { price: null };
      return price != null ? sum + entry.qty : sum;
    }, 0);
    const coupon = activeCoupon();
    return window.PromoEngine.bestDiscount(subtotal, { coupon, itemCount, payment: selectedPayment });
  }

  function cartFinalTotal(keys) {
    const subtotal = cartSubtotal(keys);
    const discount = cartDiscountInfo(keys);
    return discount ? Math.max(0, subtotal - discount.amount) : subtotal;
  }

  // ---------- frete (tabela por UF cadastrada no admin) ----------
  // `applicable: false` cobre tanto "retirada em loja" quanto "nenhuma regra configurada/cadastrada
  // pra essa UF" — em ambos os casos o frete não entra no total nem na mensagem do pedido.
  function shippingQuote(keys) {
    if (selectedDelivery !== 'Entrega') return { applicable: false, cost: 0, label: '', free: false };
    const active = SHIPPING_RULES.filter((r) => r.active);
    if (!active.length) return { applicable: false, cost: 0, label: '', free: false };
    const uf = (address.estado || '').trim().toUpperCase();
    const rule = active.find((r) => r.uf.toUpperCase() === uf) || active.find((r) => r.uf === '*');
    if (!rule) return { applicable: false, cost: 0, label: '', free: false };
    const subtotal = cartSubtotal(keys);
    const free = rule.freeAbove != null && subtotal >= Number(rule.freeAbove);
    return { applicable: true, cost: free ? 0 : Number(rule.price), label: rule.label || '', free };
  }

  // Antes de a cliente escolher UF (ou de escolher "Entrega"), usa o menor valor de freeAbove
  // entre as regras ativas como estimativa — assim que o CEP/UF é preenchido, passa a usar a
  // regra específica daquela UF (ou o fallback '*'), que pode ser diferente da estimativa inicial.
  function freeShippingInfo(keys) {
    const active = SHIPPING_RULES.filter((r) => r.active && r.freeAbove != null);
    if (!active.length) return null;
    const uf = (address.estado || '').trim().toUpperCase();
    const specific = selectedDelivery === 'Entrega' && uf
      ? active.find((r) => r.uf.toUpperCase() === uf) || active.find((r) => r.uf === '*')
      : null;
    const target = Number(specific ? specific.freeAbove : Math.min(...active.map((r) => Number(r.freeAbove))));
    if (!Number.isFinite(target) || target <= 0) return null;
    const subtotal = cartSubtotal(keys);
    return { target, subtotal, remaining: Math.max(0, target - subtotal), reached: subtotal >= target };
  }

  const waLink = (text) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;

  // basic greeting links used across the page
  document.querySelectorAll('#quickWhats, #ctaWhats, #footerWhats, #floatWhats').forEach((el) => {
    el.href = waLink('Olá! Vim pelo site da By NaNa e queria saber mais sobre as peças 💛');
  });

  // ---------- newsletter (captura de contato no rodapé) ----------
  const newsletterForm = document.getElementById('newsletterForm');
  if (newsletterForm) {
    const newsletterInput = document.getElementById('newsletterInput');
    const newsletterMsg = document.getElementById('newsletterMsg');
    newsletterForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = newsletterInput.value.trim();
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
      const digits = raw.replace(/\D/g, '');
      const channel = isEmail ? 'email' : digits.length >= 10 ? 'whatsapp' : null;
      newsletterMsg.hidden = false;
      if (!channel) {
        newsletterMsg.textContent = 'Informe um e-mail ou WhatsApp válido.';
        newsletterMsg.className = 'newsletter-msg is-error';
        return;
      }
      const submitBtn = newsletterForm.querySelector('button');
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact: channel === 'whatsapp' ? digits : raw, channel }),
        });
        if (!res.ok) throw new Error();
        newsletterMsg.textContent = 'Prontinho! Use o cupom BEMVINDA10 e ganhe 10% na sua primeira compra 💛';
        newsletterMsg.className = 'newsletter-msg is-ok';
        newsletterForm.reset();
        window.byNanaAnalytics?.trackLead('newsletter_footer');
      } catch {
        newsletterMsg.textContent = 'Não deu pra cadastrar agora. Tenta de novo em instantes.';
        newsletterMsg.className = 'newsletter-msg is-error';
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ---------- "avise-me quando chegar" (PDP, variação esgotada) ----------
  const pdpRestockBlock = document.getElementById('pdpRestock');
  const pdpRestockToggle = document.getElementById('pdpRestockToggle');
  const pdpRestockForm = document.getElementById('pdpRestockForm');
  const pdpRestockSelect = document.getElementById('pdpRestockVariant');
  const pdpRestockContact = document.getElementById('pdpRestockContact');
  const pdpRestockMsg = document.getElementById('pdpRestockMsg');

  // Chamado a cada render da PDP (initProductPage) com as variações esgotadas do produto —
  // o <select> é refeito do zero pra nunca ficar com opções de um produto anterior.
  function setupRestockNotify(soldOutVariants) {
    if (!pdpRestockBlock) return;
    pdpRestockBlock.hidden = soldOutVariants.length === 0;
    pdpRestockForm.hidden = true;
    pdpRestockMsg.hidden = true;
    pdpRestockSelect.innerHTML = soldOutVariants
      .map((v) => `<option value="${v.id}">${escapeHtml(variantLabel(v))}</option>`)
      .join('');
  }

  if (pdpRestockToggle) {
    pdpRestockToggle.addEventListener('click', () => {
      pdpRestockForm.hidden = !pdpRestockForm.hidden;
      pdpRestockMsg.hidden = true;
    });
  }

  if (pdpRestockForm) {
    pdpRestockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const variantId = pdpRestockSelect.value;
      const raw = pdpRestockContact.value.trim();
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
      const digits = raw.replace(/\D/g, '');
      const channel = isEmail ? 'email' : digits.length >= 10 ? 'whatsapp' : null;
      pdpRestockMsg.hidden = false;
      if (!variantId || !channel) {
        pdpRestockMsg.textContent = 'Informe um e-mail ou WhatsApp válido.';
        pdpRestockMsg.className = 'pdp-restock-msg is-error';
        return;
      }
      const submitBtn = pdpRestockForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/stock-notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variantId, contact: channel === 'whatsapp' ? digits : raw, channel }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Não foi possível registrar o aviso.');
        pdpRestockMsg.textContent = 'Prontinho! Avisamos você assim que chegar. 💛';
        pdpRestockMsg.className = 'pdp-restock-msg is-ok';
        pdpRestockForm.reset();
        pdpRestockForm.hidden = true;
      } catch (err) {
        pdpRestockMsg.textContent = err.message;
        pdpRestockMsg.className = 'pdp-restock-msg is-error';
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ---------- cart (sacola) ----------
  const CART_KEY = 'bynana_cart';
  let cart = JSON.parse(localStorage.getItem(CART_KEY) || '{}');

  // migra o formato antigo ({ [productId]: quantidade }) para o novo ({ [chave]: {productId,variantId,qty} })
  // — sem isso, quem já tinha itens na sacola antes desta atualização veria a sacola "sumir".
  (function migrateCartFormat() {
    let changed = false;
    const next = {};
    Object.entries(cart).forEach(([k, v]) => {
      if (typeof v === 'number') {
        next[cartKey(k, null)] = { productId: k, variantId: null, qty: v };
        changed = true;
      } else if (v && typeof v === 'object' && v.productId) {
        next[k] = v;
      }
    });
    cart = next;
    if (changed) localStorage.setItem(CART_KEY, JSON.stringify(cart));
  })();

  // ---------- favorites ----------
  const FAV_KEY = 'bynana_favs';
  let favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
  function saveFavs() {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  }
  function toggleFav(id) {
    const nowFav = !favs.has(id);
    if (nowFav) favs.add(id);
    else favs.delete(id);
    saveFavs();
    renderGrid(currentFilter, currentSearch);
    renderNovidades();
    renderBestSellers();
    syncPdpFavButton();
    if (!document.getElementById('profilePanel-favoritos').hidden) renderProfileFavorites();

    // Cliente logado: espelha no servidor em segundo plano — falha aqui não quebra a UI
    // (o estado local já é a fonte de verdade da tela; o próximo login resincroniza tudo).
    if (currentCustomer) {
      const token = getCustomerToken();
      fetch('/api/customers/favorites', {
        method: nowFav ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, productId: id }),
      }).catch(() => {});
    }
  }

  // Mantém o botão de favoritar da página de produto (#pdpFav) em sincronia — só existe em
  // produto.html, então não faz nada nas demais páginas.
  function syncPdpFavButton() {
    const favBtn = document.getElementById('pdpFav');
    if (!favBtn || !favBtn.dataset.id) return;
    const isFav = favs.has(favBtn.dataset.id);
    favBtn.textContent = isFav ? '♥ Nos favoritos' : '♡ Salvar nos favoritos';
    favBtn.classList.toggle('is-fav', isFav);
  }

  // ---------- catalog render ----------
  const grid = document.getElementById('productGrid');
  const emptyState = document.getElementById('emptyState');
  let currentFilter = 'Todos';
  let currentSearch = '';

  // estrelas cheias/vazias pra uma nota 0-5 (ex.: 3.6 -> ★★★★☆, arredondado pro inteiro mais próximo).
  function starsHtml(rating) {
    const full = Math.round(rating);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  }

  function isProductSoldOut(p) {
    const variants = p.variants || [];
    return !!p.hasVariants && !variants.some((v) => v.stock > 0);
  }

  function shuffled(list) {
    return list
      .map((item) => [Math.random(), item])
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item);
  }

  // "Combine também" (PDP): mesma categoria+coleção primeiro (visual mais coerente), depois
  // mesma categoria em geral; esgotados ficam de fora (não adianta sugerir o que não dá pra comprar).
  function pickRelatedProducts(p) {
    const candidates = PRODUCTS.filter((x) => x.id !== p.id && x.category === p.category && !isProductSoldOut(x));
    const sameCollection = p.collection ? candidates.filter((x) => x.collection === p.collection) : [];
    const rest = candidates.filter((x) => !sameCollection.includes(x));
    return [...shuffled(sameCollection), ...shuffled(rest)].slice(0, 4);
  }

  function productCard(p) {
    const div = document.createElement('div');
    div.className = 'product-card';
    div.dataset.category = p.category;
    const isFav = favs.has(p.id);
    const { price, promo } = getEffective(p);
    const priceHtml =
      p.price == null
        ? `<span class="product-price consult">Sob consulta</span>`
        : promo
        ? `<span class="product-price-old">${money(p.price)}</span><span class="product-price is-promo">${money(price)}</span>`
        : `<span class="product-price">${money(price)}</span>`;

    // produto sem nenhuma variação cadastrada se comporta exatamente como antes: sem seletor,
    // sempre disponível para adicionar.
    const variants = p.variants || [];
    const inStock = variants.filter((v) => v.stock > 0);
    const soldOut = p.hasVariants && inStock.length === 0;
    const defaultVariant = inStock[0] || null;
    const lowStock = isLowStock(p, soldOut);
    const variantHtml = p.hasVariants
      ? `<div class="variant-picker">
          ${variants
            .map(
              (v) => `<button type="button" class="variant-chip${v.stock <= 0 ? ' is-soldout' : ''}${defaultVariant && v.id === defaultVariant.id ? ' is-active' : ''}" data-variant-id="${v.id}" ${v.stock <= 0 ? 'disabled' : ''}>${escapeHtml(variantLabel(v))}</button>`
            )
            .join('')}
        </div>`
      : '';

    div.innerHTML = `
      <a class="product-media" href="/produto/${p.id}">
        <img src="${escapeHtml(p.img)}" alt="${escapeHtml(p.name)}" loading="lazy" />
        <div class="product-badges">
          <span class="product-tag">${escapeHtml(p.tag)}</span>
          ${promo ? `<span class="discount-badge">-${promo.percent}%</span>` : ''}
          ${soldOut ? `<span class="soldout-badge">Esgotado</span>` : ''}
          ${lowStock ? `<span class="low-stock-badge">Últimas unidades</span>` : ''}
        </div>
        <button class="fav-btn ${isFav ? 'is-fav' : ''}" data-id="${p.id}" aria-label="Favoritar">${isFav ? '♥' : '♡'}</button>
      </a>
      <div class="product-body">
        <span class="product-cat">${escapeHtml(p.brand)}${p.collection ? ` · ${escapeHtml(p.collection)}` : ''}</span>
        <h3 class="product-name">${escapeHtml(p.name)}</h3>
        ${p.rating ? `<div class="pdp-rating-row product-rating-row"><span class="pdp-rating-stars">${starsHtml(p.rating)}</span><span class="pdp-rating-count">${p.rating.toFixed(1)} (${p.reviewCount})</span></div>` : ''}
        <div class="product-price-row">${priceHtml}</div>
        ${p.price != null ? `<p class="installments">${installmentText(price)}</p>` : ''}
        ${p.price != null ? `<p class="pix-hint">${pixHintText(price)}</p>` : ''}
        ${colorDotsHtml(variants)}
        ${variantHtml}
        <div class="product-actions">
          <button class="add-btn${soldOut ? ' is-soldout' : ''}" data-id="${p.id}" ${defaultVariant ? `data-variant-id="${defaultVariant.id}"` : ''} ${soldOut ? 'disabled' : ''}>${soldOut ? 'Esgotado' : 'Adicionar à sacola'}</button>
          <a class="ask-btn" target="_blank" rel="noopener" href="${waLink(
            `Olá! Tenho interesse na peça "${p.name}" que vi no catálogo By NaNa. Pode me passar mais detalhes?`
          )}" aria-label="Perguntar no WhatsApp">${WA_ICON}</a>
        </div>
      </div>
    `;
    return div;
  }

  // ---------- vistos recentemente (histórico local, sem conta necessária) ----------
  const RECENT_KEY = 'bynana_recent';
  const RECENT_MAX = 10;

  function trackRecentlyViewed(id) {
    let ids = [];
    try {
      ids = JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
    } catch {
      ids = [];
    }
    ids = [id, ...ids.filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  }

  // excludeId: na página de produto, não mostra o próprio produto na lista.
  function renderRecentlyViewed(excludeId) {
    const section = document.getElementById('recentlyViewedSection');
    const grid = document.getElementById('recentlyViewedGrid');
    if (!section || !grid) return;
    let ids = [];
    try {
      ids = JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
    } catch {
      ids = [];
    }
    const items = ids
      .filter((id) => id !== excludeId)
      .map((id) => PRODUCTS.find((p) => p.id === id))
      .filter(Boolean)
      .slice(0, 8);
    section.hidden = items.length === 0;
    grid.innerHTML = '';
    items.forEach((p) => grid.appendChild(productCard(p)));
  }

  function matchesSearch(p, term) {
    if (!term) return true;
    const haystack = `${p.name} ${p.brand} ${p.category} ${p.tag} ${p.collection || ''}`.toLowerCase();
    return haystack.includes(term);
  }

  function skeletonCard() {
    const div = document.createElement('div');
    div.className = 'skeleton-card';
    div.innerHTML = `
      <div class="skeleton-media"></div>
      <div class="skeleton-lines">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line"></div>
      </div>
    `;
    return div;
  }

  function renderSkeleton(count) {
    if (!grid) return; // página de produto não tem vitrine — nada a esqueletizar
    grid.innerHTML = '';
    emptyState.hidden = true;
    for (let i = 0; i < count; i++) grid.appendChild(skeletonCard());
  }

  let currentCollection = '';

  function renderGrid(filter, search) {
    currentFilter = filter;
    currentSearch = search || '';
    if (!grid) return; // página de produto não tem vitrine
    grid.innerHTML = '';
    let list = PRODUCTS;
    if (filter === 'Favoritos') list = list.filter((p) => favs.has(p.id));
    else if (filter !== 'Todos') list = list.filter((p) => p.category === filter);
    if (currentCollection) list = list.filter((p) => p.collection === currentCollection);
    list = list.filter((p) => matchesSearch(p, currentSearch));
    if (currentSize) list = list.filter((p) => (p.variants || []).some((v) => v.size === currentSize && v.stock > 0));
    if (currentColor) {
      list = list.filter((p) => (p.variants || []).some((v) => (v.color || '').trim().toLowerCase() === currentColor.toLowerCase()));
    }
    if (currentPriceRange) {
      const range = PRICE_RANGES.find((r) => r.id === currentPriceRange);
      if (range) {
        list = list.filter((p) => {
          const { price } = getEffective(p);
          return price != null && price > range.min && price <= range.max;
        });
      }
    }
    if (currentSort === 'price-asc' || currentSort === 'price-desc') {
      list = [...list].sort((a, b) => {
        const pa = getEffective(a).price;
        const pb = getEffective(b).price;
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return currentSort === 'price-asc' ? pa - pb : pb - pa;
      });
    }

    if (list.length === 0) {
      if (currentSearch) {
        emptyState.textContent = `Nenhuma peça encontrada para "${search}". Tente outro termo.`;
      } else if (filter === 'Favoritos') {
        emptyState.textContent = 'Você ainda não salvou nenhuma peça nos favoritos. Toque no ♡ de uma peça para guardá-la aqui.';
      } else if (currentSize || currentColor || currentPriceRange) {
        emptyState.textContent = 'Nenhuma peça encontrada com esses filtros. Tente limpar algum deles.';
      } else {
        emptyState.textContent = 'Nenhuma peça encontrada por aqui. Que tal ver outra categoria?';
      }
    }
    emptyState.hidden = list.length !== 0;
    list.forEach((p) => grid.appendChild(productCard(p)));
    syncAddButtons();
    renderCategorySeoBlock(filter);
  }

  // ---------- filters + search (built dynamically from categories/collections) ----------
  const filtersEl = document.getElementById('filters');
  const catGrid = document.querySelector('.cat-grid');
  const collectionWrap = document.getElementById('collectionFilterWrap');
  const categorySeoBlock = document.getElementById('categorySeoBlock');
  const categorySeoText = document.getElementById('categorySeoText');
  const categoryFaq = document.getElementById('categoryFaq');

  // texto de SEO + FAQ da categoria em foco — some quando a categoria não tem conteúdo cadastrado
  // (ex.: "Todos", "Favoritos" ou uma categoria ainda sem texto no admin).
  function renderCategorySeoBlock(filter) {
    const content = CATEGORY_CONTENT.find((c) => c.name === filter);
    const faq = content && Array.isArray(content.faq) ? content.faq : [];
    if (!content || (!content.seoText && !faq.length)) {
      categorySeoBlock.hidden = true;
      return;
    }
    categorySeoText.textContent = content.seoText || '';
    categorySeoText.hidden = !content.seoText;
    categoryFaq.innerHTML = faq
      .map(
        (f) => `
        <details class="category-faq-item">
          <summary>${escapeHtml(f.question)}</summary>
          <p>${escapeHtml(f.answer)}</p>
        </details>`
      )
      .join('');
    categorySeoBlock.hidden = false;
  }

  function setFilter(filter) {
    filtersEl.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('is-active', c.dataset.filter === filter));
    renderGrid(filter, currentSearch);
  }

  function buildFilters() {
    filtersEl.innerHTML = '';
    const items = [{ label: 'Todos', filter: 'Todos', cls: '' }]
      .concat(CATEGORIES.map((c) => ({ label: c, filter: c, cls: '' })))
      .concat([{ label: '♥ Favoritos', filter: 'Favoritos', cls: 'filter-fav' }]);
    items.forEach((it) => {
      const btn = document.createElement('button');
      btn.className = `filter-chip ${it.cls}${it.filter === 'Todos' ? ' is-active' : ''}`.trim();
      btn.dataset.filter = it.filter;
      btn.textContent = it.label;
      btn.addEventListener('click', () => setFilter(it.filter));
      filtersEl.appendChild(btn);
    });
  }

  function buildCatCards() {
    if (!catGrid) return;
    catGrid.innerHTML = '';
    const fallbackImg = 'assets/img/processed/logo.png';
    CATEGORIES.forEach((cat) => {
      const rep = PRODUCTS.find((p) => p.category === cat);
      const btn = document.createElement('button');
      btn.className = 'cat-card';
      btn.dataset.filter = cat;
      btn.innerHTML = `<img src="${rep ? rep.img : fallbackImg}" alt="${escapeHtml(cat)}" /><span>${escapeHtml(cat)}</span>`;
      btn.addEventListener('click', () => {
        setFilter(cat);
        document.getElementById('colecao').scrollIntoView({ behavior: 'smooth' });
      });
      catGrid.appendChild(btn);
    });
    const allBtn = document.createElement('button');
    allBtn.className = 'cat-card';
    allBtn.dataset.filter = 'Todos';
    allBtn.innerHTML = `<img src="${PRODUCTS[0] ? PRODUCTS[0].img : fallbackImg}" alt="Ver tudo" /><span>Ver tudo</span>`;
    allBtn.addEventListener('click', () => {
      setFilter('Todos');
      document.getElementById('colecao').scrollIntoView({ behavior: 'smooth' });
    });
    catGrid.appendChild(allBtn);
  }

  function buildCollectionFilter() {
    if (!collectionWrap) return;
    collectionWrap.innerHTML = '';
    if (!COLLECTIONS.length) return;
    const select = document.createElement('select');
    select.className = 'collection-select';
    select.setAttribute('aria-label', 'Filtrar por coleção');
    select.innerHTML = `<option value="">Todas as coleções</option>${COLLECTIONS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}`;
    select.addEventListener('change', () => {
      currentCollection = select.value;
      renderGrid(currentFilter, currentSearch);
    });
    collectionWrap.appendChild(select);
  }

  // ---------- filtros de tamanho/cor/preço + ordenação ----------
  const sizeFiltersEl = document.getElementById('sizeFilters');
  const colorFiltersEl = document.getElementById('colorFilters');
  const priceFilterSelect = document.getElementById('priceFilterSelect');
  const sortSelect = document.getElementById('sortSelect');
  const clearFiltersBtn = document.getElementById('clearFiltersBtn');

  function buildSecondaryFilters() {
    if (!sizeFiltersEl || !colorFiltersEl || !priceFilterSelect || !sortSelect) return;

    const sizes = availableSizes();
    sizeFiltersEl.innerHTML =
      `<button type="button" class="filter-chip filter-chip-sm is-active" data-size="">Todos os tamanhos</button>` +
      sizes.map((s) => `<button type="button" class="filter-chip filter-chip-sm" data-size="${s}">${s}</button>`).join('');
    sizeFiltersEl.querySelectorAll('[data-size]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentSize = btn.dataset.size;
        sizeFiltersEl.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderGrid(currentFilter, currentSearch);
      });
    });

    const colors = availableColors();
    colorFiltersEl.innerHTML =
      `<button type="button" class="color-filter-chip is-active" data-color="" title="Todas as cores"><span class="color-dot color-dot-label">Tudo</span></button>` +
      colors
        .map((c) => {
          const hex = colorToHex(c);
          const swatch = hex
            ? `<span class="color-dot" style="background-color:${hex}"></span>`
            : `<span class="color-dot color-dot-label">${escapeHtml(c.slice(0, 3))}</span>`;
          return `<button type="button" class="color-filter-chip" data-color="${escapeHtml(c)}" title="${escapeHtml(c)}" aria-label="Filtrar por cor ${escapeHtml(c)}">${swatch}</button>`;
        })
        .join('');
    colorFiltersEl.querySelectorAll('[data-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentColor = btn.dataset.color;
        colorFiltersEl.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderGrid(currentFilter, currentSearch);
      });
    });

    priceFilterSelect.innerHTML =
      `<option value="">Qualquer preço</option>` + PRICE_RANGES.map((r) => `<option value="${r.id}">${r.label}</option>`).join('');
    priceFilterSelect.addEventListener('change', () => {
      currentPriceRange = priceFilterSelect.value;
      renderGrid(currentFilter, currentSearch);
    });

    sortSelect.innerHTML = `
      <option value="recent">Mais recentes</option>
      <option value="price-asc">Menor preço</option>
      <option value="price-desc">Maior preço</option>
    `;
    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value;
      renderGrid(currentFilter, currentSearch);
    });

    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', () => {
        currentSize = '';
        currentColor = '';
        currentPriceRange = '';
        currentSort = 'recent';
        sizeFiltersEl.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('is-active', b.dataset.size === ''));
        colorFiltersEl.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('is-active', b.dataset.color === ''));
        priceFilterSelect.value = '';
        sortSelect.value = 'recent';
        renderGrid(currentFilter, currentSearch);
      });
    }
  }

  // ---------- mega-menu (categorias agrupadas no header) ----------
  const megaMenuEl = document.getElementById('megaMenu');

  function buildMegaMenu() {
    if (!megaMenuEl) return;
    if (!CATEGORY_GROUPS.length) {
      megaMenuEl.innerHTML = '<p class="mega-menu-empty">Nenhuma categoria cadastrada ainda.</p>';
      return;
    }
    const groups = new Map();
    CATEGORY_GROUPS.forEach((c) => {
      const key = c.groupName || 'Categorias';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c.name);
    });
    const columnsHtml = [...groups.entries()]
      .map(
        ([groupName, names]) => `
        <div class="mega-menu-col">
          <p class="mega-menu-col-title">${escapeHtml(groupName)}</p>
          <ul>${names.map((n) => `<li><a href="#colecao" data-cat="${escapeHtml(n)}">${escapeHtml(n)}</a></li>`).join('')}</ul>
        </div>`
      )
      .join('');
    megaMenuEl.innerHTML = `<div class="mega-menu-columns">${columnsHtml}</div>`;
  }

  megaMenuEl.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-cat]');
    if (!link) return;
    e.preventDefault();
    const colecao = document.getElementById('colecao');
    if (colecao && grid) {
      setFilter(link.dataset.cat);
      colecao.scrollIntoView({ behavior: 'smooth' });
    } else {
      location.href = `/?categoria=${encodeURIComponent(link.dataset.cat)}#colecao`;
    }
  });

  // ---------- novidades (últimos produtos cadastrados) ----------
  const novidadesGrid = document.getElementById('novidadesGrid');
  function renderNovidades() {
    if (!novidadesGrid) return;
    novidadesGrid.innerHTML = '';
    NOVIDADES.forEach((p) => novidadesGrid.appendChild(productCard(p)));
  }

  // ---------- mais vendidos (prova social — vem de /api/data, sem receita/dado sensível) ----------
  const bestSellersSection = document.getElementById('bestSellers');
  const bestSellersGrid = document.getElementById('bestSellersGrid');
  function renderBestSellers() {
    if (!bestSellersGrid || !bestSellersSection) return;
    // junta com PRODUCTS no client: um produto vendido e depois removido do catálogo
    // simplesmente não aparece, em vez de quebrar a seção.
    const products = BEST_SELLERS.map((b) => PRODUCTS.find((p) => p.id === b.productId)).filter(Boolean);
    bestSellersSection.hidden = products.length === 0;
    bestSellersGrid.innerHTML = '';
    products.forEach((p) => bestSellersGrid.appendChild(productCard(p)));
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // `searchInput` só existe na vitrine (index.html) — na página de produto (produto.html)
  // esse elemento não existe, então o listener e a busca em si ficam condicionados a ele.
  const searchInput = document.getElementById('searchInput');
  const debouncedSearch = debounce(() => {
    renderGrid(currentFilter, searchInput.value.trim().toLowerCase());
  }, 220);
  if (searchInput) searchInput.addEventListener('input', debouncedSearch);

  // ---------- busca no cabeçalho (espelha a busca do catálogo; existe em toda página) ----------
  const headerSearchForm = document.getElementById('headerSearchForm');
  const headerSearchInput = document.getElementById('headerSearchInput');
  headerSearchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const term = headerSearchInput.value.trim();
    const colecao = document.getElementById('colecao');
    if (colecao && searchInput) {
      // já está na vitrine: filtra ali mesmo, sem recarregar a página.
      searchInput.value = headerSearchInput.value;
      renderGrid(currentFilter, term.toLowerCase());
      colecao.scrollIntoView({ behavior: 'smooth' });
    } else {
      // ex.: buscando a partir da página de produto — volta pra home já filtrando.
      location.href = `/?busca=${encodeURIComponent(term)}#colecao`;
    }
  });

  const bagCount = document.getElementById('bagCount');
  const bagShippingProgressEl = document.getElementById('bagShippingProgress');
  const bagShippingProgressTextEl = document.getElementById('bagShippingProgressText');
  const bagShippingProgressFillEl = document.getElementById('bagShippingProgressFill');
  const bagItemsEl = document.getElementById('bagItems');
  const bagUpsellEl = document.getElementById('bagUpsell');
  const bagTotalEl = document.getElementById('bagTotal');
  const bagSubtotalRow = document.getElementById('bagSubtotalRow');
  const bagSubtotalEl = document.getElementById('bagSubtotal');
  const bagDiscountRow = document.getElementById('bagDiscountRow');
  const bagDiscountLabelEl = document.getElementById('bagDiscountLabel');
  const bagDiscountValueEl = document.getElementById('bagDiscountValue');
  const bagShippingRow = document.getElementById('bagShippingRow');
  const bagShippingLabelEl = document.getElementById('bagShippingLabel');
  const bagShippingValueEl = document.getElementById('bagShippingValue');
  const mobileBar = document.getElementById('mobileBar');
  const mobileBarText = document.getElementById('mobileBarText');
  const checkoutBtn = document.getElementById('bagCheckout');
  const bagFormError = document.getElementById('bagFormError');

  function saveCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    renderCart();
  }

  // ---------- checkout details: pagamento, retirada/entrega, endereço ----------
  const bagDetails = document.getElementById('bagDetails');
  const bagAddress = document.getElementById('bagAddress');
  const bagAddressFields = document.getElementById('bagAddressFields');
  const cepInput = document.getElementById('cepInput');
  const cepStatus = document.getElementById('cepStatus');

  let selectedPayment = '';
  let selectedDelivery = '';
  const address = { cep: '', rua: '', numero: '', complemento: '', bairro: '', cidade: '', estado: '' };

  function updateChipStyles(groupName) {
    document.querySelectorAll(`.bag-chip input[name="${groupName}"]`).forEach((input) => {
      input.closest('.bag-chip').classList.toggle('is-active', input.checked);
    });
  }

  document.querySelectorAll('input[name="payment"]').forEach((input) => {
    input.addEventListener('change', () => {
      selectedPayment = input.value;
      updateChipStyles('payment');
      bagFormError.hidden = true;
      renderCart();
    });
  });

  // ---------- é um presente? ----------
  const bagIsGift = document.getElementById('bagIsGift');
  const bagGiftMessageWrap = document.getElementById('bagGiftMessageWrap');
  const bagGiftMessage = document.getElementById('bagGiftMessage');
  bagIsGift.addEventListener('change', () => {
    bagGiftMessageWrap.hidden = !bagIsGift.checked;
  });

  document.querySelectorAll('input[name="delivery"]').forEach((input) => {
    input.addEventListener('change', () => {
      selectedDelivery = input.value;
      updateChipStyles('delivery');
      bagAddress.hidden = selectedDelivery !== 'Entrega';
      bagFormError.hidden = true;
      renderCart();
    });
  });

  function formatCep(v) {
    const digits = v.replace(/\D/g, '').slice(0, 8);
    return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
  }

  async function lookupCep(digits) {
    cepStatus.textContent = 'Buscando endereço...';
    cepStatus.className = 'bag-cep-status';
    try {
      const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
      const data = await res.json();
      if (data.erro) {
        cepStatus.textContent = 'CEP não encontrado. Confira o número.';
        cepStatus.className = 'bag-cep-status is-error';
        bagAddressFields.hidden = true;
        return;
      }
      address.rua = data.logradouro || '';
      address.bairro = data.bairro || '';
      address.cidade = data.localidade || '';
      address.estado = data.uf || '';
      document.getElementById('addrRua').value = address.rua;
      document.getElementById('addrBairro').value = address.bairro;
      document.getElementById('addrCidade').value = address.cidade;
      document.getElementById('addrEstado').value = address.estado;
      cepStatus.textContent = 'Endereço encontrado ✓';
      cepStatus.className = 'bag-cep-status is-ok';
      bagAddressFields.hidden = false;
      document.getElementById('addrNumero').focus();
      renderCart();
    } catch {
      cepStatus.textContent = 'Não foi possível buscar o CEP agora. Preencha o endereço manualmente.';
      cepStatus.className = 'bag-cep-status is-error';
      bagAddressFields.hidden = false;
    }
  }

  cepInput.addEventListener('input', () => {
    cepInput.value = formatCep(cepInput.value);
    address.cep = cepInput.value;
    bagFormError.hidden = true;
    const digits = cepInput.value.replace(/\D/g, '');
    if (digits.length === 8) {
      lookupCep(digits);
    } else {
      bagAddressFields.hidden = true;
      cepStatus.textContent = '';
      cepStatus.className = 'bag-cep-status';
    }
  });

  [
    ['addrRua', 'rua'],
    ['addrNumero', 'numero'],
    ['addrComplemento', 'complemento'],
    ['addrBairro', 'bairro'],
    ['addrCidade', 'cidade'],
    ['addrEstado', 'estado'],
  ].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('input', (e) => {
      address[key] = e.target.value;
      bagFormError.hidden = true;
      if (key === 'estado') renderCart();
    });
  });

  function validateCheckout() {
    if (!bagNameInput.value.trim()) return 'Informe seu nome.';
    if (!bagPhoneInput.value.trim()) return 'Informe seu telefone.';
    const email = bagEmailInput.value.trim();
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return 'Informe um e-mail válido (ou deixe em branco).';
    if (!selectedPayment) return 'Selecione a forma de pagamento.';
    if (!selectedDelivery) return 'Selecione retirada em loja ou entrega.';
    if (selectedDelivery === 'Entrega') {
      if (address.cep.replace(/\D/g, '').length !== 8) return 'Informe um CEP válido.';
      if (!address.rua.trim()) return 'Preencha a rua (confira o CEP ou digite manualmente).';
      if (!address.numero.trim()) return 'Informe o número do endereço.';
      if (SHIPPING_RULES.some((r) => r.active) && !shippingQuote(Object.keys(cart)).applicable) {
        return 'No momento não entregamos nessa região. Escolha retirada em loja ou fale no WhatsApp.';
      }
    }
    return '';
  }

  function buildOrderMessage(keys) {
    let msg = 'Olá! Vim pelo site da By NaNa e quero fazer um pedido:\n\n';
    msg += `Nome: ${bagNameInput.value.trim()}\nTelefone: ${bagPhoneInput.value.trim()}\n\n`;
    keys.forEach((key) => {
      const entry = cart[key];
      if (!entry) return;
      const p = PRODUCTS.find((x) => x.id === entry.productId);
      if (!p) return;
      const variant = entry.variantId ? (p.variants || []).find((v) => v.id === entry.variantId) : null;
      const { price, promo } = getEffective(p);
      const priceText = promo ? `${money(price)} (de ${money(p.price)})` : money(price);
      const variantText = variant ? ` (${variantLabel(variant)})` : '';
      msg += `• ${entry.qty}x ${p.name}${variantText} — ${priceText}\n`;
    });
    const subtotal = cartSubtotal(keys);
    const discount = cartDiscountInfo(keys);
    const quote = shippingQuote(keys);
    const total = cartFinalTotal(keys) + quote.cost;
    msg += `\nSubtotal (itens com preço): ${money(subtotal)}`;
    if (discount) msg += `\n🏷️ ${discount.label}`;
    if (quote.applicable) {
      msg += `\n🚚 Frete${quote.label ? ` (${quote.label})` : ''}: ${quote.free ? 'Grátis' : money(quote.cost)}`;
    }
    msg += `\nTotal: ${money(total)}`;
    msg += `\n\n💳 Pagamento: ${selectedPayment}`;
    msg += `\n🚚 Entrega: ${selectedDelivery}`;
    if (bagIsGift.checked) {
      const giftMsg = bagGiftMessage.value.trim();
      msg += `\n🎁 Presente${giftMsg ? `: "${giftMsg}"` : ''}`;
    }
    if (selectedDelivery === 'Entrega') {
      const a = address;
      msg += `\n📍 Endereço: ${a.rua}, ${a.numero}${a.complemento ? ` - ${a.complemento}` : ''} - ${a.bairro}, ${a.cidade}/${a.estado} - CEP ${a.cep}`;
    }
    return msg;
  }

  async function persistOrder(keys) {
    const items = keys.map((key) => {
      const entry = cart[key];
      const p = entry ? PRODUCTS.find((x) => x.id === entry.productId) : null;
      const variant = p && entry.variantId ? (p.variants || []).find((v) => v.id === entry.variantId) : null;
      const { price, promo } = p ? getEffective(p) : { price: null, promo: null };
      return {
        id: entry ? entry.productId : key,
        name: p ? p.name : key,
        qty: entry ? entry.qty : 0,
        price,
        listPrice: p ? p.price : null,
        promoId: promo ? promo.promo.id : null,
        variantId: entry ? entry.variantId : null,
        variantLabel: variant ? variantLabel(variant) : null,
      };
    });
    const coupon = activeCoupon();
    const discount = cartDiscountInfo(keys);
    const quote = shippingQuote(keys);
    const payload = {
      customerName: bagNameInput.value.trim(),
      customerPhone: bagPhoneInput.value.trim(),
      customerEmail: bagEmailInput.value.trim(),
      items,
      subtotal: cartSubtotal(keys),
      discount: discount ? discount.amount : 0,
      shipping: quote.cost,
      total: cartFinalTotal(keys) + quote.cost,
      couponCode: coupon ? coupon.code : null,
      paymentMethod: selectedPayment,
      deliveryMethod: selectedDelivery,
      address: selectedDelivery === 'Entrega' ? address : null,
      customerToken: localStorage.getItem(CUSTOMER_TOKEN_KEY) || null,
    };
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Não foi possível reservar o estoque');
    return { orderId: data.orderId, checkoutUrl: data.checkoutUrl || null };
  }

  // Re-sincroniza só os dados de produto/estoque após uma falha de checkout (ex.: estoque
  // insuficiente) — ao contrário de init(), preserva o filtro/busca/coleção que a cliente
  // já tinha escolhido em vez de resetar a vitrine para o estado da URL.
  async function refreshProductData() {
    try {
      const res = await fetch('/api/data', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      WHATSAPP_NUMBER = String(data.whatsappNumber || WHATSAPP_NUMBER).replace(/\D/g, '');
      PRODUCTS = data.products || [];
      PROMOTIONS = data.promotions || [];
      COUPONS = data.coupons || [];
      SHIPPING_RULES = data.shippingRules || [];
    } catch {
      return;
    }
    renderCart();
    if (document.body.dataset.page === 'produto') initProductPage();
    else if (grid) renderGrid(currentFilter, currentSearch);
  }

  function showCheckoutBanner(kind, message) {
    const banner = document.getElementById('checkoutStatusBanner');
    if (!banner) return;
    banner.textContent = message;
    banner.className = `checkout-status-banner is-${kind}`;
    banner.hidden = false;
  }

  // Chamado uma vez no início de init(): trata a volta do checkout hospedado no gateway online
  // (?checkout=success|pending|failure&order=...) — nem todo gateway distingue os três estados
  // na URL de retorno (o PagBank, por ex., sempre manda "pending"; a confirmação real chega
  // pelo webhook no servidor, que dispara o e-mail de "pagamento aprovado"). A página recarrega
  // do zero nesse redirect, então o total/itens da compra pra analytics vêm do localStorage
  // (ver PENDING_PURCHASE_KEY), não da memória — o clique original em "Finalizar" aconteceu num
  // carregamento anterior.
  function handleCheckoutReturn() {
    const params = new URLSearchParams(location.search);
    const state = params.get('checkout');
    if (!state) return;
    const orderId = params.get('order') || '';
    history.replaceState(null, '', location.pathname);

    let pending = null;
    try { pending = JSON.parse(localStorage.getItem(PENDING_PURCHASE_KEY) || 'null'); } catch { pending = null; }

    if (state === 'success' || state === 'pending') {
      if (state === 'success' && pending && pending.orderId === orderId) {
        window.byNanaAnalytics?.trackPurchase(orderId, pending.total, pending.items);
      }
      localStorage.removeItem(PENDING_PURCHASE_KEY);
      cart = {};
      localStorage.removeItem(CART_KEY);
      renderCart();
      showCheckoutBanner(
        state === 'success' ? 'success' : 'pending',
        state === 'success'
          ? `Pagamento aprovado! Seu pedido ${orderId} já está sendo preparado.`
          : `Recebemos seu pedido ${orderId} — assim que o pagamento for confirmado, avisamos por e-mail.`
      );
    } else if (state === 'failure') {
      showCheckoutBanner('failure', `O pagamento do pedido ${orderId} não foi concluído. Você pode tentar de novo pela sacola ou falar com a gente pelo WhatsApp.`);
    }
  }

  // checkoutBtn é um <a>, então "disabled" não impede clique/Enter por si só (e a classe
  // is-loading só bloqueia o mouse via pointer-events, não o teclado) — esta flag é a
  // proteção de verdade contra duplo envio (duplo clique, Enter repetido no link focado).
  let checkoutInFlight = false;
  checkoutBtn.addEventListener('click', (e) => {
    const ids = Object.keys(cart);
    if (ids.length === 0) return;
    e.preventDefault();
    if (checkoutInFlight) return;
    const error = validateCheckout();
    if (error) {
      bagFormError.textContent = error;
      bagFormError.hidden = false;
      return;
    }
    bagFormError.hidden = true;
    checkoutInFlight = true;
    checkoutBtn.classList.add('is-loading');
    checkoutBtn.setAttribute('aria-disabled', 'true');
    checkoutBtn.textContent = 'Enviando...';
    const checkoutTotal = cartFinalTotal(ids) + shippingQuote(ids).cost;
    window.byNanaAnalytics?.trackBeginCheckout(checkoutTotal);
    const checkoutItems = ids.map((key) => {
      const entry = cart[key];
      const p = entry ? PRODUCTS.find((x) => x.id === entry.productId) : null;
      return p ? { id: p.id, name: p.name, qty: entry.qty, price: getEffective(p).price } : null;
    }).filter(Boolean);
    persistOrder(ids).then(({ orderId, checkoutUrl }) => {
      if (checkoutUrl) {
        // Pagamento online: a confirmação de compra (trackPurchase) só acontece quando a
        // cliente volta aprovada (ver handleCheckoutReturn em init()) — antes disso o pagamento
        // ainda nem foi feito, só a sessão de checkout foi criada no gateway.
        localStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ orderId, total: checkoutTotal, items: checkoutItems }));
        window.location.href = checkoutUrl;
        return;
      }
      window.byNanaAnalytics?.trackPurchase(orderId, checkoutTotal, checkoutItems);
      window.open(waLink(buildOrderMessage(ids)), '_blank', 'noopener');
      checkoutInFlight = false;
      checkoutBtn.classList.remove('is-loading');
      checkoutBtn.removeAttribute('aria-disabled');
      checkoutBtn.textContent = 'Finalizar no WhatsApp';
    }).catch((err) => {
      bagFormError.textContent = err.message;
      bagFormError.hidden = false;
      checkoutInFlight = false;
      checkoutBtn.classList.remove('is-loading');
      checkoutBtn.removeAttribute('aria-disabled');
      checkoutBtn.textContent = 'Finalizar no WhatsApp';
      refreshProductData();
    });
  });

  // ---------- coupon input ----------
  const couponInput = document.getElementById('couponInput');
  const couponApplyBtn = document.getElementById('couponApply');
  const couponStatus = document.getElementById('couponStatus');

  function showCouponStatus() {
    const coupon = activeCoupon();
    if (appliedCouponCode && !coupon) {
      appliedCouponCode = '';
      localStorage.removeItem(COUPON_KEY);
    }
    if (coupon) {
      couponStatus.innerHTML = `Cupom <strong>${escapeHtml(coupon.code)}</strong> aplicado ✓ <button type="button" class="coupon-remove">remover</button>`;
      couponStatus.className = 'bag-coupon-status is-ok';
      couponStatus.hidden = false;
      couponInput.value = coupon.code;
    } else {
      couponStatus.hidden = true;
    }
  }

  couponApplyBtn.addEventListener('click', () => {
    const code = couponInput.value.trim();
    if (!code) return;
    const coupon = window.PromoEngine.findCoupon(COUPONS, code);
    if (!coupon) {
      couponStatus.textContent = 'Cupom inválido ou expirado.';
      couponStatus.className = 'bag-coupon-status is-error';
      couponStatus.hidden = false;
      return;
    }
    appliedCouponCode = coupon.code;
    localStorage.setItem(COUPON_KEY, appliedCouponCode);
    showCouponStatus();
    renderCart();
  });

  function syncAddButton(btn) {
    if (btn.classList.contains('is-soldout')) return;
    const key = cartKey(btn.dataset.id, btn.dataset.variantId || null);
    const has = !!cart[key];
    btn.textContent = has ? 'Adicionado ✓' : 'Adicionar à sacola';
    btn.classList.toggle('is-added', has);
  }

  function syncAddButtons() {
    document.querySelectorAll('.add-btn').forEach(syncAddButton);
  }

  function renderCart() {
    const keys = Object.keys(cart);
    const totalQty = keys.reduce((sum, key) => sum + cart[key].qty, 0);
    bagCount.textContent = totalQty;

    const shipInfo = totalQty > 0 ? freeShippingInfo(keys) : null;
    bagShippingProgressEl.hidden = !shipInfo;
    if (shipInfo) {
      const pct = Math.min(100, (shipInfo.subtotal / shipInfo.target) * 100);
      bagShippingProgressFillEl.style.width = `${pct}%`;
      bagShippingProgressEl.classList.toggle('is-complete', shipInfo.reached);
      bagShippingProgressTextEl.innerHTML = shipInfo.reached
        ? '🎉 Você garantiu <strong>frete grátis</strong>!'
        : `Faltam <strong>${money(shipInfo.remaining)}</strong> para o frete grátis`;
    }

    if (totalQty === 0) {
      mobileBar.classList.remove('is-visible');
    } else {
      mobileBarText.textContent = `${totalQty} ${totalQty === 1 ? 'peça' : 'peças'} na sacola`;
      mobileBar.classList.add('is-visible');
    }

    if (keys.length === 0) {
      bagItemsEl.innerHTML = '<p class="bag-empty">Sua sacola está vazia. Adicione uma peça do catálogo 🤍</p>';
    } else {
      bagItemsEl.innerHTML = '';
      keys.forEach((key) => {
        const entry = cart[key];
        const p = PRODUCTS.find((x) => x.id === entry.productId);
        if (!p) return;
        const variant = entry.variantId ? (p.variants || []).find((v) => v.id === entry.variantId) : null;
        const qty = entry.qty;
        const { price, promo } = getEffective(p);
        const priceHtml = promo
          ? `<span class="bag-item-price-old">${money(p.price)}</span><span class="bag-item-price is-promo">${money(price)}</span>`
          : `<span class="bag-item-price">${money(price)}</span>`;
        const row = document.createElement('div');
        row.className = 'bag-item';
        row.innerHTML = `
          <img src="${escapeHtml(p.img)}" alt="${escapeHtml(p.name)}" />
          <div class="bag-item-info">
            <div class="bag-item-name">${escapeHtml(p.name)}${variant ? ` <span class="bag-item-variant">(${escapeHtml(variantLabel(variant))})</span>` : ''}</div>
            ${priceHtml}
            <div class="bag-item-qty">
              <button class="qty-btn" data-key="${key}" data-op="dec" aria-label="Diminuir quantidade de ${escapeHtml(p.name)}">−</button>
              <span>${qty}</span>
              <button class="qty-btn" data-key="${key}" data-op="inc" aria-label="Aumentar quantidade de ${escapeHtml(p.name)}">+</button>
            </div>
            <button class="bag-item-remove" data-key="${key}" aria-label="Remover ${escapeHtml(p.name)} da sacola">remover</button>
          </div>
        `;
        bagItemsEl.appendChild(row);
      });
    }

    const subtotal = cartSubtotal(keys);
    const discount = cartDiscountInfo(keys);
    const quote = shippingQuote(keys);
    const final = cartFinalTotal(keys) + quote.cost;
    const hasDiscount = !!discount && cartFinalTotal(keys) < subtotal;

    bagSubtotalRow.hidden = !hasDiscount;
    bagDiscountRow.hidden = !hasDiscount;
    if (hasDiscount) {
      bagSubtotalEl.textContent = money(subtotal);
      bagDiscountLabelEl.textContent = discount.label;
      bagDiscountValueEl.textContent = `- ${money(discount.amount)}`;
    }
    bagShippingRow.hidden = !quote.applicable;
    if (quote.applicable) {
      bagShippingLabelEl.textContent = quote.label ? `Frete (${quote.label})` : 'Frete';
      bagShippingValueEl.textContent = quote.free ? 'Grátis' : money(quote.cost);
    }
    bagTotalEl.textContent = money(final);

    bagDetails.hidden = keys.length === 0;
    if (keys.length === 0) {
      checkoutBtn.href = waLink('Olá! Vim pelo site da By NaNa 💛');
      bagFormError.hidden = true;
    }

    showCouponStatus();
    syncAddButtons();
    renderCartUpsell(keys);
  }

  // "Leve também": sugestões de menor ticket, não relacionadas ao produto e sim à sacola —
  // exclui o que já está no carrinho e o que está esgotado; nunca mostra se a sacola está vazia.
  function renderCartUpsell(keys) {
    if (!bagUpsellEl) return;
    if (keys.length === 0) {
      bagUpsellEl.hidden = true;
      bagUpsellEl.innerHTML = '';
      return;
    }
    const cartProductIds = new Set(keys.map((key) => cart[key].productId));
    const candidates = UPSELL_PRODUCTS.filter((p) => !cartProductIds.has(p.id) && !isProductSoldOut(p)).slice(0, 4);
    if (!candidates.length) {
      bagUpsellEl.hidden = true;
      bagUpsellEl.innerHTML = '';
      return;
    }
    bagUpsellEl.hidden = false;
    bagUpsellEl.innerHTML = `
      <span class="bag-upsell-title">Leve também</span>
      <div class="bag-upsell-scroll">
        ${candidates
          .map((p) => {
            const variants = p.variants || [];
            const defaultVariant = variants.filter((v) => v.stock > 0)[0] || null;
            const { price } = getEffective(p);
            const priceLabel = p.price == null ? 'Sob consulta' : money(price);
            return `
              <div class="bag-upsell-item">
                <a href="/produto/${p.id}" class="bag-upsell-media"><img src="${escapeHtml(p.img)}" alt="${escapeHtml(p.name)}" loading="lazy" /></a>
                <span class="bag-upsell-name">${escapeHtml(p.name)}</span>
                <span class="bag-upsell-price">${priceLabel}</span>
                <button type="button" class="bag-upsell-add" data-id="${p.id}" ${defaultVariant ? `data-variant-id="${defaultVariant.id}"` : ''} aria-label="Adicionar ${escapeHtml(p.name)} à sacola">+</button>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  const cartAnnouncer = document.getElementById('cartAnnouncer');
  function announce(text) {
    if (cartAnnouncer) cartAnnouncer.textContent = text;
  }

  function addToCart(productId, variantId) {
    const product = PRODUCTS.find((p) => p.id === productId);
    if (!product) return false;

    // produto sem nenhuma variação cadastrada não tem tamanho pra escolher — adiciona direto,
    // sem checagem de estoque por variação (ver cartKey acima).
    if (!product.hasVariants) {
      const key = cartKey(productId, null);
      if (cart[key]) cart[key].qty += 1;
      else cart[key] = { productId, variantId: null, qty: 1 };
      saveCart();
      announce(`${product.name} adicionada à sacola.`);
      window.byNanaAnalytics?.trackAddToCart(product, null);
      return true;
    }

    const variant = variantId ? (product.variants || []).find((v) => v.id === variantId) : null;
    if (!variant) {
      announce('Escolha um tamanho disponível.');
      return false;
    }
    const key = cartKey(productId, variantId);
    if (cart[key] && cart[key].qty >= variant.stock) {
      announce(`Estoque máximo do tamanho ${variantLabel(variant)} atingido.`);
      return false;
    }
    if (cart[key]) cart[key].qty += 1;
    else cart[key] = { productId, variantId: variantId || null, qty: 1 };
    saveCart();
    announce(`${product.name} adicionada à sacola.`);
    window.byNanaAnalytics?.trackAddToCart(product, variant);
    return true;
  }

  document.addEventListener('click', (e) => {
    const favBtn = e.target.closest('.fav-btn, #pdpFav');
    if (favBtn) {
      e.stopPropagation();
      e.preventDefault();
      toggleFav(favBtn.dataset.id);
      return;
    }
    const chip = e.target.closest('.variant-chip');
    if (chip) {
      if (chip.disabled) return;
      const picker = chip.closest('.variant-picker');
      picker.querySelectorAll('.variant-chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      const addBtnForChip =
        picker.id === 'pdpVariantPicker' ? document.getElementById('pdpAdd') : picker.closest('.product-card, .rel-card')?.querySelector('.add-btn');
      if (addBtnForChip) {
        addBtnForChip.dataset.variantId = chip.dataset.variantId;
        syncAddButton(addBtnForChip);
      }
      if (picker.id === 'pdpVariantPicker') {
        const buyBarAdd = document.getElementById('pdpBuyBarAdd');
        if (buyBarAdd) {
          buyBarAdd.dataset.variantId = chip.dataset.variantId;
          syncAddButton(buyBarAdd);
        }
      }
      return;
    }
    const addBtn = e.target.closest('.add-btn');
    if (addBtn) {
      if (addBtn.disabled) return;
      if (addToCart(addBtn.dataset.id, addBtn.dataset.variantId || null)) openBag();
      return;
    }
    // botão "+" da faixa "Leve também" dentro da própria sacola — não usa .add-btn de propósito:
    // syncAddButtons() reescreveria o texto do botão pro padrão "Adicionar à sacola"/"Adicionado ✓",
    // que não cabe no card compacto. O item some da faixa assim que entra na sacola (renderCart).
    const upsellAddBtn = e.target.closest('.bag-upsell-add');
    if (upsellAddBtn) {
      addToCart(upsellAddBtn.dataset.id, upsellAddBtn.dataset.variantId || null);
      return;
    }
    const qtyBtn = e.target.closest('.qty-btn');
    if (qtyBtn) {
      const key = qtyBtn.dataset.key;
      const op = qtyBtn.dataset.op;
      if (!cart[key]) return;
      if (op === 'inc') {
        const entry = cart[key];
        const product = PRODUCTS.find((p) => p.id === entry.productId);
        const variant = product && entry.variantId ? (product.variants || []).find((v) => v.id === entry.variantId) : null;
        if (!variant || entry.qty >= variant.stock) {
          announce('Quantidade máxima disponível em estoque atingida.');
          return;
        }
      }
      cart[key].qty += op === 'inc' ? 1 : -1;
      if (cart[key].qty <= 0) delete cart[key];
      saveCart();
      return;
    }
    const rmBtn = e.target.closest('.bag-item-remove');
    if (rmBtn) {
      delete cart[rmBtn.dataset.key];
      saveCart();
      return;
    }
    const couponRemoveBtn = e.target.closest('.coupon-remove');
    if (couponRemoveBtn) {
      appliedCouponCode = '';
      localStorage.removeItem(COUPON_KEY);
      couponInput.value = '';
      renderCart();
    }
  });

  // ---------- foco em modais (trap de Tab + devolve o foco ao fechar) ----------
  const modalFocusState = new Map();
  function openModalFocus(container) {
    const previousFocus = document.activeElement;
    const getFocusable = () =>
      container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const keydownHandler = (e) => {
      if (e.key !== 'Tab') return;
      const items = getFocusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    container.addEventListener('keydown', keydownHandler);
    modalFocusState.set(container, { previousFocus, keydownHandler });
    const items = getFocusable();
    (items[0] || container).focus();
  }
  function closeModalFocus(container) {
    const state = modalFocusState.get(container);
    if (!state) return;
    container.removeEventListener('keydown', state.keydownHandler);
    modalFocusState.delete(container);
    if (state.previousFocus && typeof state.previousFocus.focus === 'function') {
      state.previousFocus.focus();
    }
  }

  // ---------- bag drawer open/close ----------
  const bagDrawer = document.getElementById('bagDrawer');
  const bagOverlay = document.getElementById('bagOverlay');
  function openBag() {
    prefillBagContact();
    bagDrawer.classList.add('is-open');
    bagOverlay.classList.add('is-open');
    openModalFocus(bagDrawer);
  }
  function closeBag() {
    bagDrawer.classList.remove('is-open');
    bagOverlay.classList.remove('is-open');
    closeModalFocus(bagDrawer);
  }
  document.getElementById('bagBtn').addEventListener('click', openBag);
  document.getElementById('bagClose').addEventListener('click', closeBag);
  bagOverlay.addEventListener('click', closeBag);
  mobileBar.querySelector('#mobileBarBtn').addEventListener('click', openBag);

  // ---------- stories (carrossel de vídeo estilo Instagram) ----------
  const storiesSection = document.getElementById('storiesSection');
  const storiesRail = document.getElementById('storiesRail');
  const storyOverlay = document.getElementById('storyOverlay');
  const storyViewer = document.getElementById('storyViewer');
  const storyProgress = document.getElementById('storyProgress');
  const storyVideo = document.getElementById('storyVideo');
  const storyTitle = document.getElementById('storyTitle');
  const storyCta = document.getElementById('storyCta');
  const storyMuteBtn = document.getElementById('storyMute');

  let currentStoryIndex = -1;
  let storyMuted = true;

  function renderStoriesRail() {
    if (!storiesRail || !storiesSection) return;
    storiesSection.hidden = !STORIES.length;
    storiesRail.innerHTML = '';
    STORIES.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.className = 'story-bubble';
      btn.innerHTML = `
        <span class="story-ring">
          ${
            s.cover
              ? `<img src="${s.cover}" alt="${escapeHtml(s.title || 'Story')}" />`
              : `<video src="${s.video}" preload="metadata" muted playsinline></video>`
          }
        </span>
        ${s.title ? `<span class="story-bubble-label">${escapeHtml(s.title)}</span>` : ''}
      `;
      btn.addEventListener('click', () => openStoryViewer(i));
      storiesRail.appendChild(btn);
    });
  }

  function buildStoryProgress() {
    storyProgress.innerHTML = STORIES.map(() => '<div class="story-progress-bar"><span></span></div>').join('');
  }

  function setStoryProgressState(index, state) {
    const bar = storyProgress.children[index];
    if (!bar) return;
    const fill = bar.querySelector('span');
    bar.classList.toggle('is-active', state === 'active');
    fill.style.transition = 'none';
    fill.style.width = state === 'done' ? '100%' : '0%';
  }

  function playStoryAt(index) {
    STORIES.forEach((_, i) => setStoryProgressState(i, i < index ? 'done' : 'pending'));

    const story = STORIES[index];
    storyTitle.textContent = story.title || '';
    const product = story.productId ? PRODUCTS.find((p) => p.id === story.productId) : null;
    if (product) {
      storyCta.href = `/produto/${product.id}`;
      storyCta.textContent = story.linkLabel && story.linkLabel !== 'Ver mais' ? story.linkLabel : 'Ver produto';
      storyCta.hidden = false;
    } else if (story.linkUrl) {
      storyCta.href = story.linkUrl;
      storyCta.textContent = story.linkLabel || 'Ver mais';
      storyCta.hidden = false;
    } else {
      storyCta.removeAttribute('href');
      storyCta.hidden = true;
    }
    storyVideo.muted = storyMuted;
    storyMuteBtn.classList.toggle('is-unmuted', !storyMuted);
    storyVideo.src = story.video;
    storyVideo.currentTime = 0;
    storyVideo.play().catch(() => {});
  }

  function openStoryViewer(index) {
    if (!STORIES.length) return;
    buildStoryProgress();
    currentStoryIndex = index;
    storyOverlay.classList.add('is-open');
    storyViewer.classList.add('is-open');
    playStoryAt(index);
    openModalFocus(storyViewer);
  }

  function nextStory() {
    if (currentStoryIndex >= STORIES.length - 1) {
      closeStoryViewer();
      return;
    }
    currentStoryIndex += 1;
    playStoryAt(currentStoryIndex);
  }

  function prevStory() {
    currentStoryIndex = Math.max(0, currentStoryIndex - 1);
    playStoryAt(currentStoryIndex);
  }

  function closeStoryViewer() {
    if (!storyViewer.classList.contains('is-open')) return;
    storyOverlay.classList.remove('is-open');
    storyViewer.classList.remove('is-open');
    storyVideo.pause();
    storyVideo.removeAttribute('src');
    storyVideo.load();
    currentStoryIndex = -1;
    closeModalFocus(storyViewer);
  }

  storyVideo.addEventListener('loadedmetadata', () => {
    const bar = storyProgress.children[currentStoryIndex];
    if (!bar) return;
    const fill = bar.querySelector('span');
    fill.style.transition = 'none';
    fill.style.width = '0%';
    void fill.offsetWidth; // força reflow antes de animar a transição
    bar.classList.add('is-active');
    fill.style.transition = `width ${storyVideo.duration}s linear`;
    fill.style.width = '100%';
  });
  storyVideo.addEventListener('ended', nextStory);

  document.getElementById('storyNext').addEventListener('click', nextStory);
  document.getElementById('storyPrev').addEventListener('click', prevStory);
  document.getElementById('storyClose').addEventListener('click', closeStoryViewer);
  storyOverlay.addEventListener('click', closeStoryViewer);
  // O CTA agora é sempre um link real (produto ou linkUrl externo) — a navegação é nativa,
  // só fechamos o viewer antes pra não ficar um modal aberto por cima da próxima página.
  storyCta.addEventListener('click', () => closeStoryViewer());
  storyMuteBtn.addEventListener('click', () => {
    storyMuted = !storyMuted;
    storyVideo.muted = storyMuted;
    storyMuteBtn.classList.toggle('is-unmuted', !storyMuted);
  });

  let storyTouchStartX = 0;
  storyViewer.addEventListener('touchstart', (e) => {
    storyTouchStartX = e.touches[0].clientX;
  });
  storyViewer.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - storyTouchStartX;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) nextStory();
    else prevStory();
  });

  // ---------- conta do cliente (cadastro/login — base do CRM) ----------
  const CUSTOMER_TOKEN_KEY = 'bynana_customer_token';
  const CUSTOMER_KEY = 'bynana_customer';

  const accountBtn = document.getElementById('accountBtn');
  const accountOverlay = document.getElementById('accountOverlay');
  const accountModal = document.getElementById('accountModal');
  const accountViewLogin = document.getElementById('accountViewLogin');
  const accountViewForgot = document.getElementById('accountViewForgot');
  const accountViewSignup = document.getElementById('accountViewSignup');
  const accountViewProfile = document.getElementById('accountViewProfile');
  const loginForm = document.getElementById('loginForm');
  const loginMsg = document.getElementById('loginMsg');
  const forgotForm = document.getElementById('forgotForm');
  const forgotMsg = document.getElementById('forgotMsg');
  const signupForm = document.getElementById('signupForm');
  const signupMsg = document.getElementById('signupMsg');
  const profileName = document.getElementById('profileName');
  const bagNameInput = document.getElementById('bagName');
  const bagPhoneInput = document.getElementById('bagPhone');
  const bagEmailInput = document.getElementById('bagEmail');

  // Dispara quando a cliente sai do campo de e-mail com a sacola preenchida — não em cada
  // tecla digitada — pra registrar a atividade que alimenta o lembrete de carrinho abandonado
  // (ver /api/cart-activity e sweepAbandonedCarts em serve.js). Silencioso: falha aqui nunca
  // deve incomodar quem só está preenchendo o checkout.
  bagEmailInput.addEventListener('blur', () => {
    const email = bagEmailInput.value.trim();
    const keys = Object.keys(cart);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || keys.length === 0) return;
    const items = keys
      .map((key) => {
        const entry = cart[key];
        const p = PRODUCTS.find((x) => x.id === entry.productId);
        return p ? { qty: entry.qty, name: p.name } : null;
      })
      .filter(Boolean);
    fetch('/api/cart-activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: bagNameInput.value.trim(), items, subtotal: cartSubtotal(keys) }),
    }).catch(() => {});
  });

  let currentCustomer = JSON.parse(localStorage.getItem(CUSTOMER_KEY) || 'null');

  function setFormMsg(el, text, kind) {
    el.textContent = text;
    el.className = `account-form-msg ${kind === 'ok' ? 'is-ok' : 'is-error'}`;
    el.hidden = !text;
  }

  function showAccountView(view) {
    accountViewLogin.hidden = view !== 'login';
    accountViewForgot.hidden = view !== 'forgot';
    accountViewSignup.hidden = view !== 'signup';
    accountViewProfile.hidden = view !== 'profile';
    accountModal.classList.toggle('is-profile', view === 'profile');
  }

  function getCustomerToken() {
    return localStorage.getItem(CUSTOMER_TOKEN_KEY);
  }

  function prefillBagContact() {
    if (!currentCustomer) return;
    if (bagNameInput && !bagNameInput.value) {
      bagNameInput.value = `${currentCustomer.firstName} ${currentCustomer.lastName || ''}`.trim();
    }
    if (bagPhoneInput && !bagPhoneInput.value) bagPhoneInput.value = currentCustomer.phone || '';
    if (bagEmailInput && !bagEmailInput.value) bagEmailInput.value = currentCustomer.email || '';
  }

  function updateAccountButton() {
    accountBtn.classList.toggle('is-logged', !!currentCustomer);
    accountBtn.title = currentCustomer ? `Olá, ${currentCustomer.firstName}` : 'Minha conta';
    if (currentCustomer) {
      profileName.textContent = currentCustomer.firstName;
      const profileEmail = document.getElementById('profileEmail');
      const profileAvatar = document.getElementById('profileAvatar');
      if (profileEmail) profileEmail.textContent = currentCustomer.email || '';
      if (profileAvatar) {
        const initials = `${currentCustomer.firstName || ''} ${currentCustomer.lastName || ''}`.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('');
        profileAvatar.textContent = initials.toUpperCase() || 'BN';
      }
      prefillBagContact();
    }
  }
  updateAccountButton();

  function setCustomer(customer, token) {
    currentCustomer = customer;
    localStorage.setItem(CUSTOMER_KEY, JSON.stringify(customer));
    if (token) localStorage.setItem(CUSTOMER_TOKEN_KEY, token);
    updateAccountButton();
    refreshPdpReviewGate();
  }

  // Mescla os favoritos salvos neste dispositivo (localStorage) com os do servidor assim que
  // uma sessão começa (login, cadastro ou restauração de sessão) — nunca some com o que já
  // existia do lado do servidor, só soma o que faltava.
  async function syncFavoritesWithServer() {
    if (!currentCustomer) return;
    try {
      const res = await fetch('/api/customers/favorites/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: getCustomerToken(), productIds: [...favs] }),
      });
      const data = await res.json();
      if (!res.ok) return;
      favs = new Set(data.favorites);
      saveFavs();
      renderGrid(currentFilter, currentSearch);
      renderNovidades();
      renderBestSellers();
      syncPdpFavButton();
      if (!document.getElementById('profilePanel-favoritos').hidden) renderProfileFavorites();
    } catch {
      // sem conexão agora — os favoritos locais continuam valendo e sincronizam no próximo login
    }
  }

  function clearCustomer() {
    currentCustomer = null;
    localStorage.removeItem(CUSTOMER_KEY);
    localStorage.removeItem(CUSTOMER_TOKEN_KEY);
    updateAccountButton();
    refreshPdpReviewGate();
  }

  function openAccountModal() {
    const view = currentCustomer ? 'profile' : 'login';
    showAccountView(view);
    if (view === 'profile') {
      fillProfileDataForm();
      showProfileTab('dados');
    }
    accountOverlay.classList.add('is-open');
    accountModal.classList.add('is-open');
    openModalFocus(accountModal);
  }
  function closeAccountModal() {
    if (!accountModal.classList.contains('is-open')) return;
    accountOverlay.classList.remove('is-open');
    accountModal.classList.remove('is-open');
    closeModalFocus(accountModal);
    const welcomeCouponMsg = document.getElementById('welcomeCouponMsg');
    if (welcomeCouponMsg) welcomeCouponMsg.hidden = true;
  }

  accountBtn.addEventListener('click', openAccountModal);
  document.getElementById('accountClose').addEventListener('click', closeAccountModal);
  accountOverlay.addEventListener('click', closeAccountModal);
  document.getElementById('goSignup').addEventListener('click', () => showAccountView('signup'));
  document.getElementById('goLogin').addEventListener('click', () => showAccountView('login'));
  document.getElementById('goForgot').addEventListener('click', () => showAccountView('forgot'));
  document.getElementById('goLoginFromForgot').addEventListener('click', () => showAccountView('login'));
  document.getElementById('logoutBtn').addEventListener('click', () => {
    clearCustomer();
    closeAccountModal();
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormMsg(loginMsg, '', '');
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    try {
      const res = await fetch('/api/customers/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível entrar');
      setCustomer(data.customer, data.token);
      syncFavoritesWithServer();
      loginForm.reset();
      showAccountView('profile');
      fillProfileDataForm();
      showProfileTab('dados');
    } catch (err) {
      setFormMsg(loginMsg, err.message, 'error');
    }
  });

  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormMsg(forgotMsg, '', '');
    const email = document.getElementById('forgotEmail').value.trim();
    try {
      const res = await fetch('/api/customers/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível enviar o e-mail');
      setFormMsg(forgotMsg, 'Se esse e-mail tiver uma conta, enviamos um link de redefinição.', 'ok');
    } catch (err) {
      setFormMsg(forgotMsg, err.message, 'error');
    }
  });

  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormMsg(signupMsg, '', '');
    const password = document.getElementById('suPassword').value;
    const passwordConfirm = document.getElementById('suPasswordConfirm').value;
    if (password !== passwordConfirm) {
      setFormMsg(signupMsg, 'As senhas não coincidem.', 'error');
      return;
    }
    if (!document.getElementById('suPrivacy').checked) {
      setFormMsg(signupMsg, 'É preciso aceitar a política de privacidade.', 'error');
      return;
    }
    if (!isValidCPF(document.getElementById('suCpf').value)) {
      setFormMsg(signupMsg, 'CPF inválido.', 'error');
      return;
    }
    const body = {
      firstName: document.getElementById('suFirstName').value.trim(),
      lastName: document.getElementById('suLastName').value.trim(),
      email: document.getElementById('suEmail').value.trim(),
      phone: document.getElementById('suPhone').value.trim(),
      birthDate: document.getElementById('suBirthDate').value,
      cpf: document.getElementById('suCpf').value,
      gender: document.getElementById('suGender').value,
      password,
      marketingOptIn: document.getElementById('suMarketing').checked,
      privacyAccepted: document.getElementById('suPrivacy').checked,
    };
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível criar a conta');
      setCustomer(data.customer, data.token);
      syncFavoritesWithServer();
      signupForm.reset();
      showAccountView('profile');
      fillProfileDataForm();
      showProfileTab('dados');
      const welcomeCouponMsg = document.getElementById('welcomeCouponMsg');
      if (welcomeCouponMsg) welcomeCouponMsg.hidden = false;
    } catch (err) {
      setFormMsg(signupMsg, err.message, 'error');
    }
  });

  async function restoreSession() {
    const token = localStorage.getItem(CUSTOMER_TOKEN_KEY);
    if (!token) return;
    try {
      const res = await fetch('/api/customers/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error();
      setCustomer(data.customer, token);
      syncFavoritesWithServer();
    } catch {
      clearCustomer();
    }
  }

  // ---------- área da conta: meus dados ----------
  const profileSubnav = document.getElementById('profileSubnav');
  const profilePanels = {
    dados: document.getElementById('profilePanel-dados'),
    pedidos: document.getElementById('profilePanel-pedidos'),
    enderecos: document.getElementById('profilePanel-enderecos'),
    senha: document.getElementById('profilePanel-senha'),
    favoritos: document.getElementById('profilePanel-favoritos'),
  };

  function showProfileTab(tab) {
    profileSubnav.querySelectorAll('.profile-subnav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.ptab === tab));
    Object.entries(profilePanels).forEach(([key, el]) => {
      el.hidden = key !== tab;
    });
    if (tab === 'pedidos') loadProfileOrders();
    else if (tab === 'enderecos') loadProfileAddresses();
    else if (tab === 'favoritos') renderProfileFavorites();
  }

  profileSubnav.addEventListener('click', (e) => {
    const btn = e.target.closest('.profile-subnav-btn');
    if (btn) showProfileTab(btn.dataset.ptab);
  });

  const profileDataForm = document.getElementById('profileDataForm');
  const profileDataMsg = document.getElementById('profileDataMsg');

  function fillProfileDataForm() {
    if (!currentCustomer) return;
    document.getElementById('pdFirstName').value = currentCustomer.firstName || '';
    document.getElementById('pdLastName').value = currentCustomer.lastName || '';
    document.getElementById('pdEmail').value = currentCustomer.email || '';
    document.getElementById('pdPhone').value = currentCustomer.phone || '';
    document.getElementById('pdMarketing').checked = !!currentCustomer.marketingOptIn;
  }

  profileDataForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormMsg(profileDataMsg, '', '');
    try {
      const res = await fetch('/api/customers/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: getCustomerToken(),
          firstName: document.getElementById('pdFirstName').value.trim(),
          lastName: document.getElementById('pdLastName').value.trim(),
          phone: document.getElementById('pdPhone').value.trim(),
          marketingOptIn: document.getElementById('pdMarketing').checked,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível salvar');
      setCustomer(data.customer, null);
      setFormMsg(profileDataMsg, 'Dados atualizados ✓', 'ok');
    } catch (err) {
      setFormMsg(profileDataMsg, err.message, 'error');
    }
  });

  // ---------- área da conta: meus pedidos ----------
  const profileOrderList = document.getElementById('profileOrderList');
  const PROFILE_ORDER_STATUS_LABELS = { novo: 'Novo', em_andamento: 'Em andamento', concluido: 'Concluído', cancelado: 'Cancelado' };

  async function loadProfileOrders() {
    profileOrderList.innerHTML = '<p class="bag-empty">Carregando...</p>';
    try {
      const res = await fetch('/api/customers/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: getCustomerToken() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível carregar seus pedidos');
      renderProfileOrders(data.orders || []);
    } catch (err) {
      profileOrderList.innerHTML = `<p class="bag-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderProfileOrders(orders) {
    if (!orders.length) {
      profileOrderList.innerHTML = '<p class="bag-empty">Você ainda não fez nenhum pedido.</p>';
      return;
    }
    profileOrderList.innerHTML = orders
      .map((o) => {
        const when = new Date(o.createdAt).toLocaleString('pt-BR');
        const itemsText = (o.items || []).map((it) => `${escapeHtml(it.qty)}x ${escapeHtml(it.name)}${it.variantLabel ? ` (${escapeHtml(it.variantLabel)})` : ''}`).join(', ');
        const statusLabel = PROFILE_ORDER_STATUS_LABELS[o.status] || o.status;
        return `
          <div class="profile-order-item">
            <div class="profile-order-header"><span>${when}</span><span>${money(o.total)}</span></div>
            <p class="profile-order-items">${itemsText}</p>
            <span class="profile-order-meta">${escapeHtml(o.paymentMethod)} · ${escapeHtml(o.deliveryMethod)}${o.couponCode ? ` · cupom ${escapeHtml(o.couponCode)}` : ''}${o.shipping ? ` · frete ${money(o.shipping)}` : ''}</span>
            <span class="profile-order-status st-${o.status}">${statusLabel}</span>
          </div>
        `;
      })
      .join('');
  }

  // ---------- área da conta: endereços salvos ----------
  const profileAddressList = document.getElementById('profileAddressList');
  const profileAddAddressBtn = document.getElementById('profileAddAddressBtn');
  const profileAddressForm = document.getElementById('profileAddressForm');
  const profileAddressMsg = document.getElementById('profileAddressMsg');
  const paEditId = document.getElementById('paEditId');
  const paCep = document.getElementById('paCep');
  const paCepStatus = document.getElementById('paCepStatus');
  const paFields = document.getElementById('paFields');
  const paCancelBtn = document.getElementById('paCancelBtn');

  let PROFILE_ADDRESSES = [];

  async function loadProfileAddresses() {
    profileAddressList.innerHTML = '<p class="bag-empty">Carregando...</p>';
    try {
      const res = await fetch('/api/customers/addresses/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: getCustomerToken() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível carregar seus endereços');
      PROFILE_ADDRESSES = data.addresses || [];
      renderProfileAddresses();
    } catch (err) {
      profileAddressList.innerHTML = `<p class="bag-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderProfileAddresses() {
    if (!PROFILE_ADDRESSES.length) {
      profileAddressList.innerHTML = '<p class="bag-empty">Nenhum endereço salvo ainda.</p>';
      return;
    }
    profileAddressList.innerHTML = '';
    PROFILE_ADDRESSES.forEach((a) => {
      const div = document.createElement('div');
      div.className = 'profile-address-item';
      div.innerHTML = `
        <div class="profile-address-info">
          <span class="profile-address-label">${escapeHtml(a.label || 'Endereço')}</span>
          <span class="profile-address-meta">${escapeHtml(a.rua)}, ${escapeHtml(a.numero)}${a.complemento ? ` - ${escapeHtml(a.complemento)}` : ''} - ${escapeHtml(a.bairro)}, ${escapeHtml(a.cidade)}/${escapeHtml(a.estado)} - CEP ${escapeHtml(a.cep)}</span>
        </div>
        <div class="profile-address-actions">
          <button type="button" class="profile-address-default-badge ${a.isDefault ? '' : 'is-off'}">${a.isDefault ? 'Padrão' : 'Usar como padrão'}</button>
          <button type="button" class="account-link profile-address-edit">editar</button>
          <button type="button" class="profile-address-remove">remover</button>
        </div>
      `;
      div.querySelector('.profile-address-default-badge').addEventListener('click', async () => {
        if (a.isDefault) return;
        const res = await fetch('/api/customers/addresses/default', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: getCustomerToken(), id: a.id }),
        });
        const data = await res.json();
        if (res.ok) {
          PROFILE_ADDRESSES = data.addresses;
          renderProfileAddresses();
        }
      });
      div.querySelector('.profile-address-edit').addEventListener('click', () => startEditAddress(a));
      div.querySelector('.profile-address-remove').addEventListener('click', async () => {
        if (!confirm('Remover este endereço?')) return;
        const res = await fetch('/api/customers/addresses', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: getCustomerToken(), id: a.id }),
        });
        const data = await res.json();
        if (res.ok) {
          PROFILE_ADDRESSES = data.addresses;
          renderProfileAddresses();
        }
      });
      profileAddressList.appendChild(div);
    });
  }

  function openAddressForm() {
    profileAddressForm.hidden = false;
    profileAddAddressBtn.hidden = true;
  }
  function closeAddressForm() {
    profileAddressForm.hidden = true;
    profileAddAddressBtn.hidden = false;
    profileAddressForm.reset();
    paEditId.value = '';
    paFields.hidden = false;
    setFormMsg(profileAddressMsg, '', '');
  }
  profileAddAddressBtn.addEventListener('click', openAddressForm);
  paCancelBtn.addEventListener('click', closeAddressForm);

  function startEditAddress(a) {
    openAddressForm();
    paEditId.value = a.id;
    paCep.value = a.cep;
    document.getElementById('paRua').value = a.rua;
    document.getElementById('paNumero').value = a.numero;
    document.getElementById('paComplemento').value = a.complemento || '';
    document.getElementById('paBairro').value = a.bairro;
    document.getElementById('paCidade').value = a.cidade;
    document.getElementById('paEstado').value = a.estado;
    document.getElementById('paLabel').value = a.label || '';
    document.getElementById('paDefault').checked = !!a.isDefault;
  }

  async function lookupCepInto(digits, statusEl, fields) {
    statusEl.textContent = 'Buscando endereço...';
    statusEl.className = 'bag-cep-status';
    try {
      const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
      const data = await res.json();
      if (data.erro) {
        statusEl.textContent = 'CEP não encontrado. Confira o número.';
        statusEl.className = 'bag-cep-status is-error';
        return;
      }
      fields.rua.value = data.logradouro || '';
      fields.bairro.value = data.bairro || '';
      fields.cidade.value = data.localidade || '';
      fields.estado.value = data.uf || '';
      statusEl.textContent = 'Endereço encontrado ✓';
      statusEl.className = 'bag-cep-status is-ok';
    } catch {
      statusEl.textContent = 'Não foi possível buscar o CEP agora. Preencha manualmente.';
      statusEl.className = 'bag-cep-status is-error';
    }
  }

  paCep.addEventListener('input', () => {
    paCep.value = formatCep(paCep.value);
    const digits = paCep.value.replace(/\D/g, '');
    if (digits.length === 8) {
      lookupCepInto(digits, paCepStatus, {
        rua: document.getElementById('paRua'),
        bairro: document.getElementById('paBairro'),
        cidade: document.getElementById('paCidade'),
        estado: document.getElementById('paEstado'),
      });
    }
  });

  profileAddressForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormMsg(profileAddressMsg, '', '');
    const payload = {
      token: getCustomerToken(),
      label: document.getElementById('paLabel').value.trim(),
      cep: paCep.value.trim(),
      rua: document.getElementById('paRua').value.trim(),
      numero: document.getElementById('paNumero').value.trim(),
      complemento: document.getElementById('paComplemento').value.trim(),
      bairro: document.getElementById('paBairro').value.trim(),
      cidade: document.getElementById('paCidade').value.trim(),
      estado: document.getElementById('paEstado').value.trim(),
      isDefault: document.getElementById('paDefault').checked,
    };
    const editing = !!paEditId.value;
    try {
      const res = await fetch(editing ? '/api/customers/addresses/update' : '/api/customers/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing ? { ...payload, id: paEditId.value } : payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível salvar o endereço');
      PROFILE_ADDRESSES = data.addresses;
      renderProfileAddresses();
      closeAddressForm();
    } catch (err) {
      setFormMsg(profileAddressMsg, err.message, 'error');
    }
  });

  // ---------- área da conta: trocar senha ----------
  const profilePasswordForm = document.getElementById('profilePasswordForm');
  const profilePasswordMsg = document.getElementById('profilePasswordMsg');

  profilePasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormMsg(profilePasswordMsg, '', '');
    try {
      const res = await fetch('/api/customers/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: getCustomerToken(),
          currentPassword: document.getElementById('ppCurrent').value,
          newPassword: document.getElementById('ppNew').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível trocar a senha');
      profilePasswordForm.reset();
      setFormMsg(profilePasswordMsg, 'Senha atualizada ✓', 'ok');
    } catch (err) {
      setFormMsg(profilePasswordMsg, err.message, 'error');
    }
  });

  // ---------- área da conta: favoritos ----------
  const profileFavGrid = document.getElementById('profileFavGrid');
  const profileFavEmpty = document.getElementById('profileFavEmpty');

  function renderProfileFavorites() {
    const favProducts = PRODUCTS.filter((p) => favs.has(p.id));
    profileFavGrid.innerHTML = '';
    profileFavEmpty.hidden = favProducts.length !== 0;
    favProducts.forEach((p) => profileFavGrid.appendChild(productCard(p)));
  }

  function formatPhone(v) {
    const digits = v.replace(/\D/g, '').slice(0, 11);
    const pattern = digits.length > 10 ? /(\d{2})(\d{5})(\d{0,4})/ : /(\d{2})(\d{4})(\d{0,4})/;
    return digits.replace(pattern, (_, a, b, c) => (c ? `(${a}) ${b}-${c}` : b ? `(${a}) ${b}` : `(${a}`));
  }
  ['suPhone', 'bagPhone', 'pdPhone'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      el.value = formatPhone(el.value);
    });
  });
  function isValidCPF(value) {
    const cpf = String(value || '').replace(/\D/g, '');
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
    const digits = cpf.split('').map(Number);
    for (const pos of [9, 10]) {
      let sum = 0;
      for (let i = 0; i < pos; i++) sum += digits[i] * (pos + 1 - i);
      const check = ((sum * 10) % 11) % 10;
      if (check !== digits[pos]) return false;
    }
    return true;
  }
  document.getElementById('suCpf').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 11);
    e.target.value = digits
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  });

  // ---------- mobile menu + mega-menu open/close ----------
  const nav = document.getElementById('mainNav');
  const siteHeader = document.querySelector('.site-header');
  const menuToggle = document.getElementById('menuToggle');
  const megaTrigger = document.getElementById('megaTrigger');
  const megaItem = megaTrigger.closest('.nav-item');

  function setMobileMenu(open) {
    nav.classList.toggle('is-open', open);
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  }

  menuToggle.addEventListener('click', () => setMobileMenu(!nav.classList.contains('is-open')));

  function syncHeaderState() {
    siteHeader.classList.toggle('is-scrolled', window.scrollY > 12);
  }
  syncHeaderState();
  window.addEventListener('scroll', syncHeaderState, { passive: true });

  function closeMegaMenu() {
    megaItem.classList.remove('is-open');
    megaTrigger.setAttribute('aria-expanded', 'false');
  }

  megaTrigger.addEventListener('click', () => {
    const isOpen = megaItem.classList.toggle('is-open');
    megaTrigger.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', (e) => {
    if (!megaItem.contains(e.target)) closeMegaMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setMobileMenu(false);
      closeMegaMenu();
      closeAccountModal();
      closeStoryViewer();
      closeBag();
      closePdpLightbox();
    }
    if (storyViewer.classList.contains('is-open')) {
      if (e.key === 'ArrowRight') nextStory();
      else if (e.key === 'ArrowLeft') prevStory();
    }
    if (pdpLightbox && pdpLightbox.classList.contains('is-open')) {
      if (e.key === 'ArrowRight') nextPdpLightboxSlide();
      else if (e.key === 'ArrowLeft') prevPdpLightboxSlide();
    }
  });

  // fecha o menu mobile (e o mega-menu) ao clicar em qualquer link dentro do nav,
  // via delegação — funciona também para os links do mega-menu, gerados depois via JS
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      setMobileMenu(false);
      closeMegaMenu();
    }
  });

  document.getElementById('year').textContent = new Date().getFullYear();

  // ---------- load catalog from the server ----------
  const loadBar = document.getElementById('loadBar');
  const dataError = document.getElementById('dataError');
  const dataErrorRetry = document.getElementById('dataErrorRetry');

  // ---------- galeria com zoom + lightbox (produto.html) ----------
  const pdpGalleryMain = document.getElementById('pdpGalleryMain');
  const pdpMainImg = document.getElementById('pdpMainImg');
  const pdpZoomPane = document.getElementById('pdpZoomPane');
  const pdpZoomHint = document.getElementById('pdpZoomHint');
  const pdpLightboxOverlay = document.getElementById('pdpLightboxOverlay');
  const pdpLightbox = document.getElementById('pdpLightbox');
  const pdpLightboxImg = document.getElementById('pdpLightboxImg');
  const pdpLightboxClose = document.getElementById('pdpLightboxClose');
  const pdpLightboxPrev = document.getElementById('pdpLightboxPrev');
  const pdpLightboxNext = document.getElementById('pdpLightboxNext');
  const pdpLightboxCounter = document.getElementById('pdpLightboxCounter');
  let pdpGalleryImages = [];
  let pdpLightboxIndex = 0;

  function setPdpMainImage(url) {
    pdpMainImg.src = url;
    pdpZoomPane.style.backgroundImage = `url("${url}")`;
  }

  function pdpLightboxIndexFor(url) {
    // pdpMainImg.src sempre vem resolvido em absoluto pelo getter — resolve os caminhos de
    // pdpGalleryImages (que ficam relativos, como vêm da API) antes de comparar. Usa
    // document.baseURI (não location.href) porque a página tem <base href="/">.
    const resolved = new URL(url, document.baseURI).href;
    const idx = pdpGalleryImages.findIndex((u) => new URL(u, document.baseURI).href === resolved);
    return idx === -1 ? 0 : idx;
  }

  function renderPdpLightboxSlide() {
    pdpLightboxImg.src = pdpGalleryImages[pdpLightboxIndex];
    const multi = pdpGalleryImages.length > 1;
    pdpLightboxCounter.hidden = !multi;
    pdpLightboxCounter.textContent = `${pdpLightboxIndex + 1}/${pdpGalleryImages.length}`;
    pdpLightboxPrev.hidden = !multi;
    pdpLightboxNext.hidden = !multi;
  }

  function openPdpLightbox(index) {
    if (!pdpGalleryImages.length) return;
    pdpLightboxIndex = index;
    renderPdpLightboxSlide();
    pdpLightboxOverlay.classList.add('is-open');
    pdpLightbox.classList.add('is-open');
    openModalFocus(pdpLightbox);
  }

  function closePdpLightbox() {
    if (!pdpLightbox || !pdpLightbox.classList.contains('is-open')) return;
    pdpLightboxOverlay.classList.remove('is-open');
    pdpLightbox.classList.remove('is-open');
    closeModalFocus(pdpLightbox);
  }

  function nextPdpLightboxSlide() {
    pdpLightboxIndex = (pdpLightboxIndex + 1) % pdpGalleryImages.length;
    renderPdpLightboxSlide();
  }

  function prevPdpLightboxSlide() {
    pdpLightboxIndex = (pdpLightboxIndex - 1 + pdpGalleryImages.length) % pdpGalleryImages.length;
    renderPdpLightboxSlide();
  }

  if (pdpGalleryMain) {
    pdpGalleryMain.addEventListener('mouseenter', () => pdpGalleryMain.classList.add('is-zooming'));
    pdpGalleryMain.addEventListener('mouseleave', () => pdpGalleryMain.classList.remove('is-zooming'));
    pdpGalleryMain.addEventListener('mousemove', (e) => {
      const rect = pdpGalleryMain.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      pdpZoomPane.style.backgroundPosition = `${x}% ${y}%`;
    });
    pdpGalleryMain.addEventListener('click', () => openPdpLightbox(pdpLightboxIndexFor(pdpMainImg.src)));
  }
  if (pdpZoomHint) {
    pdpZoomHint.addEventListener('click', (e) => {
      e.stopPropagation();
      openPdpLightbox(pdpLightboxIndexFor(pdpMainImg.src));
    });
  }
  if (pdpLightboxClose) pdpLightboxClose.addEventListener('click', closePdpLightbox);
  if (pdpLightboxOverlay) pdpLightboxOverlay.addEventListener('click', closePdpLightbox);
  if (pdpLightboxNext) pdpLightboxNext.addEventListener('click', nextPdpLightboxSlide);
  if (pdpLightboxPrev) pdpLightboxPrev.addEventListener('click', prevPdpLightboxSlide);
  if (pdpLightbox) {
    let pdpTouchStartX = 0;
    pdpLightbox.addEventListener('touchstart', (e) => { pdpTouchStartX = e.changedTouches[0].clientX; }, { passive: true });
    pdpLightbox.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - pdpTouchStartX;
      if (Math.abs(dx) < 40) return;
      if (dx < 0) nextPdpLightboxSlide();
      else prevPdpLightboxSlide();
    }, { passive: true });
  }

  // ---------- barra fixa de compra (produto.html) ----------
  const pdpBuyBar = document.getElementById('pdpBuyBar');
  const pdpBuyBarImg = document.getElementById('pdpBuyBarImg');
  const pdpBuyBarName = document.getElementById('pdpBuyBarName');
  const pdpBuyBarPrice = document.getElementById('pdpBuyBarPrice');
  const pdpBuyBarAdd = document.getElementById('pdpBuyBarAdd');
  if (pdpBuyBar) {
    const buyBarObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        // só mostra a barra quando o botão original já rolou para cima da tela —
        // evita mostrar a barra logo de cara, antes da cliente rolar a página
        const shouldShow = !entry.isIntersecting && entry.boundingClientRect.top < 0;
        pdpBuyBar.classList.toggle('is-visible', shouldShow);
        document.body.classList.toggle('pdp-buy-bar-open', shouldShow);
      },
      { threshold: 0 }
    );
    const productActionsEl = document.querySelector('.product-actions');
    if (productActionsEl) buyBarObserver.observe(productActionsEl);
  }

  // ---------- página de produto (produto.html) ----------
  // Reaproveita os mesmos helpers da vitrine (getEffective, money, colorDotsHtml,
  // variantLabel, isLowStock, syncAddButton, productCard) — é o mesmo main.js rodando nas duas
  // páginas, só muda o que é populado ao carregar.
  function initProductPage() {
    const id = decodeURIComponent(location.pathname.replace(/^\/produto\//, ''));
    const p = PRODUCTS.find((x) => x.id === id);
    const layout = document.getElementById('pdpLayout');
    const notFound = document.getElementById('pdpNotFound');
    if (!p) {
      layout.hidden = true;
      notFound.hidden = false;
      return;
    }

    window.byNanaAnalytics?.trackViewItem(p);
    trackRecentlyViewed(p.id);

    document.getElementById('pdpBreadcrumb').innerHTML =
      `<a href="/">Home</a> / <a href="/#colecao">${escapeHtml(p.category)}</a> / <span>${escapeHtml(p.name)}</span>`;

    const images = p.images && p.images.length ? p.images : [p.img];
    pdpGalleryImages = images;
    const thumbs = document.getElementById('pdpThumbs');
    setPdpMainImage(images[0]);
    pdpMainImg.alt = p.name;
    thumbs.innerHTML = images
      .map(
        (url, i) => `<button type="button" class="pdp-thumb${i === 0 ? ' is-active' : ''}" data-src="${url}"><img src="${url}" alt="" /></button>`
      )
      .join('');
    thumbs.hidden = images.length <= 1;
    thumbs.querySelectorAll('.pdp-thumb').forEach((btn) => {
      btn.addEventListener('click', () => {
        setPdpMainImage(btn.dataset.src);
        thumbs.querySelectorAll('.pdp-thumb').forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    });

    if (pdpBuyBarImg) pdpBuyBarImg.src = images[0];
    if (pdpBuyBarName) pdpBuyBarName.textContent = p.name;

    document.getElementById('pdpBrand').textContent = `${p.brand}${p.collection ? ` · ${p.collection}` : ''}`;
    document.getElementById('pdpName').textContent = p.name;

    const { price, promo } = getEffective(p);
    const priceEl = document.getElementById('pdpPrice');
    const priceOldEl = document.getElementById('pdpPriceOld');
    const discountBadge = document.getElementById('pdpDiscountBadge');
    priceEl.textContent = money(price);
    priceEl.classList.toggle('consult', p.price == null);
    priceEl.classList.toggle('is-promo', !!promo);
    priceOldEl.textContent = promo ? money(p.price) : '';
    priceOldEl.hidden = !promo;
    discountBadge.textContent = promo ? `-${promo.percent}%` : '';
    discountBadge.hidden = !promo;
    if (pdpBuyBarPrice) pdpBuyBarPrice.textContent = priceEl.textContent;
    const installmentsEl = document.getElementById('pdpInstallments');
    installmentsEl.textContent = installmentText(price);
    installmentsEl.hidden = p.price == null;
    const pixHintEl = document.getElementById('pdpPixHint');
    if (pixHintEl) {
      pixHintEl.textContent = pixHintText(price);
      pixHintEl.hidden = p.price == null;
    }

    const ratingRow = document.getElementById('pdpRatingRow');
    if (p.rating) {
      document.getElementById('pdpRatingStars').textContent = starsHtml(p.rating);
      document.getElementById('pdpRatingCount').textContent = `${p.rating.toFixed(1)} (${p.reviewCount})`;
      ratingRow.hidden = false;
    } else {
      ratingRow.hidden = true;
    }

    document.getElementById('pdpDesc').textContent = p.desc;

    const variants = p.variants || [];
    const inStock = variants.filter((v) => v.stock > 0);
    const soldOut = p.hasVariants && inStock.length === 0;
    const defaultVariant = inStock[0] || null;
    document.getElementById('pdpLowStock').hidden = !isLowStock(p, soldOut);
    document.getElementById('pdpColorDots').innerHTML = colorDotsHtml(variants);

    const variantPicker = document.getElementById('pdpVariantPicker');
    if (p.hasVariants) {
      variantPicker.hidden = false;
      variantPicker.innerHTML = variants
        .map(
          (v) => `<button type="button" class="variant-chip${v.stock <= 0 ? ' is-soldout' : ''}${defaultVariant && v.id === defaultVariant.id ? ' is-active' : ''}" data-variant-id="${v.id}" ${v.stock <= 0 ? 'disabled' : ''}>${escapeHtml(variantLabel(v))}</button>`
        )
        .join('');
    } else {
      variantPicker.hidden = true;
      variantPicker.innerHTML = '';
    }

    setupRestockNotify(variants.filter((v) => v.stock <= 0));

    const addBtn = document.getElementById('pdpAdd');
    addBtn.dataset.id = p.id;
    if (defaultVariant) addBtn.dataset.variantId = defaultVariant.id;
    else delete addBtn.dataset.variantId;
    addBtn.classList.toggle('is-soldout', soldOut);
    addBtn.disabled = soldOut;
    if (soldOut) addBtn.textContent = 'Esgotado';
    else syncAddButton(addBtn);

    if (pdpBuyBarAdd) {
      pdpBuyBarAdd.dataset.id = p.id;
      if (defaultVariant) pdpBuyBarAdd.dataset.variantId = defaultVariant.id;
      else delete pdpBuyBarAdd.dataset.variantId;
      pdpBuyBarAdd.classList.toggle('is-soldout', soldOut);
      pdpBuyBarAdd.disabled = soldOut;
      if (soldOut) pdpBuyBarAdd.textContent = 'Esgotado';
      else syncAddButton(pdpBuyBarAdd);
    }

    document.getElementById('pdpAsk').href = waLink(
      `Olá! Tenho interesse na peça "${p.name}" que vi no catálogo By NaNa. Pode me passar mais detalhes?`
    );

    document.getElementById('pdpFav').dataset.id = p.id;
    syncPdpFavButton();

    // medidas: mostra a do tamanho selecionado no momento (ou da variante padrão, se só houver uma)
    const measurementsBlock = document.getElementById('pdpMeasurementsBlock');
    const measurementsText = document.getElementById('pdpMeasurements');
    function syncMeasurements() {
      const activeChip = variantPicker.querySelector('.variant-chip.is-active');
      const variant = activeChip ? variants.find((v) => v.id === activeChip.dataset.variantId) : defaultVariant;
      if (variant && variant.measurements) {
        measurementsText.textContent = variant.measurements;
        measurementsBlock.hidden = false;
      } else {
        measurementsBlock.hidden = true;
      }
    }
    syncMeasurements();
    variantPicker.addEventListener('click', () => setTimeout(syncMeasurements, 0));

    const compositionBlock = document.getElementById('pdpCompositionBlock');
    if (p.composition) {
      document.getElementById('pdpComposition').textContent = p.composition;
      compositionBlock.hidden = false;
    } else {
      compositionBlock.hidden = true;
    }

    const related = pickRelatedProducts(p);
    const relatedGrid = document.getElementById('pdpRelatedGrid');
    relatedGrid.innerHTML = '';
    related.forEach((r) => relatedGrid.appendChild(productCard(r)));
    document.getElementById('pdpRelated').hidden = related.length === 0;
    renderRecentlyViewed(p.id);

    initProductReviews(p);

    layout.hidden = false;
    notFound.hidden = true;
  }

  // ---------- avaliações da página de produto ----------
  function renderReviewsList(reviews) {
    const listEl = document.getElementById('pdpReviewList');
    if (!reviews.length) {
      listEl.innerHTML = '<p class="pdp-review-empty">Ainda não há avaliações para este produto.</p>';
      return;
    }
    listEl.innerHTML = reviews
      .map(
        (r) => `
          <div class="pdp-review-item">
            <div class="pdp-review-item-head">
              <span class="pdp-review-stars">${starsHtml(r.rating)}</span>
              <span class="pdp-review-author">${escapeHtml(r.customerName)}</span>
              <span class="pdp-review-date">${new Date(r.createdAt).toLocaleDateString('pt-BR')}</span>
            </div>
            ${r.comment ? `<p class="pdp-review-comment">${escapeHtml(r.comment)}</p>` : ''}
          </div>
        `
      )
      .join('');
  }

  function renderReviewsSummary(reviews) {
    const summaryEl = document.getElementById('pdpReviewsSummary');
    if (!reviews.length) {
      summaryEl.hidden = true;
      return;
    }
    const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
    document.getElementById('pdpReviewsAvgStars').textContent = starsHtml(avg);
    document.getElementById('pdpReviewsAvgText').textContent =
      `${avg.toFixed(1)} de 5 · ${reviews.length} ${reviews.length === 1 ? 'avaliação' : 'avaliações'}`;
    summaryEl.hidden = false;
  }

  // `currentCustomer` só é conhecido de verdade depois do login/cadastro/restauração de sessão,
  // que rodam bem depois desse carregamento inicial — por isso o gate (esconder form/mostrar aviso
  // de login) precisa poder ser re-executado a qualquer momento via refreshPdpReviewGate(), chamada
  // de dentro de setCustomer()/clearCustomer(), não só uma vez aqui dentro de initProductReviews().
  let pdpReviewProduct = null;
  let pdpReviewFormWired = false;

  function wireReviewFormOnce() {
    if (pdpReviewFormWired) return;
    pdpReviewFormWired = true;
    const form = document.getElementById('pdpReviewForm');
    const starsInput = document.getElementById('pdpReviewStarsInput');
    const commentInput = document.getElementById('pdpReviewComment');
    const submitBtn = document.getElementById('pdpReviewSubmit');
    const msgEl = document.getElementById('pdpReviewMsg');

    function setMsg(text, kind) {
      msgEl.textContent = text;
      msgEl.className = `account-form-msg ${kind === 'ok' ? 'is-ok' : 'is-error'}`;
      msgEl.hidden = !text;
    }

    let selectedRating = 0;
    starsInput.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedRating = Number(btn.dataset.value);
        starsInput.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.value) <= selectedRating));
      });
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setMsg('', '');
      if (!pdpReviewProduct) return;
      if (!selectedRating) {
        setMsg('Escolha de 1 a 5 estrelas.', 'error');
        return;
      }
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: getCustomerToken(), productId: pdpReviewProduct.id, rating: selectedRating, comment: commentInput.value.trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Não foi possível enviar sua avaliação');
        const reviews = data.reviews || [];
        renderReviewsSummary(reviews);
        renderReviewsList(reviews);
        form.hidden = true;
        setMsg('Avaliação enviada ✓ obrigada por compartilhar!', 'ok');
      } catch (err) {
        setMsg(err.message, 'error');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  function refreshPdpReviewGate() {
    const loginHint = document.getElementById('pdpReviewLoginHint');
    const form = document.getElementById('pdpReviewForm');
    if (!loginHint || !form || !pdpReviewProduct) return;
    loginHint.hidden = !!currentCustomer;
    form.hidden = !currentCustomer;
    if (currentCustomer) wireReviewFormOnce();
  }

  async function initProductReviews(p) {
    pdpReviewProduct = p;
    let reviews = [];
    try {
      const res = await fetch('/api/reviews/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id }),
      });
      const data = await res.json();
      reviews = data.reviews || [];
    } catch {
      // sem conexão agora — segue mostrando a lista vazia; o resumo/nota do card já veio do /api/data
    }
    renderReviewsSummary(reviews);
    renderReviewsList(reviews);
    refreshPdpReviewGate();
  }

  document.getElementById('pdpReviewLoginBtn')?.addEventListener('click', () => openAccountModal());

  async function init() {
    handleCheckoutReturn();
    dataError.hidden = true;
    loadBar.classList.remove('is-done');
    loadBar.classList.add('is-active');
    renderSkeleton(8);

    try {
      const res = await fetch('/api/data', { cache: 'no-store' });
      if (!res.ok) throw new Error('bad response');
      const data = await res.json();
      PRODUCTS = data.products || [];
      CATEGORIES = data.categories || [];
      COLLECTIONS = data.collections || [];
      PROMOTIONS = data.promotions || [];
      COUPONS = data.coupons || [];
      SHIPPING_RULES = data.shippingRules || [];
      CATEGORY_GROUPS = data.categoryGroups || [];
      CATEGORY_CONTENT = data.categoryContent || [];
      // Registros usados durante a configuração do painel não devem aparecer na vitrine pública.
      STORIES = (data.stories || []).filter((story) => !/^story\s+teste?\b/i.test((story.title || '').trim()));
      NOVIDADES = data.novidades || [];
      UPSELL_PRODUCTS = data.upsell || [];
      BEST_SELLERS = data.bestSellers || [];
      document.querySelectorAll('.payment-online-chip').forEach((el) => { el.hidden = !data.onlinePaymentEnabled; });
    } catch {
      loadBar.classList.remove('is-active');
      if (grid) grid.innerHTML = '';
      if (emptyState) emptyState.hidden = true;
      dataError.hidden = false;
      return;
    }

    loadBar.classList.remove('is-active');
    loadBar.classList.add('is-done');
    buildMegaMenu();
    renderPromoBanner();
    renderTopbarMessages();
    renderCart();
    restoreSession();

    if (document.body.dataset.page === 'produto') {
      initProductPage();
    } else {
      const params = new URLSearchParams(location.search);
      const initialSearch = params.get('busca') || '';
      const initialCategory = params.get('categoria') || 'Todos';
      buildFilters();
      buildCatCards();
      buildCollectionFilter();
      buildSecondaryFilters();
      if (searchInput) searchInput.value = initialSearch;
      renderGrid(initialCategory, initialSearch);
      filtersEl.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('is-active', c.dataset.filter === initialCategory));
      renderNovidades();
      renderBestSellers();
      renderRecentlyViewed();
      renderStoriesRail();
    }

    initScrollReveal();
  }

  dataErrorRetry.addEventListener('click', init);

  // ---------- entrada suave das seções ao rolar a página ----------
  // Classe só é adicionada aqui (nunca no HTML) — sem JS ou sem suporte a IntersectionObserver
  // os elementos simplesmente não recebem `.reveal` e ficam com a opacidade normal, sempre visíveis.
  function initScrollReveal() {
    if (!('IntersectionObserver' in window)) return;
    const headings = document.querySelectorAll(
      '.section-head, .spotlight-copy, .spotlight-media, .sobre-img, .sobre-copy, .brand-proof-inner, .cta-inner'
    );
    const staggerGroups = document.querySelectorAll('.cat-grid, .product-grid, .editorial-grid, .proof-points');
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -80px 0px' }
    );
    headings.forEach((el) => {
      el.classList.add('reveal');
      io.observe(el);
    });
    staggerGroups.forEach((el) => {
      if (!el.children.length) return;
      el.classList.add('reveal-stagger');
      io.observe(el);
    });
  }

  function renderPromoBanner() {
    const banner = document.getElementById('promoBanner');
    const sitePromo = window.PromoEngine.activeSitePromo(PROMOTIONS);
    if (!sitePromo) {
      banner.hidden = true;
      return;
    }
    const discountText = sitePromo.type === 'percent' ? `${sitePromo.value}% OFF` : `${money(sitePromo.value)} OFF`;
    banner.textContent = sitePromo.label
      ? `🎉 ${sitePromo.label} — ${discountText} em toda a loja`
      : `🎉 Promoção especial: ${discountText} em toda a loja`;
    banner.hidden = false;
  }

  // ---------- topbar: mensagens fixas da marca + incentivos dinâmicos (frete grátis, cupom de
  // boas-vindas) — lidos direto de SHIPPING_RULES/COUPONS, então somem sozinhos se a loja não
  // tiver frete grátis ou cupom de primeira compra configurado (nenhum valor fica hardcoded).
  let topbarRotationTimer = null;

  // onClick presente => vira <button> (clique-para-copiar do cupom); ausente => <span> comum
  // (mensagem só informativa, como a de frete grátis). Retorna o elemento criado.
  function appendTopbarMessage(topbar, text, onClick) {
    const el = document.createElement(onClick ? 'button' : 'span');
    el.className = onClick ? 'topbar-msg topbar-msg-action' : 'topbar-msg';
    el.dataset.dynamic = '1';
    el.textContent = text;
    if (onClick) {
      el.type = 'button';
      el.addEventListener('click', onClick);
    }
    topbar.appendChild(el);
    return el;
  }

  function copyWelcomeCoupon(el, code, originalLabel) {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        el.textContent = `✓ Cupom ${code} copiado!`;
        setTimeout(() => {
          el.textContent = originalLabel;
        }, 2200);
      })
      .catch(() => {});
  }

  function renderTopbarMessages() {
    const topbar = document.getElementById('topbar');
    if (!topbar) return;

    // remove mensagens dinâmicas de uma chamada anterior (o retry de /api/data pode rodar init() de novo).
    topbar.querySelectorAll('.topbar-msg[data-dynamic]').forEach((el) => el.remove());

    const freeShippingRules = SHIPPING_RULES.filter((r) => r.active && r.freeAbove != null && Number(r.freeAbove) > 0);
    if (freeShippingRules.length) {
      const minFreeAbove = Math.min(...freeShippingRules.map((r) => Number(r.freeAbove)));
      appendTopbarMessage(topbar, `🚚 Frete grátis em compras acima de ${money(minFreeAbove)}`);
    }

    const today = window.PromoEngine.todayISO();
    const welcomeCoupon = COUPONS.find(
      (c) => c.active && c.firstPurchaseOnly && (!c.startDate || today >= c.startDate) && (!c.endDate || today <= c.endDate)
    );
    if (welcomeCoupon) {
      const discountText = welcomeCoupon.type === 'percent' ? `${welcomeCoupon.value}%` : money(welcomeCoupon.value);
      // Clipboard API exige contexto seguro (https ou localhost); sem isso, a mensagem some do
      // clique e vira só informativa — nunca some por completo.
      const canCopy = !!(navigator.clipboard && navigator.clipboard.writeText);
      const label = `🎁 Cupom ${welcomeCoupon.code}: ${discountText} OFF na primeira compra${canCopy ? ' · toque para copiar' : ''}`;
      const el = appendTopbarMessage(topbar, label, canCopy ? () => copyWelcomeCoupon(el, welcomeCoupon.code, label) : null);
    }

    const messages = topbar.querySelectorAll('.topbar-msg');
    if (topbarRotationTimer) clearInterval(topbarRotationTimer);
    if (messages.length <= 1) return;
    let current = 0;
    topbarRotationTimer = setInterval(() => {
      messages[current].classList.remove('is-active');
      current = (current + 1) % messages.length;
      messages[current].classList.add('is-active');
    }, 5000);
  }

  init();
})();
