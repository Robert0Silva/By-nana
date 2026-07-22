(() => {
  const PASS_KEY = 'bynana_admin_pass';

  const loginScreen = document.getElementById('loginScreen');
  const adminApp = document.getElementById('adminApp');
  const loginForm = document.getElementById('loginForm');
  const loginPassword = document.getElementById('loginPassword');
  const loginError = document.getElementById('loginError');

  let PASSWORD = sessionStorage.getItem(PASS_KEY) || '';

  let CATEGORIES = [];
  let COLLECTIONS = [];
  let PRODUCTS = [];
  let PROMOTIONS = [];
  let COUPONS = [];

  const money = (v) =>
    v == null ? 'Sob consulta' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const formatDate = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  };

  async function api(path, method, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, password: PASSWORD }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro inesperado');
    return data;
  }

  async function loadData() {
    const res = await fetch('/api/data', { cache: 'no-store' });
    const data = await res.json();
    PRODUCTS = data.products || [];
    CATEGORIES = data.categories || [];
    COLLECTIONS = data.collections || [];
    PROMOTIONS = data.promotions || [];
    COUPONS = data.coupons || [];
    renderCategories();
    renderCollections();
    renderCategorySelect();
    renderCollectionSelect();
    renderProductList();
    renderPromoTargetOptions();
    renderPromoList();
    renderCouponList();
    loadSiteImages();
  }

  // ---------- tabs ----------
  document.querySelectorAll('.admin-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.admin-panel').forEach((p) => {
        p.hidden = p.id !== `panel-${btn.dataset.target}`;
      });
    });
  });

  // ---------- login ----------
  async function tryLogin(password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    return !!data.ok;
  }

  async function showApp() {
    loginScreen.hidden = true;
    adminApp.hidden = false;
    await loadData();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const pass = loginPassword.value;
    const ok = await tryLogin(pass);
    if (!ok) {
      loginError.hidden = false;
      return;
    }
    PASSWORD = pass;
    sessionStorage.setItem(PASS_KEY, pass);
    showApp();
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem(PASS_KEY);
    PASSWORD = '';
    adminApp.hidden = true;
    loginScreen.hidden = false;
    loginPassword.value = '';
  });

  // ---------- categories ----------
  const categoryList = document.getElementById('categoryList');
  const categoryForm = document.getElementById('categoryForm');
  const categoryName = document.getElementById('categoryName');

  function renderCategories() {
    categoryList.innerHTML = '';
    if (!CATEGORIES.length) {
      categoryList.innerHTML = '<li class="admin-empty">Nenhuma categoria ainda.</li>';
      return;
    }
    CATEGORIES.forEach((c) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${c}</span><button type="button" aria-label="Remover">✕</button>`;
      li.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Remover a categoria "${c}"?`)) return;
        try {
          const data = await api('/api/categories', 'DELETE', { name: c });
          CATEGORIES = data.categories;
          renderCategories();
          renderCategorySelect();
          renderPromoTargetOptions();
        } catch (err) {
          alert(err.message);
        }
      });
      categoryList.appendChild(li);
    });
  }

  categoryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = categoryName.value.trim();
    if (!name) return;
    try {
      const data = await api('/api/categories', 'POST', { name });
      CATEGORIES = data.categories;
      categoryName.value = '';
      renderCategories();
      renderCategorySelect();
      renderPromoTargetOptions();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------- collections ----------
  const collectionList = document.getElementById('collectionList');
  const collectionForm = document.getElementById('collectionForm');
  const collectionName = document.getElementById('collectionName');

  function renderCollections() {
    collectionList.innerHTML = '';
    if (!COLLECTIONS.length) {
      collectionList.innerHTML = '<li class="admin-empty">Nenhuma coleção ainda.</li>';
      return;
    }
    COLLECTIONS.forEach((c) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${c}</span><button type="button" aria-label="Remover">✕</button>`;
      li.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Remover a coleção "${c}"?`)) return;
        const data = await api('/api/collections', 'DELETE', { name: c });
        COLLECTIONS = data.collections;
        renderCollections();
        renderCollectionSelect();
        renderPromoTargetOptions();
      });
      collectionList.appendChild(li);
    });
  }

  collectionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = collectionName.value.trim();
    if (!name) return;
    try {
      const data = await api('/api/collections', 'POST', { name });
      COLLECTIONS = data.collections;
      collectionName.value = '';
      renderCollections();
      renderCollectionSelect();
      renderPromoTargetOptions();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------- product form selects ----------
  const pCategory = document.getElementById('pCategory');
  const pCollection = document.getElementById('pCollection');

  function renderCategorySelect() {
    const current = pCategory.value;
    pCategory.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');
    if (CATEGORIES.includes(current)) pCategory.value = current;
  }

  function renderCollectionSelect() {
    const current = pCollection.value;
    pCollection.innerHTML =
      '<option value="">Nenhuma</option>' + COLLECTIONS.map((c) => `<option value="${c}">${c}</option>`).join('');
    if (COLLECTIONS.includes(current)) pCollection.value = current;
  }

  // ---------- product form ----------
  const productForm = document.getElementById('productForm');
  const pImage = document.getElementById('pImage');
  const pPreview = document.getElementById('pPreview');
  const pSubmit = document.getElementById('pSubmit');
  const productMsg = document.getElementById('productMsg');

  let imageDataUrl = '';

  pImage.addEventListener('change', () => {
    const file = pImage.files[0];
    if (!file) {
      pPreview.hidden = true;
      imageDataUrl = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      imageDataUrl = reader.result;
      pPreview.src = imageDataUrl;
      pPreview.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  function setMsg(text, kind) {
    productMsg.textContent = text;
    productMsg.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
    productMsg.hidden = !text;
  }

  productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('', '');

    if (!CATEGORIES.length) {
      setMsg('Cadastre ao menos uma categoria antes de adicionar um produto.', 'error');
      return;
    }
    if (!imageDataUrl) {
      setMsg('Selecione uma foto do produto.', 'error');
      return;
    }

    pSubmit.disabled = true;
    pSubmit.textContent = 'Publicando...';

    try {
      const data = await api('/api/products', 'POST', {
        name: document.getElementById('pName').value.trim(),
        brand: document.getElementById('pBrand').value.trim(),
        category: pCategory.value,
        collection: pCollection.value,
        tag: document.getElementById('pTag').value.trim(),
        price: document.getElementById('pPrice').value,
        desc: document.getElementById('pDesc').value.trim(),
        image: imageDataUrl,
      });

      PRODUCTS.unshift(data.product);
      CATEGORIES = data.categories;
      COLLECTIONS = data.collections;
      renderCategories();
      renderCollections();
      renderCategorySelect();
      renderCollectionSelect();
      renderProductList();
      renderPromoTargetOptions();

      productForm.reset();
      document.getElementById('pBrand').value = 'By NaNa';
      pPreview.hidden = true;
      imageDataUrl = '';
      setMsg('Produto publicado no catálogo ✓', 'ok');
    } catch (err) {
      setMsg(err.message, 'error');
    } finally {
      pSubmit.disabled = false;
      pSubmit.textContent = 'Publicar no catálogo';
    }
  });

  // ---------- product list ----------
  const productList = document.getElementById('productList');
  const productCount = document.getElementById('productCount');

  function renderProductList() {
    productCount.textContent = PRODUCTS.length;
    productList.innerHTML = '';
    PRODUCTS.forEach((p) => {
      const promo = window.PromoEngine.bestPromoForProduct(p, PROMOTIONS);
      const priceHtml = promo
        ? `<span class="admin-product-item-price"><s>${money(p.price)}</s> ${money(promo.price)} <em>(-${promo.percent}%)</em></span>`
        : `<span class="admin-product-item-price">${money(p.price)}</span>`;
      const div = document.createElement('div');
      div.className = 'admin-product-item';
      div.innerHTML = `
        <img src="${p.img}" alt="${p.name}" />
        <div class="admin-product-item-body">
          <span class="admin-product-item-name">${p.name}</span>
          <span class="admin-product-item-meta">${p.category}${p.collection ? ` · ${p.collection}` : ''}</span>
          ${priceHtml}
          <button type="button" data-id="${p.id}">Remover do catálogo</button>
        </div>
      `;
      div.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Remover "${p.name}" do catálogo?`)) return;
        try {
          const data = await api('/api/products', 'DELETE', { id: p.id });
          PRODUCTS = data.products;
          renderProductList();
          renderPromoTargetOptions();
        } catch (err) {
          alert(err.message);
        }
      });
      productList.appendChild(div);
    });
  }

  // ---------- promotions ----------
  const promoForm = document.getElementById('promoForm');
  const promoScope = document.getElementById('promoScope');
  const promoTargetWrap = document.getElementById('promoTargetWrap');
  const promoTarget = document.getElementById('promoTarget');
  const promoType = document.getElementById('promoType');
  const promoValue = document.getElementById('promoValue');
  const promoStart = document.getElementById('promoStart');
  const promoEnd = document.getElementById('promoEnd');
  const promoLabel = document.getElementById('promoLabel');
  const promoSubmit = document.getElementById('promoSubmit');
  const promoMsg = document.getElementById('promoMsg');
  const promoList = document.getElementById('promoList');

  function setPromoMsg(text, kind) {
    promoMsg.textContent = text;
    promoMsg.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
    promoMsg.hidden = !text;
  }

  function renderPromoTargetOptions() {
    const scope = promoScope.value;
    promoTargetWrap.hidden = scope === 'site';
    if (scope === 'product') {
      promoTarget.innerHTML = PRODUCTS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    } else if (scope === 'category') {
      promoTarget.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');
    } else if (scope === 'collection') {
      promoTarget.innerHTML = COLLECTIONS.map((c) => `<option value="${c}">${c}</option>`).join('');
    } else {
      promoTarget.innerHTML = '';
    }
  }

  promoScope.addEventListener('change', renderPromoTargetOptions);

  function promoTargetLabel(promo) {
    if (promo.scope === 'site') return 'Loja inteira';
    if (promo.scope === 'product') {
      const p = PRODUCTS.find((x) => x.id === promo.target);
      return `Produto: ${p ? p.name : promo.target}`;
    }
    if (promo.scope === 'category') return `Categoria: ${promo.target}`;
    return `Coleção: ${promo.target}`;
  }

  function promoPeriodLabel(promo) {
    if (promo.startDate && promo.endDate) return `${formatDate(promo.startDate)} até ${formatDate(promo.endDate)}`;
    if (promo.startDate) return `a partir de ${formatDate(promo.startDate)}`;
    if (promo.endDate) return `até ${formatDate(promo.endDate)}`;
    return 'sem data definida — vale até você remover';
  }

  function renderPromoList() {
    promoList.innerHTML = '';
    if (!PROMOTIONS.length) {
      promoList.innerHTML = '<p class="admin-empty-block">Nenhuma promoção cadastrada ainda.</p>';
      return;
    }
    PROMOTIONS.forEach((promo) => {
      const status = window.PromoEngine.promoStatus(promo);
      const statusLabel = { ativa: 'Ativa agora', agendada: 'Agendada', expirada: 'Expirada' }[status];
      const discountText = promo.type === 'percent' ? `${promo.value}% OFF` : `${money(promo.value)} OFF`;
      const div = document.createElement('div');
      div.className = 'admin-promo-item';
      div.innerHTML = `
        <div class="admin-promo-info">
          <span class="admin-promo-title">${promo.label ? `${promo.label} — ` : ''}${promoTargetLabel(promo)} · ${discountText}</span>
          <span class="admin-promo-meta">${promoPeriodLabel(promo)}</span>
        </div>
        <div class="admin-promo-actions">
          <span class="admin-promo-status is-${status}">${statusLabel}</span>
          <button type="button" class="admin-promo-remove" aria-label="Remover promoção">✕</button>
        </div>
      `;
      div.querySelector('.admin-promo-remove').addEventListener('click', async () => {
        if (!confirm('Remover esta promoção?')) return;
        try {
          const data = await api('/api/promotions', 'DELETE', { id: promo.id });
          PROMOTIONS = data.promotions;
          renderPromoList();
          renderProductList();
        } catch (err) {
          alert(err.message);
        }
      });
      promoList.appendChild(div);
    });
  }

  promoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setPromoMsg('', '');
    promoSubmit.disabled = true;
    try {
      const data = await api('/api/promotions', 'POST', {
        scope: promoScope.value,
        target: promoScope.value === 'site' ? '' : promoTarget.value,
        type: promoType.value,
        value: promoValue.value,
        startDate: promoStart.value,
        endDate: promoEnd.value,
        label: promoLabel.value.trim(),
      });
      PROMOTIONS = data.promotions;
      renderPromoList();
      renderProductList();
      promoForm.reset();
      renderPromoTargetOptions();
      setPromoMsg('Promoção aplicada ✓', 'ok');
    } catch (err) {
      setPromoMsg(err.message, 'error');
    } finally {
      promoSubmit.disabled = false;
    }
  });

  // ---------- coupons ----------
  const couponForm = document.getElementById('couponForm');
  const couponCode = document.getElementById('couponCode');
  const couponType = document.getElementById('couponType');
  const couponValue = document.getElementById('couponValue');
  const couponEnd = document.getElementById('couponEnd');
  const couponSubmit = document.getElementById('couponSubmit');
  const couponMsg = document.getElementById('couponMsg');
  const couponList = document.getElementById('couponList');

  function setCouponMsg(text, kind) {
    couponMsg.textContent = text;
    couponMsg.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
    couponMsg.hidden = !text;
  }

  function renderCouponList() {
    couponList.innerHTML = '';
    if (!COUPONS.length) {
      couponList.innerHTML = '<li class="admin-empty">Nenhum cupom criado ainda.</li>';
      return;
    }
    COUPONS.forEach((c) => {
      const discountText = c.type === 'percent' ? `${c.value}% OFF` : `${money(c.value)} OFF`;
      const validity = c.endDate ? ` · válido até ${formatDate(c.endDate)}` : '';
      const li = document.createElement('li');
      li.innerHTML = `<span>${c.code} — ${discountText}${validity}</span><button type="button" aria-label="Remover">✕</button>`;
      li.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Remover o cupom "${c.code}"?`)) return;
        const data = await api('/api/coupons', 'DELETE', { code: c.code });
        COUPONS = data.coupons;
        renderCouponList();
      });
      couponList.appendChild(li);
    });
  }

  couponForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setCouponMsg('', '');
    couponSubmit.disabled = true;
    try {
      const data = await api('/api/coupons', 'POST', {
        code: couponCode.value.trim(),
        type: couponType.value,
        value: couponValue.value,
        endDate: couponEnd.value,
      });
      COUPONS = data.coupons;
      renderCouponList();
      couponForm.reset();
      setCouponMsg('Cupom criado ✓', 'ok');
    } catch (err) {
      setCouponMsg(err.message, 'error');
    } finally {
      couponSubmit.disabled = false;
    }
  });

  // ---------- site images ----------
  const siteImageList = document.getElementById('siteImageList');

  async function loadSiteImages() {
    const res = await fetch('/api/site-images', { cache: 'no-store' });
    const data = await res.json();
    const images = data.images || [];
    siteImageList.innerHTML = '';
    images.forEach((img) => {
      const card = document.createElement('div');
      card.className = 'admin-site-image-card';
      card.innerHTML = `
        <img src="${img.path}?t=${Date.now()}" alt="${img.label}" class="admin-site-image-preview" />
        <div class="admin-site-image-body">
          <span class="admin-site-image-label">${img.label}</span>
          <label class="btn btn-outline admin-site-image-upload">
            Trocar foto
            <input type="file" accept="image/*" data-slot="${img.slot}" hidden />
          </label>
          <p class="admin-form-msg" hidden></p>
        </div>
      `;
      siteImageList.appendChild(card);
    });
  }

  siteImageList.addEventListener('change', (e) => {
    const input = e.target.closest('input[type="file"]');
    if (!input || !input.files[0]) return;
    const slot = input.dataset.slot;
    const card = input.closest('.admin-site-image-card');
    const previewImg = card.querySelector('.admin-site-image-preview');
    const msg = card.querySelector('.admin-form-msg');
    const file = input.files[0];

    const reader = new FileReader();
    reader.onload = async () => {
      msg.textContent = 'Enviando...';
      msg.className = 'admin-form-msg';
      msg.hidden = false;
      try {
        const data = await api('/api/site-images', 'POST', { slot, image: reader.result });
        previewImg.src = `${data.path}?t=${Date.now()}`;
        msg.textContent = 'Imagem atualizada ✓';
        msg.className = 'admin-form-msg is-ok';
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'admin-form-msg is-error';
      } finally {
        input.value = '';
      }
    };
    reader.readAsDataURL(file);
  });

  // ---------- boot ----------
  (async () => {
    if (PASSWORD) {
      const ok = await tryLogin(PASSWORD);
      if (ok) {
        showApp();
        return;
      }
      sessionStorage.removeItem(PASS_KEY);
      PASSWORD = '';
    }
    loginScreen.hidden = false;
  })();
})();
