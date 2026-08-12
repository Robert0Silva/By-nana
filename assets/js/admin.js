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
  let CATEGORY_CONTENT = [];
  let COLLECTIONS = [];
  let PRODUCTS = [];
  let PROMOTIONS = [];
  let COUPONS = [];
  let SHIPPING_RULES = [];
  let CUSTOMERS = [];
  let STORIES = [];
  let ORDERS = [];
  let ADMIN_USERS = [];
  let ACTIVITY = [];

  const money = (v) =>
    v == null ? 'Sob consulta' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // avaliações trazem texto livre digitado por clientes (nome, comentário) — escapa antes do
  // innerHTML pra não virar XSS armazenado dentro do próprio painel admin.
  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
  }

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
    const greeting = document.getElementById('dashGreetingName');
    if (greeting) greeting.textContent = CURRENT_ADMIN.name.split(' ')[0];
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
    CATEGORY_CONTENT = data.categoryContent || [];
    COLLECTIONS = data.collections || [];
    PROMOTIONS = data.promotions || [];
    COUPONS = data.coupons || [];
    SHIPPING_RULES = data.shippingRules || [];
    renderCategories();
    renderCollections();
    renderCategorySelect();
    renderCollectionSelect();
    renderProductList();
    renderFeaturedList();
    renderUpsellList();
    renderPromoTargetOptions();
    renderStoryProductSelect();
    renderPromoList();
    renderCouponList();
    renderShippingList();
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
    avaliacoes: () => loadReviews(),
    newsletter: () => loadNewsletter(),
    'avise-me': () => loadStockNotifications(),
  };

  function activateAdminPanel(target) {
      const btn = document.querySelector(`.admin-tab[data-target="${target}"]`);
      if (!btn) return;
      document.querySelectorAll('.admin-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.admin-panel').forEach((p) => {
        p.hidden = p.id !== `panel-${target}`;
      });
      setActiveTabGroupFor(target);
      closeAllTabGroups();
      if (TAB_LOAD_HANDLERS[target]) TAB_LOAD_HANDLERS[target]();
      window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.querySelectorAll('.admin-tab').forEach((btn) => {
    btn.addEventListener('click', () => activateAdminPanel(btn.dataset.target));
  });

  document.querySelectorAll('[data-admin-jump]').forEach((button) => {
    button.addEventListener('click', () => {
      activateAdminPanel(button.dataset.adminJump);
      if (button.dataset.newProduct === 'true') endEditProduct(true);
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
    startNotificationPolling();
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
    if (notifPollTimer) clearInterval(notifPollTimer);
  });

  // ---------- categories ----------
  const categoryList = document.getElementById('categoryList');
  const categoryForm = document.getElementById('categoryForm');
  const categoryName = document.getElementById('categoryName');
  const categoryGroupList = document.getElementById('categoryGroupList');

  function renderCategoryGroupOptions() {
    const groups = [...new Set(CATEGORY_GROUPS.map((g) => g.groupName).filter(Boolean))];
    categoryGroupList.innerHTML = groups.map((g) => `<option value="${escapeHtml(g)}"></option>`).join('');
  }

  function faqRowHtml(q, a) {
    return `
      <div class="admin-category-faq-row">
        <input type="text" class="admin-faq-question" placeholder="Pergunta" value="${escapeHtml(q || '')}" />
        <textarea class="admin-faq-answer" rows="2" placeholder="Resposta">${escapeHtml(a || '')}</textarea>
        <button type="button" class="admin-faq-remove" aria-label="Remover pergunta">✕</button>
      </div>`;
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
      const content = CATEGORY_CONTENT.find((x) => x.name === c);
      const faq = content && Array.isArray(content.faq) ? content.faq : [];
      const row = document.createElement('div');
      row.className = 'admin-category-item';
      row.innerHTML = `
        <div class="admin-category-item-row">
          <span class="admin-category-item-name">${escapeHtml(c)}</span>
          <input type="text" class="admin-category-group-input" list="categoryGroupList" placeholder="Grupo no mega-menu (opcional)" value="${escapeHtml(groupInfo && groupInfo.groupName ? groupInfo.groupName : '')}" />
          <button type="button" class="admin-category-save">Salvar</button>
          <button type="button" class="admin-category-seo-toggle">Editar texto/FAQ</button>
          <button type="button" class="admin-category-remove" aria-label="Remover">✕</button>
        </div>
        <div class="admin-category-seo-editor" hidden>
          <label>Texto da categoria (SEO)
            <textarea class="admin-category-seo-text" rows="3" placeholder="Parágrafo curto sobre esta categoria">${escapeHtml(content && content.seoText ? content.seoText : '')}</textarea>
          </label>
          <div class="admin-category-faq-rows">
            ${faq.map((f) => faqRowHtml(f.question, f.answer)).join('')}
          </div>
          <button type="button" class="admin-category-faq-add">+ Adicionar pergunta</button>
          <button type="button" class="admin-category-seo-save">Salvar texto/FAQ</button>
        </div>
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

      const seoEditor = row.querySelector('.admin-category-seo-editor');
      const faqRows = row.querySelector('.admin-category-faq-rows');
      row.querySelector('.admin-category-seo-toggle').addEventListener('click', () => {
        seoEditor.hidden = !seoEditor.hidden;
      });
      faqRows.addEventListener('click', (e) => {
        if (e.target.classList.contains('admin-faq-remove')) {
          e.target.closest('.admin-category-faq-row').remove();
        }
      });
      row.querySelector('.admin-category-faq-add').addEventListener('click', () => {
        faqRows.insertAdjacentHTML('beforeend', faqRowHtml('', ''));
      });
      row.querySelector('.admin-category-seo-save').addEventListener('click', async () => {
        const seoText = row.querySelector('.admin-category-seo-text').value.trim();
        const faqPayload = [...faqRows.querySelectorAll('.admin-category-faq-row')].map((r) => ({
          question: r.querySelector('.admin-faq-question').value.trim(),
          answer: r.querySelector('.admin-faq-answer').value.trim(),
        }));
        try {
          const data = await api('/api/categories/seo', 'POST', { name: c, seoText, faq: faqPayload });
          CATEGORY_CONTENT = data.categoryContent;
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
      li.innerHTML = `<span>${escapeHtml(c)}</span><button type="button" aria-label="Remover">✕</button>`;
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
    pCategory.innerHTML = CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (CATEGORIES.includes(current)) pCategory.value = current;
  }

  function renderCollectionSelect() {
    const current = pCollection.value;
    pCollection.innerHTML =
      '<option value="">Nenhuma</option>' + COLLECTIONS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
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
  const pNewProduct = document.getElementById('pNewProduct');
  const productFormTitle = document.getElementById('productFormTitle');
  const productFormEyebrow = document.getElementById('productFormEyebrow');
  const productMsg = document.getElementById('productMsg');
  const pGradePreset = document.getElementById('pGradePreset');
  const pGradeColor = document.getElementById('pGradeColor');
  const pGradeStock = document.getElementById('pGradeStock');
  const pGenerateGrade = document.getElementById('pGenerateGrade');
  const pAddVariant = document.getElementById('pAddVariant');
  const pVariantRows = document.getElementById('pVariantRows');
  const pVariantEmpty = document.getElementById('pVariantEmpty');
  const pStockSummary = document.getElementById('pStockSummary');
  const pReviewTitle = document.getElementById('pReviewTitle');
  const pReviewSummary = document.getElementById('pReviewSummary');
  const pComposition = document.getElementById('pComposition');
  const pGalleryGrid = document.getElementById('pGalleryGrid');
  const pGalleryInput = document.getElementById('pGalleryInput');
  const pGalleryHint = document.getElementById('pGalleryHint');
  const pGalleryMsg = document.getElementById('pGalleryMsg');

  const PRODUCT_GALLERY_MAX_EXTRA = 7;
  let imageDataUrl = '';
  let editorVariants = [];
  let galleryImages = [];
  const gradePresets = {
    clothing: ['PP', 'P', 'M', 'G', 'GG', 'XGG'],
    shoes: ['33', '34', '35', '36', '37', '38', '39', '40'],
    unique: ['Único'],
    custom: [],
  };

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
      updateProductCompletion();
    };
    reader.readAsDataURL(file);
  });

  function setGalleryMsg(text, kind) {
    pGalleryMsg.textContent = text;
    pGalleryMsg.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
    pGalleryMsg.hidden = !text;
  }

  function renderGallery() {
    pGalleryGrid.innerHTML = galleryImages.map((img) => `
      <div class="admin-gallery-thumb">
        <img src="${img.url}" alt="" />
        <button type="button" class="admin-gallery-remove" data-id="${img.id}" aria-label="Remover foto">✕</button>
      </div>
    `).join('');
    pGalleryGrid.querySelectorAll('.admin-gallery-remove').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const data = await api('/api/products/images', 'DELETE', { id: button.dataset.id });
          galleryImages = data.gallery || [];
          renderGallery();
        } catch (err) {
          setGalleryMsg(err.message, 'error');
          button.disabled = false;
        }
      });
    });
    const full = galleryImages.length >= PRODUCT_GALLERY_MAX_EXTRA;
    pGalleryInput.disabled = !pEditId.value || full;
    pGalleryHint.textContent = !pEditId.value
      ? 'Salve o produto antes de enviar a galeria'
      : full
        ? `Limite de ${PRODUCT_GALLERY_MAX_EXTRA} fotos extras atingido`
        : `${galleryImages.length}/${PRODUCT_GALLERY_MAX_EXTRA} fotos extras`;
  }

  pGalleryInput.addEventListener('change', async () => {
    const files = Array.from(pGalleryInput.files || []);
    pGalleryInput.value = '';
    if (!files.length || !pEditId.value) return;
    setGalleryMsg('', '');
    for (const file of files) {
      if (galleryImages.length >= PRODUCT_GALLERY_MAX_EXTRA) {
        setGalleryMsg(`Limite de ${PRODUCT_GALLERY_MAX_EXTRA} fotos extras atingido.`, 'error');
        break;
      }
      const image = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      try {
        const data = await api('/api/products/images', 'POST', { productId: pEditId.value, image });
        galleryImages = data.gallery || [];
        renderGallery();
      } catch (err) {
        setGalleryMsg(err.message, 'error');
        break;
      }
    }
  });

  function setMsg(text, kind) {
    productMsg.textContent = text;
    productMsg.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
    productMsg.hidden = !text;
  }

  function readVariantRows() {
    pVariantRows.querySelectorAll('tr[data-index]').forEach((row) => {
      const variant = editorVariants[Number(row.dataset.index)];
      if (!variant) return;
      variant.size = row.querySelector('.v-size').value.trim();
      variant.color = row.querySelector('.v-color').value.trim();
      variant.sku = row.querySelector('.v-sku').value.trim();
      variant.stock = Math.max(0, Number.parseInt(row.querySelector('.v-stock').value, 10) || 0);
      variant.measurements = row.querySelector('.v-measurements').value.trim();
    });
  }

  function updateProductReview() {
    readVariantRows();
    const valid = editorVariants.filter((variant) => variant.size);
    const total = valid.reduce((sum, variant) => sum + Number(variant.stock || 0), 0);
    const empty = valid.filter((variant) => Number(variant.stock || 0) === 0).length;
    pStockSummary.innerHTML = `<strong>${total} unidades</strong><span>${valid.length} variações</span><span>${empty} sem estoque</span>`;
    const name = document.getElementById('pName').value.trim();
    pReviewTitle.textContent = pEditId.value ? 'Salvar todas as alterações' : 'Produto pronto para publicar?';
    pReviewSummary.textContent = `${name || 'Produto sem nome'} · ${valid.length} tamanho(s) · ${total} unidade(s)`;
    updateProductCompletion();
  }

  function updateProductCompletion() {
    const checks = [
      !!document.getElementById('pName').value.trim(),
      !!document.getElementById('pBrand').value.trim(),
      !!pCategory.value,
      !!document.getElementById('pDesc').value.trim(),
      !!pEditId.value || !!imageDataUrl,
      editorVariants.some((variant) => (variant.size || '').trim()),
    ];
    const done = checks.filter(Boolean).length;
    const percent = Math.round((done / checks.length) * 100);
    document.getElementById('pCompletionBar').style.width = `${percent}%`;
    document.getElementById('pCompletionLabel').textContent = `${percent}% preenchido`;
    const hints = [
      'Comece pelo nome do produto.',
      'Informe a marca.',
      'Escolha uma categoria.',
      'Adicione uma descrição que ajude na decisão de compra.',
      'Selecione a foto principal.',
      'Crie ao menos uma variação de tamanho.',
    ];
    document.getElementById('pCompletionHint').textContent = percent === 100 ? 'Tudo certo para revisar e publicar.' : hints[checks.findIndex((value) => !value)];
  }

  function renderEditorVariants() {
    pVariantRows.innerHTML = editorVariants.map((variant, index) => `
      <tr data-index="${index}">
        <td><input type="text" class="v-size" value="${escapeHtml(variant.size || '')}" placeholder="Ex: P ou 36" aria-label="Tamanho" /></td>
        <td><input type="text" class="v-color" value="${escapeHtml(variant.color || '')}" placeholder="Ex: Preto" aria-label="Cor" /></td>
        <td><input type="text" class="v-sku" value="${escapeHtml(variant.sku || '')}" placeholder="Gerado automaticamente" aria-label="SKU" /></td>
        <td><input type="number" class="v-stock" min="0" step="1" value="${Number(variant.stock || 0)}" aria-label="Estoque" /></td>
        <td><input type="text" class="v-measurements" value="${escapeHtml(variant.measurements || '')}" placeholder="Ex: 24cm sola" aria-label="Medidas" /></td>
        <td><button type="button" class="admin-variant-remove" data-index="${index}" aria-label="Remover variação">✕</button></td>
      </tr>
    `).join('');
    pVariantEmpty.hidden = editorVariants.length > 0;
    pVariantRows.querySelectorAll('input').forEach((input) => input.addEventListener('input', updateProductReview));
    pVariantRows.querySelectorAll('.admin-variant-remove').forEach((button) => {
      button.addEventListener('click', () => {
        readVariantRows();
        editorVariants.splice(Number(button.dataset.index), 1);
        renderEditorVariants();
      });
    });
    updateProductReview();
  }

  function addVariantRow(variant = {}) {
    readVariantRows();
    editorVariants.push({
      id: variant.id || '',
      size: variant.size || '',
      color: variant.color || '',
      sku: variant.sku || '',
      stock: Number(variant.stock || 0),
      measurements: variant.measurements || '',
    });
    renderEditorVariants();
    const lastInput = pVariantRows.querySelector('tr:last-child .v-size');
    if (lastInput && !variant.size) lastInput.focus();
  }

  pGenerateGrade.addEventListener('click', () => {
    readVariantRows();
    const sizes = gradePresets[pGradePreset.value] || [];
    if (!sizes.length) {
      addVariantRow({ color: pGradeColor.value.trim(), stock: pGradeStock.value });
      return;
    }
    const color = pGradeColor.value.trim();
    const stock = Math.max(0, Number.parseInt(pGradeStock.value, 10) || 0);
    let added = 0;
    sizes.forEach((size) => {
      const exists = editorVariants.some((variant) =>
        variant.size.toLocaleLowerCase('pt-BR') === size.toLocaleLowerCase('pt-BR')
        && (variant.color || '').toLocaleLowerCase('pt-BR') === color.toLocaleLowerCase('pt-BR'));
      if (!exists) {
        editorVariants.push({ id: '', size, color, sku: '', stock });
        added += 1;
      }
    });
    renderEditorVariants();
    setMsg(added ? `${added} variações adicionadas à grade.` : 'Essa combinação de tamanhos e cor já está na grade.', added ? 'ok' : 'error');
  });
  pAddVariant.addEventListener('click', () => addVariantRow());
  ['pName', 'pBrand', 'pPrice', 'pDesc', 'pTag', 'pComposition'].forEach((id) => document.getElementById(id).addEventListener('input', updateProductReview));
  [pCategory, pCollection].forEach((field) => field.addEventListener('change', updateProductReview));

  async function startEditProduct(p) {
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
    pComposition.value = p.composition || '';
    imageDataUrl = '';
    pImage.value = '';
    pPreview.src = p.img;
    pPreview.hidden = false;
    pImageHint.textContent = 'Escolha outra foto somente se quiser substituir a atual';
    productFormEyebrow.textContent = 'Editando produto';
    productFormTitle.textContent = p.name;
    pSubmit.textContent = 'Salvar produto completo';
    pCancelEdit.hidden = false;
    setMsg('', '');
    editorVariants = [];
    renderEditorVariants();
    galleryImages = [];
    renderGallery();
    renderProductList();
    productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const data = await api('/api/products/variants/list', 'POST', { productId: p.id });
      if (pEditId.value !== p.id) return;
      editorVariants = (data.variants || []).map((variant) => ({ ...variant, stock: Number(variant.stock || 0) }));
      renderEditorVariants();
      galleryImages = data.gallery || [];
      renderGallery();
    } catch (err) {
      setMsg(`Produto carregado, mas a grade não pôde ser aberta: ${err.message}`, 'error');
    }
  }

  function endEditProduct(scroll = false) {
    pEditId.value = '';
    productForm.reset();
    document.getElementById('pBrand').value = 'By NaNa';
    pPreview.hidden = true;
    imageDataUrl = '';
    pImageHint.textContent = 'JPG, PNG ou WebP';
    productFormEyebrow.textContent = 'Novo produto';
    productFormTitle.textContent = 'Cadastre o produto completo';
    pSubmit.textContent = 'Salvar produto completo';
    pCancelEdit.hidden = true;
    editorVariants = [];
    renderEditorVariants();
    galleryImages = [];
    renderGallery();
    renderProductList();
    if (scroll) productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  pCancelEdit.addEventListener('click', () => endEditProduct());
  pNewProduct.addEventListener('click', () => endEditProduct(true));
  renderEditorVariants();
  renderGallery();

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
    readVariantRows();
    const variants = editorVariants
      .map((variant) => ({
        id: variant.id || undefined,
        size: variant.size.trim(),
        color: variant.color.trim(),
        sku: variant.sku.trim(),
        stock: Number(variant.stock || 0),
        measurements: (variant.measurements || '').trim(),
      }))
      .filter((variant) => variant.size);
    if (!variants.length) {
      setMsg('Adicione ao menos um tamanho à grade do produto.', 'error');
      return;
    }
    const combinations = new Set(variants.map((variant) =>
      `${variant.size.toLocaleLowerCase('pt-BR')}|${variant.color.toLocaleLowerCase('pt-BR')}`));
    if (combinations.size !== variants.length) {
      setMsg('Existem tamanhos e cores repetidos na grade.', 'error');
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
        composition: pComposition.value.trim(),
        image: imageDataUrl,
        variants,
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
      renderUpsellList();

      const wasEditing = editing;
      endEditProduct();
      setMsg(wasEditing ? 'Produto atualizado ✓' : 'Produto publicado no catálogo ✓', 'ok');
    } catch (err) {
      setMsg(err.message, 'error');
    } finally {
      pSubmit.disabled = false;
      pSubmit.textContent = 'Salvar produto completo';
    }
  });

  // ---------- product list ----------
  const productList = document.getElementById('productList');
  const productCount = document.getElementById('productCount');
  const productSearch = document.getElementById('productSearch');
  const productCategoryFilter = document.getElementById('productCategoryFilter');
  const productSort = document.getElementById('productSort');

  function renderProductList() {
    const selectedCategory = productCategoryFilter.value;
    productCategoryFilter.innerHTML = '<option value="">Todas as categorias</option>' + CATEGORIES.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    productCategoryFilter.value = selectedCategory;
    const term = (productSearch.value || '').trim().toLowerCase();
    let list = term
      ? PRODUCTS.filter((p) => `${p.name} ${p.brand} ${p.category} ${p.collection || ''}`.toLowerCase().includes(term))
      : [...PRODUCTS];
    if (productCategoryFilter.value) list = list.filter((product) => product.category === productCategoryFilter.value);
    if (productSort.value === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    if (productSort.value === 'stock-low') list.sort((a, b) => Number(a.totalStock || 0) - Number(b.totalStock || 0));
    if (productSort.value === 'price-high') list.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));

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
        <img src="${escapeHtml(p.img)}" alt="${escapeHtml(p.name)}" />
        <div class="admin-product-item-body">
          <span class="admin-product-item-name">${escapeHtml(p.name)}</span>
          <span class="admin-product-item-meta">${escapeHtml(p.category)}${p.collection ? ` · ${escapeHtml(p.collection)}` : ''}</span>
          <span class="admin-product-item-meta">${(p.variants || []).length} variações · ${p.totalStock || 0} unidades</span>
          ${priceHtml}
          <div class="admin-product-item-actions">
            <button type="button" class="admin-product-item-edit" data-id="${p.id}">Editar produto</button>
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
          renderUpsellList();
        } catch (err) {
          alert(err.message);
        }
      });
      productList.appendChild(div);
    });
  }

  productSearch.addEventListener('input', renderProductList);
  productCategoryFilter.addEventListener('change', renderProductList);
  productSort.addEventListener('change', renderProductList);

  // ---------- estoque / variação (tamanho, cor) por produto ----------
  async function toggleVariantEditor(productId, container) {
    // o card do produto tem só ~200px de largura no grid — sem abrir em largura total,
    // os campos de tamanho/cor/sku ficam pequenos demais pra digitar com confiança.
    const card = container.closest('.admin-product-item');
    if (!container.hidden) {
      container.hidden = true;
      if (card) card.classList.remove('is-stock-open');
      return;
    }
    container.hidden = false;
    if (card) card.classList.add('is-stock-open');
    container.innerHTML = '<p class="admin-empty-block">Carregando...</p>';
    try {
      const data = await api('/api/products/variants/list', 'POST', { productId });
      renderVariantEditor(productId, container, data.variants || [], data.movements || []);
    } catch (err) {
      container.innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
    }
  }

  function updateStockButton(productId) {
    const p = PRODUCTS.find((x) => x.id === productId);
    const btn = document.querySelector(`.admin-product-item-stock[data-id="${productId}"]`);
    if (btn && p) {
      btn.textContent = p.totalStock === 0 ? 'Esgotado' : p.totalStock <= 4 ? `Estoque baixo (${p.totalStock})` : `Estoque (${p.totalStock})`;
      btn.classList.toggle('is-empty', p.totalStock === 0);
      btn.classList.toggle('is-low', p.totalStock > 0 && p.totalStock <= 4);
    }
  }

  function renderVariantEditor(productId, container, variants, movements = []) {
    const movementLabels = {
      initial: 'Saldo inicial',
      adjustment: 'Ajuste manual',
      sale: 'Venda',
      cancellation: 'Cancelamento',
    };
    container.innerHTML = `
      <div class="admin-stock-summary">
        <strong>${variants.reduce((sum, v) => sum + Number(v.stock || 0), 0)} unidades</strong>
        <span>${variants.filter((v) => v.stock === 0).length} tamanho(s) esgotado(s)</span>
        <span>${variants.filter((v) => v.stock > 0 && v.stock <= 2).length} com estoque baixo</span>
      </div>
      <div class="admin-variant-list">
        ${variants
          .map(
            (v) => `
          <div class="admin-variant-row" data-id="${v.id}">
            <label class="admin-variant-field"><span class="admin-variant-field-label">Tamanho</span><input type="text" class="v-size" placeholder="Ex: P, 38..." value="${escapeHtml(v.size || '')}" /></label>
            <label class="admin-variant-field"><span class="admin-variant-field-label">Cor</span><input type="text" class="v-color" placeholder="Ex: Preto" value="${escapeHtml(v.color || '')}" /></label>
            <label class="admin-variant-field"><span class="admin-variant-field-label">SKU</span><input type="text" class="v-sku" placeholder="Opcional" value="${escapeHtml(v.sku || '')}" /></label>
            <label class="admin-variant-field"><span class="admin-variant-field-label">Estoque</span><input type="number" class="v-stock" min="0" step="1" value="${v.stock}" /></label>
            <button type="button" class="btn btn-outline v-save">Salvar</button>
            <button type="button" class="admin-variant-remove" aria-label="Remover">✕</button>
          </div>`
          )
          .join('')}
      </div>
      <div class="admin-variant-row admin-variant-row-new">
        <label class="admin-variant-field"><span class="admin-variant-field-label">Tamanho</span><input type="text" class="v-size" placeholder="Ex: P, 38..." /></label>
        <label class="admin-variant-field"><span class="admin-variant-field-label">Cor</span><input type="text" class="v-color" placeholder="Ex: Preto" /></label>
        <label class="admin-variant-field"><span class="admin-variant-field-label">SKU</span><input type="text" class="v-sku" placeholder="Opcional" /></label>
        <label class="admin-variant-field"><span class="admin-variant-field-label">Estoque</span><input type="number" class="v-stock" min="0" step="1" value="0" /></label>
        <button type="button" class="btn btn-primary v-add">Adicionar nova variação</button>
      </div>
      <p class="admin-form-msg" hidden></p>
      <div class="admin-stock-history">
        <strong>Histórico recente</strong>
        ${
          movements.length
            ? movements.map((m) => `
              <div class="admin-stock-movement">
                <span>${m.size || '—'}${m.color ? ` · ${m.color}` : ''}</span>
                <span>${movementLabels[m.type] || m.type}${m.orderId ? ` · ${m.orderId}` : ''}</span>
                <b class="${m.quantity > 0 ? 'is-in' : 'is-out'}">${m.quantity > 0 ? '+' : ''}${m.quantity}</b>
                <small>Saldo ${m.stockAfter} · ${new Date(m.createdAt).toLocaleString('pt-BR')}</small>
              </div>`).join('')
            : '<p class="admin-empty-block">Nenhuma movimentação registrada ainda.</p>'
        }
      </div>
    `;

    const msgEl = container.querySelector('.admin-form-msg');
    function setVariantMsg(text, kind) {
      msgEl.textContent = text;
      msgEl.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
      msgEl.hidden = !text;
    }

    container.querySelectorAll('.admin-variant-row[data-id]').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.v-save').addEventListener('click', async () => {
        try {
          const data = await api('/api/products/variants/update', 'POST', {
            id,
            size: row.querySelector('.v-size').value,
            color: row.querySelector('.v-color').value,
            sku: row.querySelector('.v-sku').value,
            stock: row.querySelector('.v-stock').value,
          });
          PRODUCTS = data.products;
          renderVariantEditor(productId, container, data.variants, data.movements || []);
          updateStockButton(productId);
        } catch (err) {
          setVariantMsg(err.message, 'error');
        }
      });
      row.querySelector('.admin-variant-remove').addEventListener('click', async () => {
        if (!confirm('Remover esta variação?')) return;
        try {
          const data = await api('/api/products/variants', 'DELETE', { id });
          PRODUCTS = data.products;
          renderVariantEditor(productId, container, data.variants);
          updateStockButton(productId);
        } catch (err) {
          setVariantMsg(err.message, 'error');
        }
      });
    });

    const newRow = container.querySelector('.admin-variant-row-new');
    newRow.querySelector('.v-add').addEventListener('click', async () => {
      try {
        const data = await api('/api/products/variants', 'POST', {
          productId,
          size: newRow.querySelector('.v-size').value,
          color: newRow.querySelector('.v-color').value,
          sku: newRow.querySelector('.v-sku').value,
          stock: newRow.querySelector('.v-stock').value,
        });
        PRODUCTS = data.products;
        renderVariantEditor(productId, container, data.variants, data.movements || []);
        updateStockButton(productId);
      } catch (err) {
        setVariantMsg(err.message, 'error');
      }
    });
  }

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
        <div class="admin-featured-thumb"><img src="${escapeHtml(p.img)}" alt="${escapeHtml(p.name)}" /></div>
        <div class="admin-featured-info">
          <span class="admin-featured-name">${escapeHtml(p.name)}</span>
          <span class="admin-featured-meta">${escapeHtml(p.category)}${p.collection ? ` · ${escapeHtml(p.collection)}` : ''}</span>
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

  // ---------- leve também (curadoria manual da sacola) ----------
  const upsellList = document.getElementById('upsellList');
  const upsellSearch = document.getElementById('upsellSearch');

  function renderUpsellList() {
    const term = (upsellSearch.value || '').trim().toLowerCase();
    const list = term ? PRODUCTS.filter((p) => p.name.toLowerCase().includes(term)) : PRODUCTS;

    const upsell = list.filter((p) => p.isUpsell).sort((a, b) => a.upsellPosition - b.upsellPosition);
    const rest = list.filter((p) => !p.isUpsell);
    const ordered = [...upsell, ...rest];

    upsellList.innerHTML = '';
    if (!ordered.length) {
      upsellList.innerHTML = '<p class="admin-empty-block">Nenhum produto encontrado.</p>';
      return;
    }
    ordered.forEach((p) => {
      const div = document.createElement('div');
      div.className = `admin-featured-item${p.isUpsell ? ' is-featured' : ''}`;
      const idx = upsell.findIndex((f) => f.id === p.id);
      div.innerHTML = `
        <div class="admin-featured-thumb"><img src="${escapeHtml(p.img)}" alt="${escapeHtml(p.name)}" /></div>
        <div class="admin-featured-info">
          <span class="admin-featured-name">${escapeHtml(p.name)}</span>
          <span class="admin-featured-meta">${escapeHtml(p.category)}${p.collection ? ` · ${escapeHtml(p.collection)}` : ''}</span>
        </div>
        <div class="admin-featured-actions">
          <button type="button" class="admin-featured-move" data-dir="up" aria-label="Mover para cima" ${!p.isUpsell || idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="admin-featured-move" data-dir="down" aria-label="Mover para baixo" ${!p.isUpsell || idx === upsell.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="admin-featured-badge ${p.isUpsell ? 'is-on' : ''}">${p.isUpsell ? 'Marcado' : 'Marcar'}</button>
        </div>
      `;
      div.querySelector('.admin-featured-badge').addEventListener('click', async () => {
        try {
          const data = await api('/api/products/upsell', 'POST', { id: p.id, upsell: !p.isUpsell });
          PRODUCTS = data.products;
          renderUpsellList();
        } catch (err) {
          alert(err.message);
        }
      });
      div.querySelectorAll('.admin-featured-move').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const data = await api('/api/products/upsell/reorder', 'POST', { id: p.id, direction: btn.dataset.dir });
            PRODUCTS = data.products;
            renderUpsellList();
          } catch (err) {
            alert(err.message);
          }
        });
      });
      upsellList.appendChild(div);
    });
  }

  upsellSearch.addEventListener('input', renderUpsellList);

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
      promoTarget.innerHTML = PRODUCTS.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    } else if (scope === 'category') {
      promoTarget.innerHTML = CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    } else if (scope === 'collection') {
      promoTarget.innerHTML = COLLECTIONS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    } else {
      promoTarget.innerHTML = '';
    }
  }

  promoScope.addEventListener('change', renderPromoTargetOptions);

  function promoTargetLabel(promo) {
    if (promo.scope === 'site') return 'Loja inteira';
    if (promo.scope === 'product') {
      const p = PRODUCTS.find((x) => x.id === promo.target);
      return `Produto: ${escapeHtml(p ? p.name : promo.target)}`;
    }
    if (promo.scope === 'category') return `Categoria: ${escapeHtml(promo.target)}`;
    return `Coleção: ${escapeHtml(promo.target)}`;
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
          <span class="admin-promo-title">${promo.label ? `${escapeHtml(promo.label)} — ` : ''}${promoTargetLabel(promo)} · ${discountText}</span>
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
  const couponFirstPurchaseOnly = document.getElementById('couponFirstPurchaseOnly');
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
      const firstPurchaseTag = c.firstPurchaseOnly ? ' · só 1ª compra' : '';
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(c.code)} — ${discountText}${validity}${firstPurchaseTag}</span><button type="button" class="admin-coupon-edit" aria-label="Editar">✎</button><button type="button" aria-label="Remover">✕</button>`;
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
    couponFirstPurchaseOnly.checked = !!c.firstPurchaseOnly;
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
        firstPurchaseOnly: couponFirstPurchaseOnly.checked,
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

  // ---------- shipping rules (frete por UF) ----------
  const shippingForm = document.getElementById('shippingForm');
  const shippingEditId = document.getElementById('shippingEditId');
  const shippingUf = document.getElementById('shippingUf');
  const shippingLabel = document.getElementById('shippingLabel');
  const shippingPrice = document.getElementById('shippingPrice');
  const shippingFreeAbove = document.getElementById('shippingFreeAbove');
  const shippingActive = document.getElementById('shippingActive');
  const shippingSubmit = document.getElementById('shippingSubmit');
  const shippingCancelEdit = document.getElementById('shippingCancelEdit');
  const shippingFormTitle = document.getElementById('shippingFormTitle');
  const shippingMsg = document.getElementById('shippingMsg');
  const shippingList = document.getElementById('shippingList');

  function setShippingMsg(text, kind) {
    shippingMsg.textContent = text;
    shippingMsg.className = `admin-form-msg ${kind ? `is-${kind}` : ''}`;
    shippingMsg.hidden = !text;
  }

  function renderShippingList() {
    shippingList.innerHTML = '';
    if (!SHIPPING_RULES.length) {
      shippingList.innerHTML = '<li class="admin-empty">Nenhuma regra de frete cadastrada ainda.</li>';
      return;
    }
    SHIPPING_RULES.forEach((r) => {
      const ufText = r.uf === '*' ? 'Padrão (demais estados)' : r.uf;
      const freeText = r.freeAbove != null ? ` · grátis acima de ${money(r.freeAbove)}` : '';
      const inactiveText = r.active ? '' : ' · inativa';
      const li = document.createElement('li');
      li.innerHTML = `<span>${ufText}${r.label ? ` — ${escapeHtml(r.label)}` : ''} · ${money(r.price)}${freeText}${inactiveText}</span><button type="button" class="admin-coupon-edit" aria-label="Editar">✎</button><button type="button" aria-label="Remover">✕</button>`;
      li.querySelector('.admin-coupon-edit').addEventListener('click', () => startEditShipping(r));
      li.querySelector('button:not(.admin-coupon-edit)').addEventListener('click', async () => {
        if (!confirm(`Remover a regra de frete "${ufText}"?`)) return;
        const data = await api('/api/shipping-rules', 'DELETE', { id: r.id });
        SHIPPING_RULES = data.shippingRules;
        if (Number(shippingEditId.value) === r.id) endEditShipping();
        renderShippingList();
      });
      shippingList.appendChild(li);
    });
  }

  function startEditShipping(r) {
    shippingEditId.value = r.id;
    shippingUf.value = r.uf;
    shippingUf.readOnly = true;
    shippingLabel.value = r.label || '';
    shippingPrice.value = r.price;
    shippingFreeAbove.value = r.freeAbove != null ? r.freeAbove : '';
    shippingActive.checked = r.active;
    shippingFormTitle.textContent = `Editando regra "${r.uf === '*' ? 'Padrão' : r.uf}"`;
    shippingSubmit.textContent = 'Salvar alterações';
    shippingCancelEdit.hidden = false;
    setShippingMsg('', '');
    shippingForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function endEditShipping() {
    shippingEditId.value = '';
    shippingForm.reset();
    shippingActive.checked = true;
    shippingUf.readOnly = false;
    shippingFormTitle.textContent = 'Frete por estado';
    shippingSubmit.textContent = 'Adicionar regra';
    shippingCancelEdit.hidden = true;
    renderShippingList();
  }

  shippingCancelEdit.addEventListener('click', endEditShipping);

  shippingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setShippingMsg('', '');
    shippingSubmit.disabled = true;
    const editing = !!shippingEditId.value;
    try {
      const payload = editing
        ? {
            id: Number(shippingEditId.value),
            label: shippingLabel.value.trim(),
            price: shippingPrice.value,
            freeAbove: shippingFreeAbove.value,
            active: shippingActive.checked,
          }
        : {
            uf: shippingUf.value.trim(),
            label: shippingLabel.value.trim(),
            price: shippingPrice.value,
            freeAbove: shippingFreeAbove.value,
          };
      const data = editing
        ? await api('/api/shipping-rules/update', 'POST', payload)
        : await api('/api/shipping-rules', 'POST', payload);
      SHIPPING_RULES = data.shippingRules;
      const wasEditing = editing;
      endEditShipping();
      setShippingMsg(wasEditing ? 'Regra atualizada ✓' : 'Regra criada ✓', 'ok');
    } catch (err) {
      setShippingMsg(err.message, 'error');
    } finally {
      shippingSubmit.disabled = false;
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
      customerList.innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
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
          <span class="admin-customer-name">${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)}</span>
          <span class="admin-customer-meta">${escapeHtml(c.email)} · ${escapeHtml(c.phone)} · CPF ${escapeHtml(c.cpf)} · cliente desde ${formatDate(c.createdAt.slice(0, 10))}</span>
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
    // Prefixa com apóstrofo células que começam com =, +, -, @ ou tab/CR — sem isso, um nome
    // de cliente como "=cmd|'/c calc'!A1" vira uma fórmula executável ao abrir o CSV no Excel/Sheets.
    const csvEscape = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
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

  // ---------- newsletter (contatos captados no rodapé do site, fora de uma compra) ----------
  let NEWSLETTER_SUBSCRIBERS = [];
  const newsletterList = document.getElementById('newsletterList');
  const newsletterCount = document.getElementById('newsletterCount');

  async function loadNewsletter() {
    try {
      const data = await api('/api/newsletter/list', 'POST', {});
      NEWSLETTER_SUBSCRIBERS = data.subscribers || [];
      renderNewsletterList();
    } catch (err) {
      newsletterList.innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderNewsletterList() {
    newsletterCount.textContent = NEWSLETTER_SUBSCRIBERS.length;
    newsletterList.innerHTML = '';
    if (!NEWSLETTER_SUBSCRIBERS.length) {
      newsletterList.innerHTML = '<p class="admin-empty-block">Nenhum contato captado ainda.</p>';
      return;
    }
    NEWSLETTER_SUBSCRIBERS.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'admin-customer-item';
      div.innerHTML = `
        <div class="admin-customer-info">
          <span class="admin-customer-name">${escapeHtml(s.contact)}</span>
          <span class="admin-customer-meta">${s.channel === 'whatsapp' ? 'WhatsApp' : 'E-mail'} · captado em ${formatDate(s.createdAt.slice(0, 10))}</span>
        </div>
      `;
      newsletterList.appendChild(div);
    });
  }

  // ---------- avise-me quando chegar (pedidos de aviso de reposição, por variação esgotada) ----------
  let STOCK_NOTIFICATIONS = [];
  const stockNotifyList = document.getElementById('stockNotifyList');
  const stockNotifyCount = document.getElementById('stockNotifyCount');

  async function loadStockNotifications() {
    try {
      const data = await api('/api/admin/stock-notifications/list', 'POST', {});
      STOCK_NOTIFICATIONS = data.stockNotifications || [];
      renderStockNotifications();
    } catch (err) {
      stockNotifyList.innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderStockNotifications() {
    stockNotifyCount.textContent = STOCK_NOTIFICATIONS.length;
    stockNotifyList.innerHTML = '';
    if (!STOCK_NOTIFICATIONS.length) {
      stockNotifyList.innerHTML = '<p class="admin-empty-block">Nenhum pedido de aviso pendente.</p>';
      return;
    }
    STOCK_NOTIFICATIONS.forEach((n) => {
      const variantLabel = [n.size, n.color].filter(Boolean).join(' / ');
      const div = document.createElement('div');
      div.className = 'admin-customer-item';
      div.innerHTML = `
        <div class="admin-customer-info">
          <span class="admin-customer-name">${escapeHtml(n.productName)}${variantLabel ? ` — ${escapeHtml(variantLabel)}` : ''}</span>
          <span class="admin-customer-meta">${escapeHtml(n.contact)} · ${n.channel === 'whatsapp' ? 'WhatsApp' : 'E-mail'} · pedido em ${formatDate(n.createdAt.slice(0, 10))}${n.stock > 0 ? ' · estoque já disponível' : ''}</span>
        </div>
        ${n.channel === 'whatsapp' ? `<button type="button" class="btn btn-outline btn-sm" data-id="${n.id}">Marcar como contatado</button>` : ''}
      `;
      const btn = div.querySelector('button[data-id]');
      if (btn) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api('/api/admin/stock-notifications/mark-contacted', 'POST', { id: n.id });
            loadStockNotifications();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      }
      stockNotifyList.appendChild(div);
    });
  }

  const newsletterExportBtn = document.getElementById('newsletterExport');
  if (newsletterExportBtn) {
    newsletterExportBtn.addEventListener('click', () => {
      if (!NEWSLETTER_SUBSCRIBERS.length) {
        alert('Não há contatos para exportar.');
        return;
      }
      const header = ['Contato', 'Canal', 'Captado em'];
      // Prefixa com apóstrofo células que começam com =, +, -, @ ou tab/CR — sem isso, um nome
    // de cliente como "=cmd|'/c calc'!A1" vira uma fórmula executável ao abrir o CSV no Excel/Sheets.
    const csvEscape = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
      const rows = NEWSLETTER_SUBSCRIBERS.map((s) => [s.contact, s.channel, formatDate(s.createdAt.slice(0, 10))]);
      const csv = [header, ...rows].map((r) => r.map(csvEscape).join(';')).join('\r\n');
      const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `newsletter-bynana-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

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
      orderList.innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
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
      const itemsText = (o.items || []).map((it) => `${escapeHtml(it.qty)}x ${escapeHtml(it.name)}${it.variantLabel ? ` (${escapeHtml(it.variantLabel)})` : ''}`).join(', ');
      const when = new Date(o.createdAt).toLocaleString('pt-BR');
      // pedido "novo" há mais de 2h sem virar em_andamento provavelmente não recebeu retorno
      // no WhatsApp ainda — sinalizado aqui pra não passar batido numa loja de poucas vendas/dia.
      const isStale = o.status === 'novo' && Date.now() - new Date(o.createdAt).getTime() > 2 * 60 * 60 * 1000;
      const a = o.address;
      const addressText = a
        ? `${escapeHtml(a.rua || '')}, ${escapeHtml(a.numero || '')}${a.complemento ? ` - ${escapeHtml(a.complemento)}` : ''} - ${escapeHtml(a.bairro || '')}, ${escapeHtml(a.cidade || '')}/${escapeHtml(a.estado || '')} - CEP ${escapeHtml(a.cep || '')}`
        : '';
      const div = document.createElement('div');
      div.className = 'admin-order-item';
      div.innerHTML = `
        <div class="admin-order-info">
          <span class="admin-order-name">${escapeHtml(o.customerName)} · ${escapeHtml(o.customerPhone)}${isStale ? ' <span class="admin-order-stale-badge" title="Sem retorno há mais de 2h">⏰ Aguardando retorno</span>' : ''}</span>
          <span class="admin-order-meta">${when}${o.couponCode ? ` · cupom ${escapeHtml(o.couponCode)}` : ''} · ${escapeHtml(o.paymentMethod)} · ${escapeHtml(o.deliveryMethod)}${o.shipping ? ` · frete ${money(o.shipping)}` : ''}</span>
          ${addressText ? `<span class="admin-order-address">📍 ${addressText}</span>` : ''}
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

  // ---------- avaliações (moderação: só remoção, publicação é automática) ----------
  let REVIEWS = [];
  const reviewCount = document.getElementById('reviewCount');
  const reviewSearch = document.getElementById('reviewSearch');
  const reviewList = document.getElementById('reviewList');

  async function loadReviews() {
    try {
      const data = await api('/api/admin/reviews/list', 'POST', {});
      REVIEWS = data.reviews || [];
      renderReviewList();
    } catch (err) {
      reviewList.innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderReviewList() {
    const term = (reviewSearch.value || '').trim().toLowerCase();
    const list = term
      ? REVIEWS.filter((r) => `${r.productName} ${r.customerName}`.toLowerCase().includes(term))
      : REVIEWS;

    reviewCount.textContent = REVIEWS.length;
    reviewList.innerHTML = '';
    if (!list.length) {
      reviewList.innerHTML = '<p class="admin-empty-block">Nenhuma avaliação encontrada.</p>';
      return;
    }
    list.forEach((r) => {
      const when = new Date(r.createdAt).toLocaleString('pt-BR');
      const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
      const div = document.createElement('div');
      div.className = 'admin-order-item';
      div.innerHTML = `
        <div class="admin-order-info">
          <span class="admin-order-name">${escapeHtml(r.productName)} · ${stars}</span>
          <span class="admin-order-meta">${escapeHtml(r.customerName)} · ${when}</span>
          ${r.comment ? `<p class="admin-order-items">${escapeHtml(r.comment)}</p>` : ''}
        </div>
        <div class="admin-order-actions">
          <button type="button" class="btn btn-outline">Remover</button>
        </div>
      `;
      div.querySelector('button').addEventListener('click', async () => {
        if (!confirm('Remover essa avaliação?')) return;
        const data = await api('/api/reviews', 'DELETE', { id: r.id });
        REVIEWS = data.reviews;
        renderReviewList();
      });
      reviewList.appendChild(div);
    });
  }

  reviewSearch.addEventListener('input', renderReviewList);

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
  const MAX_STORY_VIDEO_BYTES = 25 * 1024 * 1024;
  const MAX_STORY_VIDEO_SECONDS = 30;

  function renderStoryProductSelect() {
    const current = stProduct.value;
    stProduct.innerHTML =
      '<option value="">Nenhum (usar link abaixo)</option>' +
      PRODUCTS.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    if (PRODUCTS.some((p) => p.id === current)) stProduct.value = current;
  }

  stVideo.addEventListener('change', () => {
    const file = stVideo.files[0];
    storyVideoDataUrl = '';
    stVideoPreview.hidden = true;
    if (!file) return;

    if (file.size > MAX_STORY_VIDEO_BYTES) {
      setStoryMsg('Arquivo muito grande. O vídeo deve ter no máximo 25MB.', 'error');
      stVideo.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      stVideoPreview.onloadedmetadata = () => {
        if (stVideoPreview.duration > MAX_STORY_VIDEO_SECONDS) {
          setStoryMsg(`O vídeo deve ter no máximo ${MAX_STORY_VIDEO_SECONDS} segundos.`, 'error');
          stVideo.value = '';
          stVideoPreview.hidden = true;
          storyVideoDataUrl = '';
          return;
        }
        setStoryMsg('', '');
        storyVideoDataUrl = dataUrl;
      };
      stVideoPreview.src = dataUrl;
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
      storyList.innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
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
        ? `<img src="${s.cover}" alt="${escapeHtml(s.title || 'Story')}" />`
        : `<video src="${s.video}" muted preload="metadata"></video>`;
      const linkedProduct = s.productId ? PRODUCTS.find((p) => p.id === s.productId) : null;
      const metaText = linkedProduct
        ? `Produto: ${escapeHtml(linkedProduct.name)}`
        : s.linkUrl
        ? `Botão: "${escapeHtml(s.linkLabel)}" → ${escapeHtml(s.linkUrl)}`
        : 'Sem botão de ação';
      div.innerHTML = `
        <div class="admin-story-thumb">${thumb}</div>
        <div class="admin-story-info">
          <span class="admin-story-title">${escapeHtml(s.title || '(sem título)')}</span>
          <span class="admin-story-meta">${metaText}</span>
          <div class="admin-story-product-edit">
            <select class="admin-story-product-select">
              <option value="">Nenhum produto</option>
              ${PRODUCTS.map((p) => `<option value="${p.id}" ${p.id === s.productId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
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
      adminUserList.innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
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
          <span class="admin-user-name">${escapeHtml(u.name)}${isSelf ? ' (você)' : ''}</span>
          <span class="admin-user-meta">${escapeHtml(u.email)} · desde ${formatDate(u.createdAt.slice(0, 10))}</span>
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
    'shipping_rule.create': 'criou a regra de frete',
    'shipping_rule.update': 'editou a regra de frete',
    'shipping_rule.delete': 'removeu a regra de frete',
    'review.delete': 'removeu uma avaliação',
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
      activityList.innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
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
        <span class="admin-activity-who">${escapeHtml(a.adminName)}</span>
        <span class="admin-activity-action">${escapeHtml(label)}${a.entityId ? ` (${escapeHtml(a.entityId)})` : ''}</span>
      `;
      activityList.appendChild(div);
    });
  }

  // ---------- dashboard + relatórios ----------
  // Fuso da loja (não o do navegador) — mesmo horário que o servidor usa pra agrupar vendas
  // por dia, então o range padrão "De/Até" bate com o que o relatório realmente mostra.
  function isoInStoreTimezone(date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
  function todayISO() {
    return isoInStoreTimezone(new Date());
  }
  function daysAgoISO(n) {
    return isoInStoreTimezone(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
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
        <div class="admin-bar-row-label"><span>${escapeHtml(i.label)}</span><span>${valueFormatter(i.value)}</span></div>
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
              <span class="admin-order-name">${escapeHtml(o.customerName)}</span>
              <span class="admin-order-meta">${new Date(o.createdAt).toLocaleString('pt-BR')} · ${money(o.total)}</span>
            </div>
          </div>`
          )
          .join('');
      }
    } catch (err) {
      document.getElementById('dashTopProducts').innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
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
      document.getElementById('relVendasStats').innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
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
          { label: 'Produto', render: (r) => escapeHtml(r.name) },
          { label: 'Quantidade', render: (r) => r.qty },
          { label: 'Receita', render: (r) => money(Number(r.revenue)) },
        ],
        data.products
      );
    } catch (err) {
      document.getElementById('relProdutosTable').innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
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
          { label: 'Código', render: (r) => escapeHtml(r.code) },
          { label: 'Usos', render: (r) => r.uses },
          { label: 'Desconto total', render: (r) => money(Number(r.totalDiscount)) },
        ],
        data.coupons
      );
      renderTable(
        document.getElementById('relPromotionsTable'),
        [
          { label: 'Promoção', render: (r) => escapeHtml(r.label || r.promoId) },
          { label: 'Usos', render: (r) => r.uses },
          { label: 'Quantidade', render: (r) => r.qty },
          { label: 'Desconto total', render: (r) => money(Number(r.totalDiscount)) },
        ],
        data.promotions
      );
    } catch (err) {
      document.getElementById('relCouponsTable').innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
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
      document.getElementById('relClientesStats').innerHTML = `<p class="admin-empty-block">${escapeHtml(err.message)}</p>`;
    }
  }

  // ---------- notificações internas (pedidos/clientes novos desde a última visita) ----------
  const notifBell = document.getElementById('notifBell');
  const notifBadge = document.getElementById('notifBadge');
  const notifPanel = document.getElementById('notifPanel');
  const notifEmpty = document.getElementById('notifEmpty');
  const notifOrdersItem = document.getElementById('notifOrdersItem');
  const notifCustomersItem = document.getElementById('notifCustomersItem');
  let notifPollTimer = null;

  async function loadNotifications() {
    try {
      const data = await api('/api/admin/notifications', 'POST', {});
      const total = data.newOrders + data.newCustomers;
      notifBadge.hidden = total === 0;
      notifBadge.textContent = total > 99 ? '99+' : String(total);

      notifOrdersItem.hidden = data.newOrders === 0;
      if (data.newOrders > 0) {
        notifOrdersItem.textContent = `${data.newOrders} pedido${data.newOrders > 1 ? 's' : ''} novo${data.newOrders > 1 ? 's' : ''}`;
      }
      notifCustomersItem.hidden = data.newCustomers === 0;
      if (data.newCustomers > 0) {
        notifCustomersItem.textContent = `${data.newCustomers} cliente${data.newCustomers > 1 ? 's' : ''} novo${data.newCustomers > 1 ? 's' : ''}`;
      }
      notifEmpty.hidden = total > 0;
    } catch {
      // notificação é um extra — uma falha aqui não deve incomodar o admin com um alert()
    }
  }

  function closeNotifPanel() {
    notifPanel.hidden = true;
  }

  notifBell.addEventListener('click', async (e) => {
    e.stopPropagation();
    const willOpen = notifPanel.hidden;
    closeAllTabGroups();
    notifPanel.hidden = !willOpen;
    if (willOpen) {
      try {
        await api('/api/admin/notifications/seen', 'POST', {});
        notifBadge.hidden = true;
      } catch {
        // idem — falha silenciosa
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.admin-notif-wrap')) closeNotifPanel();
  });

  [notifOrdersItem, notifCustomersItem].forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.querySelector(`.admin-tab[data-target="${btn.dataset.jump}"]`);
      if (target) target.click();
      closeNotifPanel();
    });
  });

  function startNotificationPolling() {
    loadNotifications();
    if (notifPollTimer) clearInterval(notifPollTimer);
    notifPollTimer = setInterval(loadNotifications, 30000);
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
