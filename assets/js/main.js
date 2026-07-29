(() => {
  const WHATSAPP_NUMBER = '5531986315271';

  const WA_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M12.02 2C6.5 2 2 6.48 2 12c0 1.85.5 3.58 1.38 5.07L2 22l5.1-1.34A9.94 9.94 0 0 0 12.02 22C17.5 22 22 17.52 22 12S17.5 2 12.02 2Zm5.87 14.14c-.25.7-1.45 1.34-2 1.42-.53.08-1.13.11-1.83-.12-.42-.14-.96-.32-1.66-.62-2.92-1.26-4.83-4.2-4.98-4.4-.15-.2-1.19-1.58-1.19-3.02 0-1.44.76-2.15 1.03-2.44.27-.29.6-.36.8-.36.2 0 .4 0 .57.01.18.01.43-.07.67.51.25.6.85 2.07.92 2.22.07.15.12.33.02.53-.1.2-.15.32-.3.5-.15.18-.31.4-.44.53-.15.15-.3.31-.13.6.17.3.76 1.25 1.63 2.02 1.12 1 2.06 1.31 2.36 1.46.3.15.47.13.65-.08.18-.2.76-.88.96-1.18.2-.3.4-.25.67-.15.27.1 1.73.82 2.03.97.3.15.5.22.57.35.07.13.07.75-.18 1.45Z"/></svg>';

  // Catalog data now lives on the server (data/*.json), managed from /admin.html.
  let PRODUCTS = [];
  let CATEGORIES = [];
  let COLLECTIONS = [];
  let PROMOTIONS = [];
  let COUPONS = [];
  let CATEGORY_GROUPS = [];
  let CATEGORY_CONTENT = [];
  let STORIES = [];
  let NOVIDADES = [];

  const money = (v) =>
    v == null ? 'Sob consulta' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Resolves the price a customer actually pays for a product right now (item/category/collection/site promos).
  function getEffective(p) {
    if (p.price == null) return { price: null, promo: null };
    const best = PROMOTIONS.length ? window.PromoEngine.bestPromoForProduct(p, PROMOTIONS) : null;
    return best ? { price: best.price, promo: best } : { price: p.price, promo: null };
  }

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

  // ---------- estoque baixo e cores (vitrine + quickview) ----------
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
          ? `<span class="color-dot" style="background-color:${hex}" title="${c}"></span>`
          : `<span class="color-dot color-dot-label" title="${c}">${c.slice(0, 3)}</span>`;
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
      return price ? sum + price * entry.qty : sum;
    }, 0);
  }

  // Escolhe o maior desconto entre cupom, Pix e quantidade de itens — nunca soma os três
  // (mantém o total previsível: "o melhor desconto é aplicado automaticamente").
  function cartDiscountInfo(keys) {
    const subtotal = cartSubtotal(keys);
    const itemCount = keys.reduce((sum, key) => sum + (cart[key] ? cart[key].qty : 0), 0);
    const coupon = activeCoupon();
    return window.PromoEngine.bestDiscount(subtotal, { coupon, itemCount, payment: selectedPayment });
  }

  function cartFinalTotal(keys) {
    const subtotal = cartSubtotal(keys);
    const discount = cartDiscountInfo(keys);
    return discount ? Math.max(0, subtotal - discount.amount) : subtotal;
  }

  const waLink = (text) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;

  // basic greeting links used across the page
  document.querySelectorAll('#quickWhats, #ctaWhats, #footerWhats, #floatWhats').forEach((el) => {
    el.href = waLink('Olá! Vim pelo site da By NaNa e queria saber mais sobre as peças 💛');
  });

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
    syncQuickviewFav();
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

  // ---------- catalog render ----------
  const grid = document.getElementById('productGrid');
  const emptyState = document.getElementById('emptyState');
  let currentFilter = 'Todos';
  let currentSearch = '';

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
              (v) => `<button type="button" class="variant-chip${v.stock <= 0 ? ' is-soldout' : ''}${defaultVariant && v.id === defaultVariant.id ? ' is-active' : ''}" data-variant-id="${v.id}" ${v.stock <= 0 ? 'disabled' : ''}>${variantLabel(v)}</button>`
            )
            .join('')}
        </div>`
      : '';

    div.innerHTML = `
      <div class="product-media" data-id="${p.id}">
        <img src="${p.img}" alt="${p.name}" loading="lazy" />
        <div class="product-badges">
          <span class="product-tag">${p.tag}</span>
          ${promo ? `<span class="discount-badge">-${promo.percent}%</span>` : ''}
          ${soldOut ? `<span class="soldout-badge">Esgotado</span>` : ''}
          ${lowStock ? `<span class="low-stock-badge">Últimas unidades</span>` : ''}
        </div>
        <button class="fav-btn ${isFav ? 'is-fav' : ''}" data-id="${p.id}" aria-label="Favoritar">${isFav ? '♥' : '♡'}</button>
      </div>
      <div class="product-body">
        <span class="product-cat">${p.brand}${p.collection ? ` · ${p.collection}` : ''}</span>
        <h3 class="product-name">${p.name}</h3>
        <div class="product-price-row">${priceHtml}</div>
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
    grid.innerHTML = '';
    emptyState.hidden = true;
    for (let i = 0; i < count; i++) grid.appendChild(skeletonCard());
  }

  let currentCollection = '';

  function renderGrid(filter, search) {
    currentFilter = filter;
    currentSearch = search || '';
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
          <summary>${f.question}</summary>
          <p>${f.answer}</p>
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
      btn.innerHTML = `<img src="${rep ? rep.img : fallbackImg}" alt="${cat}" /><span>${cat}</span>`;
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
    select.innerHTML = `<option value="">Todas as coleções</option>${COLLECTIONS.map((c) => `<option value="${c}">${c}</option>`).join('')}`;
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
            : `<span class="color-dot color-dot-label">${c.slice(0, 3)}</span>`;
          return `<button type="button" class="color-filter-chip" data-color="${c}" title="${c}">${swatch}</button>`;
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
          <p class="mega-menu-col-title">${groupName}</p>
          <ul>${names.map((n) => `<li><a href="#colecao" data-cat="${n}">${n}</a></li>`).join('')}</ul>
        </div>`
      )
      .join('');
    megaMenuEl.innerHTML = `<div class="mega-menu-columns">${columnsHtml}</div>`;
  }

  megaMenuEl.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-cat]');
    if (!link) return;
    e.preventDefault();
    setFilter(link.dataset.cat);
    document.getElementById('colecao').scrollIntoView({ behavior: 'smooth' });
  });

  // ---------- novidades (últimos produtos cadastrados) ----------
  const novidadesGrid = document.getElementById('novidadesGrid');
  function renderNovidades() {
    if (!novidadesGrid) return;
    novidadesGrid.innerHTML = '';
    NOVIDADES.forEach((p) => novidadesGrid.appendChild(productCard(p)));
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const searchInput = document.getElementById('searchInput');
  const debouncedSearch = debounce(() => {
    renderGrid(currentFilter, searchInput.value.trim().toLowerCase());
  }, 220);
  searchInput.addEventListener('input', debouncedSearch);

  // ---------- busca no cabeçalho (espelha a busca do catálogo) ----------
  const headerSearchForm = document.getElementById('headerSearchForm');
  const headerSearchInput = document.getElementById('headerSearchInput');
  headerSearchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    searchInput.value = headerSearchInput.value;
    renderGrid(currentFilter, headerSearchInput.value.trim().toLowerCase());
    document.getElementById('colecao').scrollIntoView({ behavior: 'smooth' });
  });

  const bagCount = document.getElementById('bagCount');
  const bagItemsEl = document.getElementById('bagItems');
  const bagTotalEl = document.getElementById('bagTotal');
  const bagSubtotalRow = document.getElementById('bagSubtotalRow');
  const bagSubtotalEl = document.getElementById('bagSubtotal');
  const bagDiscountRow = document.getElementById('bagDiscountRow');
  const bagDiscountLabelEl = document.getElementById('bagDiscountLabel');
  const bagDiscountValueEl = document.getElementById('bagDiscountValue');
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
    } catch (e) {
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
    });
  });

  function validateCheckout() {
    if (!bagNameInput.value.trim()) return 'Informe seu nome.';
    if (!bagPhoneInput.value.trim()) return 'Informe seu telefone.';
    if (!selectedPayment) return 'Selecione a forma de pagamento.';
    if (!selectedDelivery) return 'Selecione retirada em loja ou entrega.';
    if (selectedDelivery === 'Entrega') {
      if (address.cep.replace(/\D/g, '').length !== 8) return 'Informe um CEP válido.';
      if (!address.rua.trim()) return 'Preencha a rua (confira o CEP ou digite manualmente).';
      if (!address.numero.trim()) return 'Informe o número do endereço.';
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
    if (discount) {
      msg += `\nSubtotal (itens com preço): ${money(subtotal)}`;
      msg += `\n🏷️ ${discount.label}`;
      msg += `\nTotal: ${money(cartFinalTotal(keys))}`;
    } else {
      msg += `\nTotal (itens com preço): ${money(subtotal)}`;
    }
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
    const payload = {
      customerName: bagNameInput.value.trim(),
      customerPhone: bagPhoneInput.value.trim(),
      items,
      subtotal: cartSubtotal(keys),
      discount: discount ? discount.amount : 0,
      total: cartFinalTotal(keys),
      couponCode: coupon ? coupon.code : null,
      paymentMethod: selectedPayment,
      deliveryMethod: selectedDelivery,
      address: selectedDelivery === 'Entrega' ? address : null,
      customerToken: localStorage.getItem(CUSTOMER_TOKEN_KEY) || null,
    };
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível reservar o estoque');
      return data.orderId;
    } catch (err) {
      throw err;
    }
  }

  checkoutBtn.addEventListener('click', (e) => {
    const ids = Object.keys(cart);
    if (ids.length === 0) return;
    e.preventDefault();
    const error = validateCheckout();
    if (error) {
      bagFormError.textContent = error;
      bagFormError.hidden = false;
      return;
    }
    bagFormError.hidden = true;
    checkoutBtn.classList.add('is-loading');
    checkoutBtn.textContent = 'Enviando...';
    persistOrder(ids).then(() => {
      window.open(waLink(buildOrderMessage(ids)), '_blank', 'noopener');
      checkoutBtn.classList.remove('is-loading');
      checkoutBtn.textContent = 'Finalizar no WhatsApp';
    }).catch((err) => {
      bagFormError.textContent = err.message;
      bagFormError.hidden = false;
      checkoutBtn.classList.remove('is-loading');
      checkoutBtn.textContent = 'Finalizar no WhatsApp';
      init();
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
      couponStatus.innerHTML = `Cupom <strong>${coupon.code}</strong> aplicado ✓ <button type="button" class="coupon-remove">remover</button>`;
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
          <img src="${p.img}" alt="${p.name}" />
          <div class="bag-item-info">
            <div class="bag-item-name">${p.name}${variant ? ` <span class="bag-item-variant">(${variantLabel(variant)})</span>` : ''}</div>
            ${priceHtml}
            <div class="bag-item-qty">
              <button class="qty-btn" data-key="${key}" data-op="dec">−</button>
              <span>${qty}</span>
              <button class="qty-btn" data-key="${key}" data-op="inc">+</button>
            </div>
            <button class="bag-item-remove" data-key="${key}">remover</button>
          </div>
        `;
        bagItemsEl.appendChild(row);
      });
    }

    const subtotal = cartSubtotal(keys);
    const discount = cartDiscountInfo(keys);
    const final = cartFinalTotal(keys);
    const hasDiscount = !!discount && final < subtotal;

    bagSubtotalRow.hidden = !hasDiscount;
    bagDiscountRow.hidden = !hasDiscount;
    if (hasDiscount) {
      bagSubtotalEl.textContent = money(subtotal);
      bagDiscountLabelEl.textContent = discount.label;
      bagDiscountValueEl.textContent = `- ${money(discount.amount)}`;
    }
    bagTotalEl.textContent = money(final) === 'Sob consulta' ? 'R$ 0,00' : money(final);

    bagDetails.hidden = keys.length === 0;
    if (keys.length === 0) {
      checkoutBtn.href = waLink('Olá! Vim pelo site da By NaNa 💛');
      bagFormError.hidden = true;
    }

    showCouponStatus();
    syncAddButtons();
  }

  const cartAnnouncer = document.getElementById('cartAnnouncer');
  function announce(text) {
    if (cartAnnouncer) cartAnnouncer.textContent = text;
  }

  function addToCart(productId, variantId) {
    const product = PRODUCTS.find((p) => p.id === productId);
    const variant = product && variantId ? (product.variants || []).find((v) => v.id === variantId) : null;
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
    announce(product ? `${product.name} adicionada à sacola.` : 'Peça adicionada à sacola.');
    return true;
  }

  document.addEventListener('click', (e) => {
    const favBtn = e.target.closest('.fav-btn');
    if (favBtn) {
      e.stopPropagation();
      toggleFav(favBtn.dataset.id);
      return;
    }
    const media = e.target.closest('.product-media');
    if (media && !e.target.closest('.fav-btn')) {
      openQuickview(media.dataset.id);
      return;
    }
    const chip = e.target.closest('.variant-chip');
    if (chip) {
      if (chip.disabled) return;
      const picker = chip.closest('.variant-picker');
      picker.querySelectorAll('.variant-chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      const addBtnForChip =
        picker.id === 'qvVariantPicker' ? qvAdd : picker.closest('.product-card, .rel-card')?.querySelector('.add-btn');
      if (addBtnForChip) {
        addBtnForChip.dataset.variantId = chip.dataset.variantId;
        syncAddButton(addBtnForChip);
      }
      return;
    }
    const addBtn = e.target.closest('.add-btn');
    if (addBtn) {
      if (addBtn.disabled) return;
      if (addToCart(addBtn.dataset.id, addBtn.dataset.variantId || null)) openBag();
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
    closeQuickview();
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

  // ---------- quick view ----------
  const qvOverlay = document.getElementById('qvOverlay');
  const quickview = document.getElementById('quickview');
  const qvImg = document.getElementById('qvImg');
  const qvBrand = document.getElementById('qvBrand');
  const qvName = document.getElementById('qvName');
  const qvPrice = document.getElementById('qvPrice');
  const qvPriceOld = document.getElementById('qvPriceOld');
  const qvDiscountBadge = document.getElementById('qvDiscountBadge');
  const qvDesc = document.getElementById('qvDesc');
  const qvLowStock = document.getElementById('qvLowStock');
  const qvColorDots = document.getElementById('qvColorDots');
  const qvVariantPicker = document.getElementById('qvVariantPicker');
  const qvAdd = document.getElementById('qvAdd');
  const qvAsk = document.getElementById('qvAsk');
  const qvFav = document.getElementById('qvFav');
  const qvRelatedGrid = document.getElementById('qvRelatedGrid');
  const qvInfoEl = document.querySelector('.qv-info');
  const qvStickyBar = document.getElementById('qvStickyBar');
  const qvStickyImg = document.getElementById('qvStickyImg');
  const qvStickyName = document.getElementById('qvStickyName');
  const qvStickyPrice = document.getElementById('qvStickyPrice');
  const qvStickyAdd = document.getElementById('qvStickyAdd');
  const QV_STICKY_SCROLL_THRESHOLD = 160;
  let qvCurrentId = null;

  function handleQvScroll() {
    qvStickyBar.classList.toggle('is-visible', qvInfoEl.scrollTop > QV_STICKY_SCROLL_THRESHOLD);
  }

  function syncQuickviewFav() {
    if (!qvCurrentId) return;
    const isFav = favs.has(qvCurrentId);
    qvFav.textContent = isFav ? '♥ Nos favoritos' : '♡ Salvar nos favoritos';
    qvFav.classList.toggle('is-fav', isFav);
  }

  function openQuickview(id) {
    const p = PRODUCTS.find((x) => x.id === id);
    if (!p) return;
    qvCurrentId = id;
    qvImg.src = p.img;
    qvImg.alt = p.name;
    qvBrand.textContent = p.brand;
    qvName.textContent = p.name;
    const { price, promo } = getEffective(p);
    qvPrice.textContent = money(price);
    qvPrice.classList.toggle('consult', p.price == null);
    qvPrice.classList.toggle('is-promo', !!promo);
    qvPriceOld.textContent = promo ? money(p.price) : '';
    qvPriceOld.hidden = !promo;
    qvDiscountBadge.textContent = promo ? `-${promo.percent}%` : '';
    qvDiscountBadge.hidden = !promo;
    qvDesc.textContent = p.desc;

    const variants = p.variants || [];
    const inStock = variants.filter((v) => v.stock > 0);
    const soldOut = p.hasVariants && inStock.length === 0;
    const defaultVariant = inStock[0] || null;
    qvLowStock.hidden = !isLowStock(p, soldOut);
    qvColorDots.innerHTML = colorDotsHtml(variants);
    if (p.hasVariants) {
      qvVariantPicker.hidden = false;
      qvVariantPicker.innerHTML = variants
        .map(
          (v) => `<button type="button" class="variant-chip${v.stock <= 0 ? ' is-soldout' : ''}${defaultVariant && v.id === defaultVariant.id ? ' is-active' : ''}" data-variant-id="${v.id}" ${v.stock <= 0 ? 'disabled' : ''}>${variantLabel(v)}</button>`
        )
        .join('');
    } else {
      qvVariantPicker.hidden = true;
      qvVariantPicker.innerHTML = '';
    }

    qvAdd.dataset.id = p.id;
    if (defaultVariant) qvAdd.dataset.variantId = defaultVariant.id;
    else delete qvAdd.dataset.variantId;
    qvAdd.classList.toggle('is-soldout', soldOut);
    qvAdd.disabled = soldOut;
    if (soldOut) qvAdd.textContent = 'Esgotado';
    else syncAddButton(qvAdd);
    qvAsk.href = waLink(`Olá! Tenho interesse na peça "${p.name}" que vi no catálogo By NaNa. Pode me passar mais detalhes?`);
    syncQuickviewFav();

    const related = PRODUCTS.filter((x) => x.category === p.category && x.id !== p.id).slice(0, 3);
    qvRelatedGrid.innerHTML = related
      .map(
        (r) => `
      <div class="rel-card" data-id="${r.id}">
        <img src="${r.img}" alt="${r.name}" />
        <span>${r.name}</span>
      </div>`
      )
      .join('');

    qvStickyImg.src = p.img;
    qvStickyImg.alt = p.name;
    qvStickyName.textContent = p.name;
    qvStickyPrice.textContent = money(price);
    qvStickyBar.classList.remove('is-visible');
    qvInfoEl.scrollTop = 0;
    qvInfoEl.addEventListener('scroll', handleQvScroll);

    qvOverlay.classList.add('is-open');
    quickview.classList.add('is-open');
    openModalFocus(quickview);
  }

  function closeQuickview() {
    if (!quickview.classList.contains('is-open')) return;
    qvOverlay.classList.remove('is-open');
    quickview.classList.remove('is-open');
    qvInfoEl.removeEventListener('scroll', handleQvScroll);
    qvStickyBar.classList.remove('is-visible');
    qvCurrentId = null;
    closeModalFocus(quickview);
  }

  qvOverlay.addEventListener('click', closeQuickview);
  document.getElementById('qvClose').addEventListener('click', closeQuickview);
  // adicionar à sacola é tratado pelo delegate global de ".add-btn" (qvAdd tem essa classe) —
  // um listener dedicado aqui duplicava addToCart() a cada clique (bug corrigido nesta revisão).
  qvFav.addEventListener('click', () => qvCurrentId && toggleFav(qvCurrentId));
  qvStickyAdd.addEventListener('click', () => qvAdd.click());
  qvRelatedGrid.addEventListener('click', (e) => {
    const rel = e.target.closest('.rel-card');
    if (rel) openQuickview(rel.dataset.id);
  });

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
              ? `<img src="${s.cover}" alt="${s.title || 'Story'}" />`
              : `<video src="${s.video}" preload="metadata" muted playsinline></video>`
          }
        </span>
        ${s.title ? `<span class="story-bubble-label">${s.title}</span>` : ''}
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
      storyCta.removeAttribute('href');
      storyCta.dataset.productId = product.id;
      storyCta.textContent = story.linkLabel && story.linkLabel !== 'Ver mais' ? story.linkLabel : 'Ver produto';
      storyCta.hidden = false;
    } else if (story.linkUrl) {
      delete storyCta.dataset.productId;
      storyCta.href = story.linkUrl;
      storyCta.textContent = story.linkLabel || 'Ver mais';
      storyCta.hidden = false;
    } else {
      delete storyCta.dataset.productId;
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
  storyCta.addEventListener('click', (e) => {
    if (storyCta.dataset.productId) {
      e.preventDefault();
      const id = storyCta.dataset.productId;
      closeStoryViewer();
      openQuickview(id);
    }
  });
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
  const accountViewSignup = document.getElementById('accountViewSignup');
  const accountViewProfile = document.getElementById('accountViewProfile');
  const loginForm = document.getElementById('loginForm');
  const loginMsg = document.getElementById('loginMsg');
  const signupForm = document.getElementById('signupForm');
  const signupMsg = document.getElementById('signupMsg');
  const profileName = document.getElementById('profileName');
  const bagNameInput = document.getElementById('bagName');
  const bagPhoneInput = document.getElementById('bagPhone');

  let currentCustomer = JSON.parse(localStorage.getItem(CUSTOMER_KEY) || 'null');

  function setFormMsg(el, text, kind) {
    el.textContent = text;
    el.className = `account-form-msg ${kind === 'ok' ? 'is-ok' : 'is-error'}`;
    el.hidden = !text;
  }

  function showAccountView(view) {
    accountViewLogin.hidden = view !== 'login';
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
  }

  function updateAccountButton() {
    accountBtn.classList.toggle('is-logged', !!currentCustomer);
    accountBtn.title = currentCustomer ? `Olá, ${currentCustomer.firstName}` : 'Minha conta';
    if (currentCustomer) {
      profileName.textContent = currentCustomer.firstName;
      prefillBagContact();
    }
  }
  updateAccountButton();

  function setCustomer(customer, token) {
    currentCustomer = customer;
    localStorage.setItem(CUSTOMER_KEY, JSON.stringify(customer));
    if (token) localStorage.setItem(CUSTOMER_TOKEN_KEY, token);
    updateAccountButton();
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
      syncQuickviewFav();
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
  }

  accountBtn.addEventListener('click', openAccountModal);
  document.getElementById('accountClose').addEventListener('click', closeAccountModal);
  accountOverlay.addEventListener('click', closeAccountModal);
  document.getElementById('goSignup').addEventListener('click', () => showAccountView('signup'));
  document.getElementById('goLogin').addEventListener('click', () => showAccountView('login'));
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
      profileOrderList.innerHTML = `<p class="bag-empty">${err.message}</p>`;
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
        const itemsText = (o.items || []).map((it) => `${it.qty}x ${it.name}${it.variantLabel ? ` (${it.variantLabel})` : ''}`).join(', ');
        const statusLabel = PROFILE_ORDER_STATUS_LABELS[o.status] || o.status;
        return `
          <div class="profile-order-item">
            <div class="profile-order-header"><span>${when}</span><span>${money(o.total)}</span></div>
            <p class="profile-order-items">${itemsText}</p>
            <span class="profile-order-meta">${o.paymentMethod} · ${o.deliveryMethod}${o.couponCode ? ` · cupom ${o.couponCode}` : ''}</span>
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
      profileAddressList.innerHTML = `<p class="bag-empty">${err.message}</p>`;
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
          <span class="profile-address-label">${a.label || 'Endereço'}</span>
          <span class="profile-address-meta">${a.rua}, ${a.numero}${a.complemento ? ` - ${a.complemento}` : ''} - ${a.bairro}, ${a.cidade}/${a.estado} - CEP ${a.cep}</span>
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
      closeQuickview();
      closeBag();
    }
    if (storyViewer.classList.contains('is-open')) {
      if (e.key === 'ArrowRight') nextStory();
      else if (e.key === 'ArrowLeft') prevStory();
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

  async function init() {
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
      CATEGORY_GROUPS = data.categoryGroups || [];
      CATEGORY_CONTENT = data.categoryContent || [];
      STORIES = data.stories || [];
      NOVIDADES = data.novidades || [];
    } catch (e) {
      loadBar.classList.remove('is-active');
      grid.innerHTML = '';
      emptyState.hidden = true;
      dataError.hidden = false;
      return;
    }

    loadBar.classList.remove('is-active');
    loadBar.classList.add('is-done');
    buildFilters();
    buildCatCards();
    buildMegaMenu();
    buildCollectionFilter();
    buildSecondaryFilters();
    renderPromoBanner();
    renderGrid('Todos', '');
    renderNovidades();
    renderStoriesRail();
    renderCart();
    restoreSession();
  }

  dataErrorRetry.addEventListener('click', init);

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
  init();
})();
