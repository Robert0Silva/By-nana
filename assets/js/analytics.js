// Camada fina de analytics/pixel. Fica "pronta pra ligar": busca o ID configurado no servidor
// (env vars GA4_MEASUREMENT_ID / META_PIXEL_ID — ver serve.js) e só carrega o script do
// Google/Meta se o ID existir. Sem ID configurado, todo track* vira no-op silencioso — o site
// funciona normalmente antes da cliente ter as contas de anúncio criadas.
//
// Para ativar depois: criar a conta no Google Analytics (GA4) e/ou Meta Business (Pixel),
// pegar o ID de cada uma e colocar nas variáveis de ambiente do servidor:
//   GA4_MEASUREMENT_ID=G-XXXXXXXXXX
//   META_PIXEL_ID=000000000000000
// Não precisa mexer em nenhum HTML/JS — a página busca esses valores em /api/public-config.
(function () {
  const state = { ga4: false, meta: false };

  function loadScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.async = true;
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  async function initGA4(id) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', id, { send_page_view: true });
    await loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`);
    state.ga4 = true;
  }

  async function initMetaPixel(id) {
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = true; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', id);
    window.fbq('track', 'PageView');
    state.meta = true;
  }

  // ---------- consentimento (LGPD) ----------
  // GA4 e Meta Pixel gravam cookies de medição/publicidade: só carregam depois que a
  // visitante aceita. A escolha fica no navegador; "Recusar" mantém a loja funcionando igual.
  const CONSENT_KEY = 'bynana_cookie_consent';

  function readConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
  }

  function saveConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch { /* modo privado: vale só nesta visita */ }
  }

  function askConsent(onAccept) {
    const banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Aviso de cookies');
    banner.innerHTML = `
      <p>Usamos cookies de medição e anúncios (Google e Meta) para entender as visitas e melhorar a loja. Você escolhe. <a href="/politica-privacidade.html">Saiba mais</a></p>
      <div class="cookie-banner-actions">
        <button type="button" class="cookie-btn" data-consent="denied">Recusar</button>
        <button type="button" class="cookie-btn is-primary" data-consent="granted">Aceitar</button>
      </div>`;
    banner.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-consent]');
      if (!btn) return;
      saveConsent(btn.dataset.consent);
      banner.remove();
      if (btn.dataset.consent === 'granted') onAccept();
    });
    document.body.appendChild(banner);
  }

  async function startTracking(config) {
    if (config.ga4MeasurementId) await initGA4(config.ga4MeasurementId);
    if (config.metaPixelId) await initMetaPixel(config.metaPixelId);
  }

  async function init() {
    try {
      const res = await fetch('/api/public-config', { cache: 'no-store' });
      if (!res.ok) return;
      const config = await res.json();
      // sem nenhum ID configurado não há cookie de terceiro, então nem pergunta
      if (!config.ga4MeasurementId && !config.metaPixelId) return;
      const consent = readConsent();
      if (consent === 'granted') await startTracking(config);
      else if (consent !== 'denied') askConsent(() => startTracking(config));
    } catch {
      // sem config alcançável, o site segue funcionando sem tracking — nunca deve travar a loja.
    }
  }

  // price = preço efetivo (com promoção) que a cliente está vendo; p.price é o preço cheio.
  function toItem(p, variant, price) {
    return {
      item_id: p.id,
      item_name: p.name,
      item_variant: variant ? [variant.size, variant.color].filter(Boolean).join(' / ') : undefined,
      price: Number(price ?? p.price ?? 0),
      quantity: 1,
    };
  }

  window.byNanaAnalytics = {
    trackViewItem(p, price) {
      const value = Number(price ?? p.price ?? 0);
      if (state.ga4) gtag('event', 'view_item', { currency: 'BRL', value, items: [toItem(p, null, price)] });
      if (state.meta) fbq('track', 'ViewContent', { content_ids: [p.id], content_name: p.name, currency: 'BRL', value });
    },
    trackAddToCart(p, variant, price) {
      const value = Number(price ?? p.price ?? 0);
      if (state.ga4) gtag('event', 'add_to_cart', { currency: 'BRL', value, items: [toItem(p, variant, price)] });
      if (state.meta) fbq('track', 'AddToCart', { content_ids: [p.id], content_name: p.name, currency: 'BRL', value });
    },
    trackBeginCheckout(total) {
      if (state.ga4) gtag('event', 'begin_checkout', { currency: 'BRL', value: Number(total || 0) });
      if (state.meta) fbq('track', 'InitiateCheckout', { currency: 'BRL', value: Number(total || 0) });
    },
    trackPurchase(orderId, total, items) {
      const gaItems = (items || []).map((it) => ({ item_id: it.id, item_name: it.name, price: Number(it.price || 0), quantity: it.qty || 1 }));
      if (state.ga4) gtag('event', 'purchase', { transaction_id: orderId, currency: 'BRL', value: Number(total || 0), items: gaItems });
      if (state.meta) fbq('track', 'Purchase', { content_ids: (items || []).map((it) => it.id), currency: 'BRL', value: Number(total || 0) });
    },
    // Pedido fechado pelo WhatsApp: é um lead qualificado (com valor), não uma compra — o
    // pagamento ainda vai ser combinado na conversa.
    trackWhatsappOrder(orderId, total, items) {
      const value = Number(total || 0);
      const gaItems = (items || []).map((it) => ({ item_id: it.id, item_name: it.name, price: Number(it.price || 0), quantity: it.qty || 1 }));
      if (state.ga4) gtag('event', 'generate_lead', { source: 'whatsapp_order', transaction_id: orderId, currency: 'BRL', value, items: gaItems });
      if (state.meta) fbq('track', 'Lead', { content_name: 'whatsapp_order', content_ids: (items || []).map((it) => it.id), currency: 'BRL', value });
    },
    trackLead(source) {
      if (state.ga4) gtag('event', 'generate_lead', { source });
      if (state.meta) fbq('track', 'Lead', { content_name: source });
    },
  };

  init();
})();
