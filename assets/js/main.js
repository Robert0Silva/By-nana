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
  let STORIES = [];

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

  function cartSubtotal(ids) {
    return ids.reduce((sum, id) => {
      const p = PRODUCTS.find((x) => x.id === id);
      if (!p) return sum;
      const { price } = getEffective(p);
      return price ? sum + price * cart[id] : sum;
    }, 0);
  }

  function cartFinalTotal(ids) {
    const subtotal = cartSubtotal(ids);
    const coupon = activeCoupon();
    return coupon ? window.PromoEngine.applyCoupon(subtotal, coupon) : subtotal;
  }

  const waLink = (text) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;

  // basic greeting links used across the page
  document.querySelectorAll('#quickWhats, #ctaWhats, #footerWhats, #floatWhats').forEach((el) => {
    el.href = waLink('Olá! Vim pelo site da By NaNa e queria saber mais sobre as peças 💛');
  });

  // ---------- cart (sacola) ----------
  const CART_KEY = 'bynana_cart';
  let cart = JSON.parse(localStorage.getItem(CART_KEY) || '{}');

  // ---------- favorites ----------
  const FAV_KEY = 'bynana_favs';
  let favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
  function saveFavs() {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  }
  function toggleFav(id) {
    if (favs.has(id)) favs.delete(id);
    else favs.add(id);
    saveFavs();
    renderGrid(currentFilter, currentSearch);
    renderNovidades();
    syncQuickviewFav();
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
    div.innerHTML = `
      <div class="product-media" data-id="${p.id}">
        <img src="${p.img}" alt="${p.name}" loading="lazy" />
        <div class="product-badges">
          <span class="product-tag">${p.tag}</span>
          ${promo ? `<span class="discount-badge">-${promo.percent}%</span>` : ''}
        </div>
        <button class="fav-btn ${isFav ? 'is-fav' : ''}" data-id="${p.id}" aria-label="Favoritar">${isFav ? '♥' : '♡'}</button>
      </div>
      <div class="product-body">
        <span class="product-cat">${p.brand}${p.collection ? ` · ${p.collection}` : ''}</span>
        <h3 class="product-name">${p.name}</h3>
        <div class="product-price-row">${priceHtml}</div>
        <div class="product-actions">
          <button class="add-btn" data-id="${p.id}">Adicionar à sacola</button>
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

    emptyState.hidden = list.length !== 0;
    list.forEach((p) => grid.appendChild(productCard(p)));
    syncAddButtons();
  }

  // ---------- filters + search (built dynamically from categories/collections) ----------
  const filtersEl = document.getElementById('filters');
  const catGrid = document.querySelector('.cat-grid');
  const collectionWrap = document.getElementById('collectionFilterWrap');

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
    PRODUCTS.slice(0, 8).forEach((p) => novidadesGrid.appendChild(productCard(p)));
  }

  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', () => {
    renderGrid(currentFilter, searchInput.value.trim().toLowerCase());
  });

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
    });
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

  function buildOrderMessage(ids) {
    let msg = 'Olá! Vim pelo site da By NaNa e quero fazer um pedido:\n\n';
    msg += `Nome: ${bagNameInput.value.trim()}\nTelefone: ${bagPhoneInput.value.trim()}\n\n`;
    ids.forEach((id) => {
      const p = PRODUCTS.find((x) => x.id === id);
      if (!p) return;
      const { price, promo } = getEffective(p);
      const priceText = promo ? `${money(price)} (de ${money(p.price)})` : money(price);
      msg += `• ${cart[id]}x ${p.name} — ${priceText}\n`;
    });
    const subtotal = cartSubtotal(ids);
    const coupon = activeCoupon();
    if (coupon) {
      msg += `\nSubtotal (itens com preço): ${money(subtotal)}`;
      const discountText = coupon.type === 'percent' ? `${coupon.value}%` : money(coupon.value);
      msg += `\n🏷️ Cupom ${coupon.code} (-${discountText})`;
      msg += `\nTotal: ${money(cartFinalTotal(ids))}`;
    } else {
      msg += `\nTotal (itens com preço): ${money(subtotal)}`;
    }
    msg += `\n\n💳 Pagamento: ${selectedPayment}`;
    msg += `\n🚚 Entrega: ${selectedDelivery}`;
    if (selectedDelivery === 'Entrega') {
      const a = address;
      msg += `\n📍 Endereço: ${a.rua}, ${a.numero}${a.complemento ? ` - ${a.complemento}` : ''} - ${a.bairro}, ${a.cidade}/${a.estado} - CEP ${a.cep}`;
    }
    return msg;
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
    window.open(waLink(buildOrderMessage(ids)), '_blank', 'noopener');
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

  function syncAddButtons() {
    document.querySelectorAll('.add-btn').forEach((btn) => {
      const has = !!cart[btn.dataset.id];
      btn.textContent = has ? 'Adicionado ✓' : 'Adicionar à sacola';
      btn.classList.toggle('is-added', has);
    });
  }

  function renderCart() {
    const ids = Object.keys(cart);
    const totalQty = ids.reduce((sum, id) => sum + cart[id], 0);
    bagCount.textContent = totalQty;

    if (totalQty === 0) {
      mobileBar.classList.remove('is-visible');
    } else {
      mobileBarText.textContent = `${totalQty} ${totalQty === 1 ? 'peça' : 'peças'} na sacola`;
      mobileBar.classList.add('is-visible');
    }

    if (ids.length === 0) {
      bagItemsEl.innerHTML = '<p class="bag-empty">Sua sacola está vazia. Adicione uma peça do catálogo 🤍</p>';
    } else {
      bagItemsEl.innerHTML = '';
      ids.forEach((id) => {
        const p = PRODUCTS.find((x) => x.id === id);
        if (!p) return;
        const qty = cart[id];
        const { price, promo } = getEffective(p);
        const priceHtml = promo
          ? `<span class="bag-item-price-old">${money(p.price)}</span><span class="bag-item-price is-promo">${money(price)}</span>`
          : `<span class="bag-item-price">${money(price)}</span>`;
        const row = document.createElement('div');
        row.className = 'bag-item';
        row.innerHTML = `
          <img src="${p.img}" alt="${p.name}" />
          <div class="bag-item-info">
            <div class="bag-item-name">${p.name}</div>
            ${priceHtml}
            <div class="bag-item-qty">
              <button class="qty-btn" data-id="${id}" data-op="dec">−</button>
              <span>${qty}</span>
              <button class="qty-btn" data-id="${id}" data-op="inc">+</button>
            </div>
            <button class="bag-item-remove" data-id="${id}">remover</button>
          </div>
        `;
        bagItemsEl.appendChild(row);
      });
    }

    const subtotal = cartSubtotal(ids);
    const coupon = activeCoupon();
    const final = cartFinalTotal(ids);
    const hasCouponDiscount = coupon && final < subtotal;

    bagSubtotalRow.hidden = !hasCouponDiscount;
    bagDiscountRow.hidden = !hasCouponDiscount;
    if (hasCouponDiscount) {
      bagSubtotalEl.textContent = money(subtotal);
      bagDiscountLabelEl.textContent = `Cupom ${coupon.code}`;
      bagDiscountValueEl.textContent = `- ${money(subtotal - final)}`;
    }
    bagTotalEl.textContent = money(final) === 'Sob consulta' ? 'R$ 0,00' : money(final);

    bagDetails.hidden = ids.length === 0;
    if (ids.length === 0) {
      checkoutBtn.href = waLink('Olá! Vim pelo site da By NaNa 💛');
      bagFormError.hidden = true;
    }

    showCouponStatus();
    syncAddButtons();
  }

  function addToCart(id) {
    cart[id] = (cart[id] || 0) + 1;
    saveCart();
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
    const addBtn = e.target.closest('.add-btn');
    if (addBtn) {
      addToCart(addBtn.dataset.id);
      openBag();
      return;
    }
    const qtyBtn = e.target.closest('.qty-btn');
    if (qtyBtn) {
      const id = qtyBtn.dataset.id;
      const op = qtyBtn.dataset.op;
      cart[id] = (cart[id] || 0) + (op === 'inc' ? 1 : -1);
      if (cart[id] <= 0) delete cart[id];
      saveCart();
      return;
    }
    const rmBtn = e.target.closest('.bag-item-remove');
    if (rmBtn) {
      delete cart[rmBtn.dataset.id];
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

  // ---------- bag drawer open/close ----------
  const bagDrawer = document.getElementById('bagDrawer');
  const bagOverlay = document.getElementById('bagOverlay');
  function openBag() {
    closeQuickview();
    prefillBagContact();
    bagDrawer.classList.add('is-open');
    bagOverlay.classList.add('is-open');
  }
  function closeBag() {
    bagDrawer.classList.remove('is-open');
    bagOverlay.classList.remove('is-open');
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
  const qvAdd = document.getElementById('qvAdd');
  const qvAsk = document.getElementById('qvAsk');
  const qvFav = document.getElementById('qvFav');
  const qvRelatedGrid = document.getElementById('qvRelatedGrid');
  let qvCurrentId = null;

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
    qvAdd.dataset.id = p.id;
    qvAdd.textContent = cart[p.id] ? 'Adicionado ✓' : 'Adicionar à sacola';
    qvAdd.classList.toggle('is-added', !!cart[p.id]);
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

    qvOverlay.classList.add('is-open');
    quickview.classList.add('is-open');
  }

  function closeQuickview() {
    qvOverlay.classList.remove('is-open');
    quickview.classList.remove('is-open');
    qvCurrentId = null;
  }

  qvOverlay.addEventListener('click', closeQuickview);
  document.getElementById('qvClose').addEventListener('click', closeQuickview);
  qvAdd.addEventListener('click', () => {
    addToCart(qvAdd.dataset.id);
    qvAdd.textContent = 'Adicionado ✓';
    qvAdd.classList.add('is-added');
  });
  qvFav.addEventListener('click', () => qvCurrentId && toggleFav(qvCurrentId));
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
    storyOverlay.classList.remove('is-open');
    storyViewer.classList.remove('is-open');
    storyVideo.pause();
    storyVideo.removeAttribute('src');
    storyVideo.load();
    currentStoryIndex = -1;
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

  function clearCustomer() {
    currentCustomer = null;
    localStorage.removeItem(CUSTOMER_KEY);
    localStorage.removeItem(CUSTOMER_TOKEN_KEY);
    updateAccountButton();
  }

  function openAccountModal() {
    showAccountView(currentCustomer ? 'profile' : 'login');
    accountOverlay.classList.add('is-open');
    accountModal.classList.add('is-open');
  }
  function closeAccountModal() {
    accountOverlay.classList.remove('is-open');
    accountModal.classList.remove('is-open');
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
      loginForm.reset();
      showAccountView('profile');
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
      signupForm.reset();
      showAccountView('profile');
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
    } catch {
      clearCustomer();
    }
  }

  function formatPhone(v) {
    const digits = v.replace(/\D/g, '').slice(0, 11);
    const pattern = digits.length > 10 ? /(\d{2})(\d{5})(\d{0,4})/ : /(\d{2})(\d{4})(\d{0,4})/;
    return digits.replace(pattern, (_, a, b, c) => (c ? `(${a}) ${b}-${c}` : b ? `(${a}) ${b}` : `(${a}`));
  }
  ['suPhone', 'bagPhone'].forEach((id) => {
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
  const megaTrigger = document.getElementById('megaTrigger');
  const megaItem = megaTrigger.closest('.nav-item');

  document.getElementById('menuToggle').addEventListener('click', () => nav.classList.toggle('is-open'));

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
      closeMegaMenu();
      closeAccountModal();
      closeStoryViewer();
    }
  });

  // fecha o menu mobile (e o mega-menu) ao clicar em qualquer link dentro do nav,
  // via delegação — funciona também para os links do mega-menu, gerados depois via JS
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      nav.classList.remove('is-open');
      closeMegaMenu();
    }
  });

  document.getElementById('year').textContent = new Date().getFullYear();

  // ---------- load catalog from the server ----------
  async function init() {
    try {
      const res = await fetch('/api/data', { cache: 'no-store' });
      const data = await res.json();
      PRODUCTS = data.products || [];
      CATEGORIES = data.categories || [];
      COLLECTIONS = data.collections || [];
      PROMOTIONS = data.promotions || [];
      COUPONS = data.coupons || [];
      CATEGORY_GROUPS = data.categoryGroups || [];
      STORIES = data.stories || [];
    } catch (e) {
      PRODUCTS = [];
      CATEGORIES = [];
      COLLECTIONS = [];
      PROMOTIONS = [];
      COUPONS = [];
      CATEGORY_GROUPS = [];
      STORIES = [];
    }
    buildFilters();
    buildCatCards();
    buildMegaMenu();
    buildCollectionFilter();
    renderPromoBanner();
    renderGrid('Todos', '');
    renderNovidades();
    renderStoriesRail();
    renderCart();
    restoreSession();
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
  init();
})();
