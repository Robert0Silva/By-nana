(() => {
  const TOKEN_KEY = 'bynana_admin_token';

  const loginScreen = document.getElementById('loginScreen');
  const adminApp = document.getElementById('adminApp');
  const loginForm = document.getElementById('loginForm');
  const loginEmail = document.getElementById('loginEmail');
  const loginPassword = document.getElementById('loginPassword');
  const loginError = document.getElementById('loginError');
  const adminCurrentUser = document.getElementById('adminCurrentUser');

  let ADMIN_TOKEN = sessionStorage.getItem(TOKEN_KEY) || '';
  let CURRENT_ADMIN = null;

  let CATEGORIES = [];
  let CATEGORY_GROUPS = [];
  let COLLECTIONS = [];
  let PRODUCTS = [];
  let PROMOTIONS = [];
  let COUPONS = [];
  let CUSTOMERS = [];
  let STORIES = [];
  let ORDERS = [];
  let ADMIN_USERS = [];
  let ACTIVITY = [];

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
      body: JSON.stringify({ ...body, adminToken: ADMIN_TOKEN }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro inesperado');
    return data;
  }

  function updateCurrentUserDisplay() {
    if (!CURRENT_ADMIN) {
      adminCurrentUser.textContent = '';
      return;
    }
    adminCurrentUser.textContent = `${CURRENT_ADMIN.name} · ${CURRENT_ADMIN.role === 'owner' ? 'owner' : 'equipe'}`;
  }

  function applyRoleVisibility() {
    const isOwner = !!CURRENT_ADMIN && CURRENT_ADMIN.role === 'owner';
    document.getElementById('createAdminUserCard').hidden = !isOwner;
  }

  async function loadData() {
    const res = await fetch('/api/data', { cache: 'no-store' });
    const data = await res.json();
    PRODUCTS = data.products || [];
    CATEGORIES = data.categories || [];
    CATEGORY_GROUPS = data.categoryGroups || [];
    COLLECTIONS = data.collections || [];
    PROMOTIONS = data.promotions || [];
    COUPONS = data.coupons || [];
    renderCategories();
    renderCollections();
    renderCategorySelect();
    renderCollectionSelect();
    renderProductList();
    renderFeaturedList();
    renderPromoTargetOptions();
    renderStoryProductSelect();
    renderPromoList();
    renderCouponList();
    loadSiteImages();
    loadCustomers();
    loadStories();
    loadOrders();
    loadAdminUsers();
    loadActivity();
    loadDashboard();
  }

  // ---------- tabs (menu "Catálogo/Marketing/Conteúdo/Vendas" com submenus em dropdown) ----------
  const tabGroups = document.querySelectorAll('.admin-tab-group');

  function closeAllTabGroups() {
    tabGroups.forEach((g) => {
      g.classList.remove('is-open');
      g.querySelector('.admin-tab-group-btn').setAttribute('aria-expanded', 'false');
    });
  }

  function setActiveTabGroupFor(target) {
    tabGroups.forEach((g) => {
      const hasTarget = !!g.querySelector(`.admin-tab[data-target="${target}"]`);
      g.querySelector('.admin-tab-group-btn').classList.toggle('is-active', hasTarget);
    });
  }

  tabGroups.forEach((group) => {
    const groupBtn = group.querySelector('.admin-tab-group-btn');
    groupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !group.classList.contains('is-open');
      closeAllTabGroups();
      if (willOpen) {
        group.classList.add('is-open');
        groupBtn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.admin-tab-group')) closeAllTabGroups();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllTabGroups();
  });

  const TAB_LOAD_HANDLERS = {
    dashboard: () => loadDashboard(),
    'rel-vendas': () => loadSalesReport(),
    'rel-produtos': () => loadProductsReport(),
    'rel-promocoes': () => loadPromotionsReport(),
    'rel-clientes': () => loadCustomersReport(),
  };

  document.querySelectorAll('.admin-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.admin-panel').forEach((p) => {
        p.hidden = p.id !== `panel-${btn.dataset.target}`;
      });
      setActiveTabGroupFor(btn.dataset.target);
      closeAllTabGroups();
      if (TAB_LOAD_HANDLERS[btn.dataset.target]) TAB_LOAD_HANDLERS[btn.dataset.target]();
    });
  });

  setActiveTabGroupFor('dashboard');

  // ---------- login (admin multiusuário: e-mail + senha, token de sessão) ----------
  async function fetchSession(token) {
    const res = await fetch('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminToken: token }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? data.adminUser : null;
  }

  async function showApp() {
    loginScreen.hidden = true;
    adminApp.hidden = false;
    updateCurrentUserDisplay();
    applyRoleVisibility();
    await loadData();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.value.trim(), password: loginPassword.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha no login');
      ADMIN_TOKEN = data.token;
      CURRENT_ADMIN = data.adminUser;
      sessionStorage.setItem(TOKEN_KEY, ADMIN_TOKEN);
      loginForm.reset();
      showApp();
    } catch {
      loginError.hidden = false;
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem(TOKEN_KEY);
    ADMIN_TOKEN = '';
    CURRENT_ADMIN = null;
    adminApp.hidden = true;
    loginScreen.hidden = false;
    loginPassword.value = '';
  });

  // ---------- categories ----------
  const categoryList = document.getElementById('categoryList');
  const categoryForm = document.getElementById('categoryForm');
  const categoryName = document.getElementById('categoryName');
  const categoryGroupList = document.getElementById('categoryGroupList');

  function renderCategoryGroupOptions() {
    const groups = [...new Set(CATEGORY_GROUPS.map((g) => g.groupName).filter(Boolean))];
    categoryGroupList.innerHTML = groups.map((g) => `<option value="${g}"></option>`).join('');
  }

  function renderCategories() {
    categoryList.innerHTML = '';
    renderCategoryGroupOptions();
    if (!CATEGORIES.length) {
      categoryList.innerHTML = '<p class="admin-empty">Nenhuma categoria ainda.</p>';
      return;
    }
    CATEGORIES.forEach((c) => {
      const groupInfo = CATEGORY_GROUPS.find((g) => g.name === c);
      const row = document.createElement('div');
      row.className = 'admin-category-item';
      row.innerHTML = `
        <span class="admin-category-item-name">${c}</span>
        <input type="text" class="admin-category-group-input" list="categoryGroupList" placeholder="Grupo no mega-menu (opcional)" value="${groupInfo && groupInfo.groupName ? groupInfo.groupName : ''}" />
        <button type="button" class="admin-category-save">Salvar</button>
        <button type="button" class="admin-category-remove" aria-label="Remover">✕</button>
      `;
      row.querySelector('.admin-category-save').addEventListener('click', async () => {
        const groupName = row.querySelector('.admin-category-group-input').value.trim();
        try {
          const data = await api('/api/categories/group', 'POST', { name: c, groupName });
          CATEGORY_GROUPS = data.categoryGroups;
          renderCategoryGroupOptions();
        } catch (err) {
          alert(err.message);
        }
      });
      row.querySelector('.admin-category-remove').addEventListener('click', async () => {
        const count = PRODUCTS.filter((p) => p.category === c).length;
        const msg = count
          ? `${count} produto${count > 1 ? 's' : ''} ${count > 1 ? 'usam' : 'usa'} a categoria "${c}" — a remoção vai falhar até você mover ou remover ${count > 1 ? 'esses produtos' : 'esse produto'}. Tentar mesmo assim?`
          : `Remover a categoria "${c}"?`;
        if (!confirm(msg)) return;
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
      categoryList.appendChild(row);
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
        const count = PRODUCTS.filter((p) => p.collection === c).length;
        const msg = count
          ? `${count} produto${count > 1 ? 's' : ''} ${count > 1 ? 'estão' : 'está'} na coleção "${c}" e ${count > 1 ? 'perderão' : 'perderá'} essa marcação. Remover mesmo assim?`
          : `Remover a coleção "${c}"?`;
        if (!confirm(msg)) return;
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
  const pEditId = document.getElementById('pEditId');
  const pImage = document.getElementById('pImage');
  const pImageHint = document.getElementById('pImageHint');
  const pPreview = document.getElementById('pPreview');
  const pSubmit = document.getElementById('pSubmit');
  const pCancelEdit = document.getElementById('pCancelEdit');
  const productFormTitle = document.getElementById('productFormTitle');
  const productMsg = document.getElementById('productMsg');

  let imageDataUrl = '';

  pImage.addEventListener('change', () => {
    const file = pImage.files[0];
    if (!file) {
      pPreview.hidden = !pEditId.value;
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

  function startEditProduct(p) {
    pEditId.value = p.id;
    document.getElementById('pName').value = p.name;
    document.getElementById('pBrand').value = p.brand;
    renderCategorySelect();
    pCategory.value = p.category;
    renderCollectionSelect();
    pCollection.value = p.collection || '';
    document.getElementById('pTag').value = p.tag || '';
    document.getElementById('pPrice').value = p.price == null ? '' : p.price;
    document.getElementById('pDesc').value = p.desc;
    imageDataUrl = '';
    pImage.value = '';
    pPreview.src = p.img;
    pPreview.hidden = false;
    pImageHint.textContent = '(opcional — deixe em branco para manter a foto atual)';
    productFormTitle.textContent = `Editando "${p.name}"`;
    pSubmit.textContent = 'Salvar alterações';
    pCancelEdit.hidden = false;
    setMsg('', '');
    renderProductList();
    productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function endEditProduct() {
    pEditId.value = '';
    productForm.reset();
    document.getElementById('pBrand').value = 'By NaNa';
    pPreview.hidden = true;
    imageDataUrl = '';
    pImageHint.textContent = '';
    productFormTitle.textContent = 'Adicionar produto';
    pSubmit.textContent = 'Publicar no catálogo';
    pCancelEdit.hidden = true;
    renderProductList();
  }

  pCancelEdit.addEventListener('click', endEditProduct);

  productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('', '');

    if (!CATEGORIES.length) {
      setMsg('Cadastre ao menos uma categoria antes de adicionar um produto.', 'error');
      return;
    }
    const editing = !!pEditId.value;
    if (!editing && !imageDataUrl) {
      setMsg('Selecione uma foto do produto.', 'error');
      return;
    }

    pSubmit.disabled = true;
    pSubmit.textContent = editing ? 'Salvando...' : 'Publicando...';

    try {
      const payload = {
        name: document.getElementById('pName').value.trim(),
        brand: document.getElementById('pBrand').value.trim(),
        category: pCategory.value,
        collection: pCollection.value,
        tag: document.getElementById('pTag').value.trim(),
        price: document.getElementById('pPrice').value,
        desc: document.getElementById('pDesc').value.trim(),
        image: imageDataUrl,
      };

      if (editing) {
        const data = await api('/api/products/update', 'POST', { ...payload, id: pEditId.value });
        PRODUCTS = data.products;
      } else {
        const data = await api('/api/products', 'POST', payload);
        PRODUCTS.unshift(data.product);
        CATEGORIES = data.categories;
        COLLECTIONS = data.collections;
        renderCategories();
        renderCollections();
      }
      renderCategorySelect();
      renderCollectionSelect();
      renderPromoTargetOptions();
      renderStoryProductSelect();
      renderFeaturedList();

      const wasEditing = editing;
      endEditProduct();
      setMsg(wasEditing ? 'Produto atualizado ✓' : 'Produto publicado no catálogo ✓', 'ok');
    } catch (err) {
      setMsg(err.message, 'error');
    } finally {
      pSubmit.disabled = false;
    }
  });

  // ---------- product list ----------
  const productList = document.getElementById('productList');
  const productCount = document.getElementById('productCount');
  const productSearch = document.getElementById('productSearch');

  function renderProductList() {
    const term = (productSearch.value || '').trim().toLowerCase();
    const list = term
      ? PRODUCTS.filter((p) => `${p.name} ${p.brand} ${p.category} ${p.collection || ''}`.toLowerCase().includes(term))
      : PRODUCTS;

    productCount.textContent = PRODUCTS.length;
    productList.innerHTML = '';
    if (!list.length) {
      productList.innerHTML = '<p class="admin-empty-block">Nenhum produto encontrado.</p>';
      return;
    }
    list.forEach((p) => {
      const promo = window.PromoEngine.bestPromoForProduct(p, PROMOTIONS);
      const priceHtml = promo
        ? `<span class="admin-product-item-price"><s>${money(p.price)}</s> ${money(promo.price)} <em>(-${promo.percent}%)</em></span>`
        : `<span class="admin-product-item-price">${money(p.price)}</span>`;
      const div = document.createElement('div');
      div.className = `admin-product-item${pEditId.value === p.id ? ' is-editing' : ''}`;
      div.innerHTML = `
        <img src="${p.img}" alt="${p.name}" />
        <div class="admin-product-item-body">
          <span class="admin-product-item-name">${p.name}</span>
          <span class="admin-product-item-meta">${p.category}${p.collection ? ` · ${p.collection}` : ''}</span>
          ${priceHtml}
          <div class="admin-product-item-actions">
            <button type="button" class="admin-product-item-edit" data-id="${p.id}">Editar</button>
            <button type="button" class="admin-product-item-remove" data-id="${p.id}">Remover</button>
          </div>
        </div>
      `;
      div.querySelector('.admin-product-item-edit').addEventListener('click', () => startEditProduct(p));
      div.querySelector('.admin-product-item-remove').addEventListener('click', async () => {
        if (!confirm(`Remover "${p.name}" do catálogo?`)) return;
        try {
          const data = await api('/api/products', 'DELETE', { id: p.id });
          PRODUCTS = data.products;
          if (pEditId.value === p.id) endEditProduct();
          renderProductList();
          renderPromoTargetOptions();
          renderStoryProductSelect();
          renderFeaturedList();
        } catch (err) {
          alert(err.message);
        }
      });
      productList.appendChild(div);
    });
  }

  productSearch.addEventListener('input', renderProductList);

  // ---------- novidades (curadoria manual da home) ----------
  const featuredList = document.getElementById('featuredList');
  const featuredSearch = document.getElementById('featuredSearch');

  function renderFeaturedList() {
    const term = (featuredSearch.value || '').trim().toLowerCase();
    const list = term ? PRODUCTS.filter((p) => p.name.toLowerCase().includes(term)) : PRODUCTS;

    const featured = list.filter((p) => p.isFeatured).sort((a, b) => a.featuredPosition - b.featuredPosition);
    const rest = list.filter((p) => !p.isFeatured);
    const ordered = [...featured, ...rest];

    featuredList.innerHTML = '';
    if (!ordered.length) {
      featuredList.innerHTML = '<p class="admin-empty-block">Nenhum produto encontrado.</p>';
      return;
    }
    ordered.forEach((p) => {
      const div = document.createElement('div');
      div.className = `admin-featured-item${p.isFeatured ? ' is-featured' : ''}`;
      const idx = featured.findIndex((f) => f.id === p.id);
      div.innerHTML = `
        <div class="admin-featured-thumb"><img src="${p.img}" alt="${p.name}" /></div>
        <div class="admin-featured-info">
          <span class="admin-featured-name">${p.name}</span>
          <span class="admin-featured-meta">${p.category}${p.collection ? ` · ${p.collection}` : ''}</span>
        </div>
        <div class="admin-featured-actions">
          <button type="button" class="admin-featured-move" data-dir="up" aria-label="Mover para cima" ${!p.isFeatured || idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="admin-featured-move" data-dir="down" aria-label="Mover para baixo" ${!p.isFeatured || idx === featured.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="admin-featured-badge ${p.isFeatured ? 'is-on' : ''}">${p.isFeatured ? 'Destacado' : 'Destacar'}</button>
        </div>
      `;
      div.querySelector('.admin-featured-badge').addEventListener('click', async () => {
        try {
          const data = await api('/api/products/featured', 'POST', { id: p.id, featured: !p.isFeatured });
          PRODUCTS = data.products;
          renderFeaturedList();
        } catch (err) {
          alert(err.message);
        }
      });
      div.querySelectorAll('.admin-featured-move').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const data = await api('/api/products/featured/reorder', 'POST', { id: p.id, direction: btn.dataset.dir });
            PRODUCTS = data.products;
            renderFeaturedList();
          } catch (err) {
            alert(err.message);
          }
        });
      });
      featuredList.appendChild(div);
    });
  }

  featuredSearch.addEventListener('input', renderFeaturedList);

  // ---------- promotions ----------
  const promoForm = document.getElementById('promoForm');
  const promoEditId = document.getElementById('promoEditId');
  const promoScope = document.getElementById('promoScope');
  const promoTargetWrap = document.getElementById('promoTargetWrap');
  const promoTarget = document.getElementById('promoTarget');
  const promoType = document.getElementById('promoType');
  const promoValue = document.getElementById('promoValue');
  const promoStart = document.getElementById('promoStart');
  const promoEnd = document.getElementById('promoEnd');
  const promoLabel = document.getElementById('promoLabel');
  const promoSubmit = document.getElementById('promoSubmit');
  const promoCancelEdit = document.getElementById('promoCancelEdit');
  const promoFormTitle = document.getElementById('promoFormTitle');
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
          <button type="button" class="admin-promo-edit" aria-label="Editar promoção">✎</button>
          <button type="button" class="admin-promo-remove" aria-label="Remover promoção">✕</button>
        </div>
      `;
      div.querySelector('.admin-promo-edit').addEventListener('click', () => startEditPromo(promo));
      div.querySelector('.admin-promo-remove').addEventListener('click', async () => {
        if (!confirm('Remover esta promoção?')) return;
        try {
          const data = await api('/api/promotions', 'DELETE', { id: promo.id });
          PROMOTIONS = data.promotions;
          if (promoEditId.value === promo.id) endEditPromo();
          renderPromoList();
          renderProductList();
        } catch (err) {
          alert(err.message);
        }
      });
      promoList.appendChild(div);
    });
  }

  function startEditPromo(promo) {
    promoEditId.value = promo.id;
    promoScope.value = promo.scope;
    renderPromoTargetOptions();
    if (promo.scope !== 'site') promoTarget.value = promo.target;
    promoType.value = promo.type;
    promoValue.value = promo.value;
    promoStart.value = promo.startDate || '';
    promoEnd.value = promo.endDate || '';
    promoLabel.value = promo.label || '';
    promoFormTitle.textContent = 'Editando promoção';
    promoSubmit.textContent = 'Salvar alterações';
    promoCancelEdit.hidden = false;
    setPromoMsg('', '');
    promoForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function endEditPromo() {
    promoEditId.value = '';
    promoForm.reset();
    renderPromoTargetOptions();
    promoFormTitle.textContent = 'Promoções';
    promoSubmit.textContent = 'Aplicar promoção';
    promoCancelEdit.hidden = true;
    renderPromoList();
  }

  promoCancelEdit.addEventListener('click', endEditPromo);

  promoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setPromoMsg('', '');
    promoSubmit.disabled = true;
    const editing = !!promoEditId.value;
    try {
      const payload = {
        scope: promoScope.value,
        target: promoScope.value === 'site' ? '' : promoTarget.value,
        type: promoType.value,
        value: promoValue.value,
        startDate: promoStart.value,
        endDate: promoEnd.value,
        label: promoLabel.value.trim(),
      };
      const data = editing
        ? await api('/api/promotions/update', 'POST', { ...payload, id: promoEditId.value })
        : await api('/api/promotions', 'POST', payload);
      PROMOTIONS = data.promotions;
      renderProductList();
      const wasEditing = editing;
      endEditPromo();
      setPromoMsg(wasEditing ? 'Promoção atualizada ✓' : 'Promoção aplicada ✓', 'ok');
    } catch (err) {
      setPromoMsg(err.message, 'error');
    } finally {
      promoSubmit.disabled = false;
    }
  });

  // ---------- coupons ----------
  const couponForm = document.getElementById('couponForm');
  const couponEditCode = document.getElementById('couponEditCode');
  const couponCode = document.getElementById('couponCode');
  const couponType = document.getElementById('couponType');
  const couponValue = document.getElementById('couponValue');
  const couponEnd = document.getElementById('couponEnd');
  const couponSubmit = document.getElementById('couponSubmit');
  const couponCancelEdit = document.getElementById('couponCancelEdit');
  const couponFormTitle = document.getElementById('couponFormTitle');
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
      li.innerHTML = `<span>${c.code} — ${discountText}${validity}</span><button type="button" class="admin-coupon-edit" aria-label="Editar">✎</button><button type="button" aria-label="Remover">✕</button>`;
      li.querySelector('.admin-coupon-edit').addEventListener('click', () => startEditCoupon(c));
      li.querySelector('button:not(.admin-coupon-edit)').addEventListener('click', async () => {
        if (!confirm(`Remover o cupom "${c.code}"?`)) return;
        const data = await api('/api/coupons', 'DELETE', { code: c.code });
        COUPONS = data.coupons;
        if (couponEditCode.value === c.code) endEditCoupon();
        renderCouponList();
      });
      couponList.appendChild(li);
    });
  }

  function startEditCoupon(c) {
    couponEditCode.value = c.code;
    couponCode.value = c.code;
    couponCode.readOnly = true;
    couponType.value = c.type;
    couponValue.value = c.value;
    couponEnd.value = c.endDate || '';
    couponFormTitle.textContent = `Editando cupom "${c.code}"`;
    couponSubmit.textContent = 'Salvar alterações';
    couponCancelEdit.hidden = false;
    setCouponMsg('', '');
    couponForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function endEditCoupon() {
    couponEditCode.value = '';
    couponForm.reset();
    couponCode.readOnly = false;
    couponFormTitle.textContent = 'Cupons de desconto';
    couponSubmit.textContent = 'Criar cupom';
    couponCancelEdit.hidden = true;
    renderCouponList();
  }

  couponCancelEdit.addEventListener('click', endEditCoupon);

  couponForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setCouponMsg('', '');
    couponSubmit.disabled = true;
    const editing = !!couponEditCode.value;
    try {
      const payload = {
        code: couponCode.value.trim(),
        type: couponType.value,
        value: couponValue.value,
        endDate: couponEnd.value,
      };
      const data = editing
        ? await api('/api/coupons/update', 'POST', payload)
        : await api('/api/coupons', 'POST', payload);
      COUPONS = data.coupons;
      const wasEditing = editing;
      endEditCoupon();
      setCouponMsg(wasEditing ? 'Cupom atualizado ✓' : 'Cupom criado ✓', 'ok');
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

  // ---------- clientes (CRM) ----------
  const customerList = document.getElementById('customerList');
  const customerCount = document.getElementById('customerCount');
  const customerSearch = document.getElementById('customerSearch');

  async function loadCustomers() {
    try {
      const data = await api('/api/customers/list', 'POST', {});
      CUSTOMERS = data.customers || [];
      renderCustomerList();
    } catch (err) {
      customerList.innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  function renderCustomerList() {
    const term = (customerSearch.value || '').trim().toLowerCase();
    const list = term
      ? CUSTOMERS.filter((c) => `${c.firstName} ${c.lastName} ${c.email}`.toLowerCase().includes(term))
      : CUSTOMERS;

    customerCount.textContent = CUSTOMERS.length;
    customerList.innerHTML = '';
    if (!list.length) {
      customerList.innerHTML = '<p class="admin-empty-block">Nenhum cliente encontrado.</p>';
      return;
    }
    list.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'admin-customer-item';
      div.innerHTML = `
        <div class="admin-customer-info">
          <span class="admin-customer-name">${c.firstName} ${c.lastName}</span>
          <span class="admin-customer-meta">${c.email} · ${c.phone} · CPF ${c.cpf} · cliente desde ${formatDate(c.createdAt.slice(0, 10))}</span>
        </div>
        <div class="admin-customer-actions">
          <span class="admin-customer-badge ${c.marketingOptIn ? '' : 'is-off'}">${c.marketingOptIn ? 'Recebe novidades' : 'Não recebe novidades'}</span>
          <button type="button" class="admin-customer-remove" aria-label="Remover cliente">✕</button>
        </div>
      `;
      div.querySelector('.admin-customer-remove').addEventListener('click', async () => {
        if (!confirm(`Remover o cadastro de "${c.firstName} ${c.lastName}"?`)) return;
        try {
          const data = await api('/api/customers', 'DELETE', { id: c.id });
          CUSTOMERS = data.customers;
          renderCustomerList();
        } catch (err) {
          alert(err.message);
        }
      });
      customerList.appendChild(div);
    });
  }

  customerSearch.addEventListener('input', renderCustomerList);

  document.getElementById('customerExport').addEventListener('click', () => {
    if (!CUSTOMERS.length) {
      alert('Não há clientes para exportar.');
      return;
    }
    const header = ['Nome', 'Sobrenome', 'E-mail', 'Telefone', 'Recebe novidades', 'Cliente desde'];
    const csvEscape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = CUSTOMERS.map((c) => [
      c.firstName,
      c.lastName,
      c.email,
      c.phone,
      c.marketingOptIn ? 'Sim' : 'Não',
      formatDate(c.createdAt.slice(0, 10)),
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(';')).join('\r\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clientes-bynana-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ---------- pedidos (fechados no checkout do site) ----------
  const orderList = document.getElementById('orderList');
  const orderCount = document.getElementById('orderCount');
  const orderSearch = document.getElementById('orderSearch');

  const ORDER_STATUS_LABELS = { novo: 'Novo', em_andamento: 'Em andamento', concluido: 'Concluído', cancelado: 'Cancelado' };

  async function loadOrders() {
    try {
      const data = await api('/api/orders/list', 'POST', {});
      ORDERS = data.orders || [];
      renderOrderList();
    } catch (err) {
      orderList.innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  function renderOrderList() {
    const term = (orderSearch.value || '').trim().toLowerCase();
    const list = term
      ? ORDERS.filter((o) => `${o.customerName} ${o.customerPhone}`.toLowerCase().includes(term))
      : ORDERS;

    orderCount.textContent = ORDERS.length;
    orderList.innerHTML = '';
    if (!list.length) {
      orderList.innerHTML = '<p class="admin-empty-block">Nenhum pedido encontrado.</p>';
      return;
    }
    list.forEach((o) => {
      const itemsText = (o.items || []).map((it) => `${it.qty}x ${it.name}`).join(', ');
      const when = new Date(o.createdAt).toLocaleString('pt-BR');
      const div = document.createElement('div');
      div.className = 'admin-order-item';
      div.innerHTML = `
        <div class="admin-order-info">
          <span class="admin-order-name">${o.customerName} · ${o.customerPhone}</span>
          <span class="admin-order-meta">${when}${o.couponCode ? ` · cupom ${o.couponCode}` : ''} · ${o.paymentMethod} · ${o.deliveryMethod}</span>
          <p class="admin-order-items">${itemsText}</p>
          <span class="admin-order-total">${money(o.total)}</span>
        </div>
        <div class="admin-order-actions">
          <select class="admin-order-status-select st-${o.status}" aria-label="Status do pedido">
            ${Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${value === o.status ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      `;
      div.querySelector('.admin-order-status-select').addEventListener('change', async (e) => {
        const status = e.target.value;
        e.target.className = `admin-order-status-select st-${status}`;
        try {
          const data = await api('/api/orders/status', 'POST', { id: o.id, status });
          ORDERS = data.orders;
        } catch (err) {
          alert(err.message);
          renderOrderList();
        }
      });
      orderList.appendChild(div);
    });
  }

  orderSearch.addEventListener('input', renderOrderList);

  // ---------- stories (carrossel de vídeo estilo Instagram) ----------
  const storyForm = document.getElementById('storyForm');
  const stVideo = document.getElementById('stVideo');
  const stCover = document.getElementById('stCover');
  const stVideoPreview = document.getElementById('stVideoPreview');
  const stCoverPreview = document.getElementById('stCoverPreview');
  const stProduct = document.getElementById('stProduct');
  const stSubmit = document.getElementById('stSubmit');
  const storyMsg = document.getElementById('storyMsg');
  const storyList = document.getElementById('storyList');

  let storyVideoDataUrl = '';
  let storyCoverDataUrl = '';

  function renderStoryProductSelect() {
    const current = stProduct.value;
    stProduct.innerHTML =
      '<option value="">Nenhum (usar link abaixo)</option>' +
      PRODUCTS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    if (PRODUCTS.some((p) => p.id === current)) stProduct.value = current;
  }

  stVideo.addEventListener('change', () => {
    const file = stVideo.files[0];
    if (!file) {
      stVideoPreview.hidden = true;
      storyVideoDataUrl = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      storyVideoDataUrl = reader.result;
      stVideoPreview.src = storyVideoDataUrl;
      stVideoPreview.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  stCover.addEventListener('change', () => {
    const file = stCover.files[0];
    if (!file) {
      stCoverPreview.hidden = true;
      storyCoverDataUrl = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      storyCoverDataUrl = reader.result;
      stCoverPreview.src = storyCoverDataUrl;
      stCoverPreview.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  function setStoryMsg(text, kind) {
    storyMsg.textContent = text;
    storyMsg.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
    storyMsg.hidden = !text;
  }

  async function loadStories() {
    try {
      const data = await api('/api/stories/list', 'POST', {});
      STORIES = data.stories || [];
      renderStoryList();
    } catch (err) {
      storyList.innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  storyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStoryMsg('', '');

    if (!storyVideoDataUrl) {
      setStoryMsg('Selecione um vídeo para o story.', 'error');
      return;
    }

    stSubmit.disabled = true;
    stSubmit.textContent = 'Publicando...';
    try {
      const data = await api('/api/stories', 'POST', {
        title: document.getElementById('stTitle').value.trim(),
        video: storyVideoDataUrl,
        cover: storyCoverDataUrl,
        productId: stProduct.value,
        linkUrl: document.getElementById('stLinkUrl').value.trim(),
        linkLabel: document.getElementById('stLinkLabel').value.trim(),
      });
      STORIES = data.stories;
      renderStoryList();

      storyForm.reset();
      document.getElementById('stLinkLabel').value = 'Ver mais';
      stVideoPreview.hidden = true;
      stCoverPreview.hidden = true;
      storyVideoDataUrl = '';
      storyCoverDataUrl = '';
      setStoryMsg('Story publicado ✓', 'ok');
    } catch (err) {
      setStoryMsg(err.message, 'error');
    } finally {
      stSubmit.disabled = false;
      stSubmit.textContent = 'Publicar story';
    }
  });

  function renderStoryList() {
    storyList.innerHTML = '';
    if (!STORIES.length) {
      storyList.innerHTML = '<p class="admin-empty-block">Nenhum story publicado ainda.</p>';
      return;
    }
    STORIES.forEach((s, i) => {
      const div = document.createElement('div');
      div.className = 'admin-story-item';
      const thumb = s.cover
        ? `<img src="${s.cover}" alt="${s.title || 'Story'}" />`
        : `<video src="${s.video}" muted preload="metadata"></video>`;
      const linkedProduct = s.productId ? PRODUCTS.find((p) => p.id === s.productId) : null;
      const metaText = linkedProduct
        ? `Produto: ${linkedProduct.name}`
        : s.linkUrl
        ? `Botão: "${s.linkLabel}" → ${s.linkUrl}`
        : 'Sem botão de ação';
      div.innerHTML = `
        <div class="admin-story-thumb">${thumb}</div>
        <div class="admin-story-info">
          <span class="admin-story-title">${s.title || '(sem título)'}</span>
          <span class="admin-story-meta">${metaText}</span>
          <div class="admin-story-product-edit">
            <select class="admin-story-product-select">
              <option value="">Nenhum produto</option>
              ${PRODUCTS.map((p) => `<option value="${p.id}" ${p.id === s.productId ? 'selected' : ''}>${p.name}</option>`).join('')}
            </select>
            <button type="button" class="admin-story-product-save">Salvar</button>
          </div>
        </div>
        <div class="admin-story-actions">
          <button type="button" class="admin-story-move" data-dir="up" aria-label="Mover para cima" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="admin-story-move" data-dir="down" aria-label="Mover para baixo" ${i === STORIES.length - 1 ? 'disabled' : ''}>↓</button>
          <span class="admin-story-badge ${s.active ? '' : 'is-off'}">${s.active ? 'Ativo' : 'Inativo'}</span>
          <button type="button" class="admin-story-remove" aria-label="Remover story">✕</button>
        </div>
      `;
      div.querySelector('.admin-story-product-save').addEventListener('click', async () => {
        const productId = div.querySelector('.admin-story-product-select').value;
        try {
          const data = await api('/api/stories/product', 'POST', { id: s.id, productId });
          STORIES = data.stories;
          renderStoryList();
        } catch (err) {
          alert(err.message);
        }
      });
      div.querySelectorAll('.admin-story-move').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const data = await api('/api/stories/reorder', 'POST', { id: s.id, direction: btn.dataset.dir });
            STORIES = data.stories;
            renderStoryList();
          } catch (err) {
            alert(err.message);
          }
        });
      });
      div.querySelector('.admin-story-badge').addEventListener('click', async () => {
        try {
          const data = await api('/api/stories/active', 'POST', { id: s.id, active: !s.active });
          STORIES = data.stories;
          renderStoryList();
        } catch (err) {
          alert(err.message);
        }
      });
      div.querySelector('.admin-story-remove').addEventListener('click', async () => {
        if (!confirm('Remover este story?')) return;
        try {
          const data = await api('/api/stories', 'DELETE', { id: s.id });
          STORIES = data.stories;
          renderStoryList();
        } catch (err) {
          alert(err.message);
        }
      });
      storyList.appendChild(div);
    });
  }

  // ---------- usuários admin (Acesso) ----------
  const adminUserForm = document.getElementById('adminUserForm');
  const auName = document.getElementById('auName');
  const auEmail = document.getElementById('auEmail');
  const auPassword = document.getElementById('auPassword');
  const auRole = document.getElementById('auRole');
  const auSubmit = document.getElementById('auSubmit');
  const adminUserMsg = document.getElementById('adminUserMsg');
  const adminUserList = document.getElementById('adminUserList');
  const adminUserCount = document.getElementById('adminUserCount');

  function setAdminUserMsg(text, kind) {
    adminUserMsg.textContent = text;
    adminUserMsg.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
    adminUserMsg.hidden = !text;
  }

  async function loadAdminUsers() {
    try {
      const data = await api('/api/admin/users/list', 'POST', {});
      ADMIN_USERS = data.adminUsers || [];
      renderAdminUserList();
    } catch (err) {
      adminUserList.innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  function renderAdminUserList() {
    adminUserCount.textContent = ADMIN_USERS.length;
    adminUserList.innerHTML = '';
    const isOwner = !!CURRENT_ADMIN && CURRENT_ADMIN.role === 'owner';
    ADMIN_USERS.forEach((u) => {
      const isSelf = CURRENT_ADMIN && u.id === CURRENT_ADMIN.id;
      const div = document.createElement('div');
      div.className = 'admin-user-item';
      div.innerHTML = `
        <div class="admin-user-info">
          <span class="admin-user-name">${u.name}${isSelf ? ' (você)' : ''}</span>
          <span class="admin-user-meta">${u.email} · desde ${formatDate(u.createdAt.slice(0, 10))}</span>
        </div>
        <div class="admin-user-actions">
          <span class="admin-user-role-badge ${u.role === 'staff' ? 'is-staff' : ''}">${u.role === 'owner' ? 'Owner' : 'Equipe'}</span>
          <button type="button" class="admin-user-active-badge ${u.active ? '' : 'is-off'}" ${!isOwner || isSelf ? 'disabled' : ''}>${u.active ? 'Ativo' : 'Inativo'}</button>
        </div>
      `;
      div.querySelector('.admin-user-active-badge').addEventListener('click', async () => {
        if (!isOwner || isSelf) return;
        try {
          const data = await api('/api/admin/users/update', 'POST', { id: u.id, name: u.name, role: u.role, active: !u.active });
          ADMIN_USERS = data.adminUsers;
          renderAdminUserList();
        } catch (err) {
          alert(err.message);
        }
      });
      adminUserList.appendChild(div);
    });
  }

  adminUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAdminUserMsg('', '');
    auSubmit.disabled = true;
    try {
      const data = await api('/api/admin/users', 'POST', {
        name: auName.value.trim(),
        email: auEmail.value.trim(),
        password: auPassword.value,
        role: auRole.value,
      });
      ADMIN_USERS = data.adminUsers;
      renderAdminUserList();
      adminUserForm.reset();
      setAdminUserMsg('Usuário criado ✓', 'ok');
    } catch (err) {
      setAdminUserMsg(err.message, 'error');
    } finally {
      auSubmit.disabled = false;
    }
  });

  // ---------- trocar minha senha ----------
  const myPasswordForm = document.getElementById('myPasswordForm');
  const mpCurrent = document.getElementById('mpCurrent');
  const mpNew = document.getElementById('mpNew');
  const mpSubmit = document.getElementById('mpSubmit');
  const myPasswordMsg = document.getElementById('myPasswordMsg');

  function setMyPasswordMsg(text, kind) {
    myPasswordMsg.textContent = text;
    myPasswordMsg.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
    myPasswordMsg.hidden = !text;
  }

  myPasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMyPasswordMsg('', '');
    mpSubmit.disabled = true;
    try {
      await api('/api/admin/users/password', 'POST', { currentPassword: mpCurrent.value, newPassword: mpNew.value });
      myPasswordForm.reset();
      setMyPasswordMsg('Senha atualizada ✓', 'ok');
    } catch (err) {
      setMyPasswordMsg(err.message, 'error');
    } finally {
      mpSubmit.disabled = false;
    }
  });

  // ---------- atividade recente ----------
  const activityList = document.getElementById('activityList');
  const ACTIVITY_LABELS = {
    'product.create': 'criou o produto',
    'product.update': 'editou o produto',
    'product.delete': 'removeu o produto',
    'promotion.create': 'criou a promoção',
    'promotion.update': 'editou a promoção',
    'promotion.delete': 'removeu a promoção',
    'coupon.create': 'criou o cupom',
    'coupon.update': 'editou o cupom',
    'coupon.delete': 'removeu o cupom',
    'order.status_update': 'atualizou o status do pedido',
    'customer.delete': 'removeu o cliente',
    'site_image.update': 'trocou a imagem do site',
    'admin_user.create': 'criou o usuário admin',
    'admin_user.update': 'atualizou o usuário admin',
  };

  async function loadActivity() {
    try {
      const data = await api('/api/admin/activity/list', 'POST', {});
      ACTIVITY = data.activity || [];
      renderActivityList();
    } catch (err) {
      activityList.innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  function renderActivityList() {
    activityList.innerHTML = '';
    if (!ACTIVITY.length) {
      activityList.innerHTML = '<p class="admin-empty-block">Nenhuma atividade registrada ainda.</p>';
      return;
    }
    ACTIVITY.forEach((a) => {
      const when = new Date(a.createdAt).toLocaleString('pt-BR');
      const label = ACTIVITY_LABELS[a.action] || a.action;
      const div = document.createElement('div');
      div.className = 'admin-activity-item';
      div.innerHTML = `
        <span class="admin-activity-when">${when}</span>
        <span class="admin-activity-who">${a.adminName}</span>
        <span class="admin-activity-action">${label}${a.entityId ? ` (${a.entityId})` : ''}</span>
      `;
      activityList.appendChild(div);
    });
  }

  // ---------- dashboard + relatórios ----------
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }
  function daysAgoISO(n) {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function renderBarList(container, items, valueFormatter) {
    if (!items.length) {
      container.innerHTML = '<p class="admin-empty-block">Sem dados no período.</p>';
      return;
    }
    const max = Math.max(...items.map((i) => i.value));
    container.innerHTML = items
      .map(
        (i) => `
      <div class="admin-bar-row">
        <div class="admin-bar-row-label"><span>${i.label}</span><span>${valueFormatter(i.value)}</span></div>
        <div class="admin-bar-track"><div class="admin-bar-fill" style="width:${max > 0 ? (i.value / max) * 100 : 0}%"></div></div>
      </div>`
      )
      .join('');
  }

  function renderTable(container, columns, rows) {
    if (!rows.length) {
      container.innerHTML = '<p class="admin-empty-block">Sem dados no período.</p>';
      return;
    }
    container.innerHTML = `
      <table>
        <thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td>${c.render(r)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    `;
  }

  async function loadDashboard() {
    try {
      const data = await api('/api/admin/dashboard', 'POST', {});
      document.getElementById('dashRevenue').textContent = money(data.summary.revenue);
      document.getElementById('dashOrders').textContent = data.summary.orderCount;
      document.getElementById('dashTicket').textContent = money(data.summary.avgTicket);
      document.getElementById('dashNewCustomers').textContent = data.newCustomers.newCustomers;

      renderBarList(
        document.getElementById('dashTopProducts'),
        data.topProducts.map((p) => ({ label: p.name, value: p.qty })),
        (v) => `${v} un.`
      );

      const recentEl = document.getElementById('dashRecentOrders');
      if (!data.recentOrders.length) {
        recentEl.innerHTML = '<p class="admin-empty-block">Nenhum pedido ainda.</p>';
      } else {
        recentEl.innerHTML = data.recentOrders
          .map(
            (o) => `
          <div class="admin-order-item">
            <div class="admin-order-info">
              <span class="admin-order-name">${o.customerName}</span>
              <span class="admin-order-meta">${new Date(o.createdAt).toLocaleString('pt-BR')} · ${money(o.total)}</span>
            </div>
          </div>`
          )
          .join('');
      }
    } catch (err) {
      document.getElementById('dashTopProducts').innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  // ---------- relatório de vendas ----------
  const relVendasFrom = document.getElementById('relVendasFrom');
  const relVendasTo = document.getElementById('relVendasTo');
  relVendasFrom.value = daysAgoISO(30);
  relVendasTo.value = todayISO();
  document.getElementById('relVendasApply').addEventListener('click', loadSalesReport);

  async function loadSalesReport() {
    try {
      const data = await api('/api/admin/reports/sales', 'POST', { from: relVendasFrom.value, to: relVendasTo.value });
      relVendasFrom.value = data.from;
      relVendasTo.value = data.to;
      document.getElementById('relVendasStats').innerHTML = `
        <div class="admin-stat-card"><span class="admin-stat-label">Receita</span><span class="admin-stat-value">${money(data.summary.revenue)}</span></div>
        <div class="admin-stat-card"><span class="admin-stat-label">Pedidos</span><span class="admin-stat-value">${data.summary.orderCount}</span></div>
        <div class="admin-stat-card"><span class="admin-stat-label">Ticket médio</span><span class="admin-stat-value">${money(data.summary.avgTicket)}</span></div>
      `;
      renderBarList(
        document.getElementById('relVendasByDay'),
        data.byDay.map((d) => ({ label: formatDate(d.date), value: Number(d.revenue) })),
        (v) => money(v)
      );
    } catch (err) {
      document.getElementById('relVendasStats').innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  // ---------- relatório de produtos mais vendidos ----------
  const relProdutosFrom = document.getElementById('relProdutosFrom');
  const relProdutosTo = document.getElementById('relProdutosTo');
  relProdutosFrom.value = daysAgoISO(30);
  relProdutosTo.value = todayISO();
  document.getElementById('relProdutosApply').addEventListener('click', loadProductsReport);

  async function loadProductsReport() {
    try {
      const data = await api('/api/admin/reports/products', 'POST', { from: relProdutosFrom.value, to: relProdutosTo.value });
      relProdutosFrom.value = data.from;
      relProdutosTo.value = data.to;
      renderTable(
        document.getElementById('relProdutosTable'),
        [
          { label: 'Produto', render: (r) => r.name },
          { label: 'Quantidade', render: (r) => r.qty },
          { label: 'Receita', render: (r) => money(Number(r.revenue)) },
        ],
        data.products
      );
    } catch (err) {
      document.getElementById('relProdutosTable').innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  // ---------- relatório de cupons e promoções ----------
  const relPromoFrom = document.getElementById('relPromoFrom');
  const relPromoTo = document.getElementById('relPromoTo');
  relPromoFrom.value = daysAgoISO(30);
  relPromoTo.value = todayISO();
  document.getElementById('relPromoApply').addEventListener('click', loadPromotionsReport);

  async function loadPromotionsReport() {
    try {
      const data = await api('/api/admin/reports/promotions', 'POST', { from: relPromoFrom.value, to: relPromoTo.value });
      relPromoFrom.value = data.from;
      relPromoTo.value = data.to;
      renderTable(
        document.getElementById('relCouponsTable'),
        [
          { label: 'Código', render: (r) => r.code },
          { label: 'Usos', render: (r) => r.uses },
          { label: 'Desconto total', render: (r) => money(Number(r.totalDiscount)) },
        ],
        data.coupons
      );
      renderTable(
        document.getElementById('relPromotionsTable'),
        [
          { label: 'Promoção', render: (r) => r.label || r.promoId },
          { label: 'Usos', render: (r) => r.uses },
          { label: 'Quantidade', render: (r) => r.qty },
          { label: 'Desconto total', render: (r) => money(Number(r.totalDiscount)) },
        ],
        data.promotions
      );
    } catch (err) {
      document.getElementById('relCouponsTable').innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  // ---------- relatório de clientes ----------
  const relClientesFrom = document.getElementById('relClientesFrom');
  const relClientesTo = document.getElementById('relClientesTo');
  relClientesFrom.value = daysAgoISO(30);
  relClientesTo.value = todayISO();
  document.getElementById('relClientesApply').addEventListener('click', loadCustomersReport);

  async function loadCustomersReport() {
    try {
      const data = await api('/api/admin/reports/customers', 'POST', { from: relClientesFrom.value, to: relClientesTo.value });
      relClientesFrom.value = data.from;
      relClientesTo.value = data.to;
      const rate = data.summary.newCustomers > 0 ? Math.round((data.summary.optInCount / data.summary.newCustomers) * 100) : 0;
      document.getElementById('relClientesStats').innerHTML = `
        <div class="admin-stat-card"><span class="admin-stat-label">Novos clientes</span><span class="admin-stat-value">${data.summary.newCustomers}</span></div>
        <div class="admin-stat-card"><span class="admin-stat-label">Aceitam novidades</span><span class="admin-stat-value">${data.summary.optInCount}</span></div>
        <div class="admin-stat-card"><span class="admin-stat-label">Taxa de opt-in</span><span class="admin-stat-value">${rate}%</span></div>
      `;
    } catch (err) {
      document.getElementById('relClientesStats').innerHTML = `<p class="admin-empty-block">${err.message}</p>`;
    }
  }

  // ---------- boot ----------
  (async () => {
    if (ADMIN_TOKEN) {
      const adminUser = await fetchSession(ADMIN_TOKEN);
      if (adminUser) {
        CURRENT_ADMIN = adminUser;
        showApp();
        return;
      }
      sessionStorage.removeItem(TOKEN_KEY);
      ADMIN_TOKEN = '';
    }
    loginScreen.hidden = false;
  })();
})();
