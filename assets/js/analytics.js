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
    /* eslint-disable */
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = true; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', id);
    window.fbq('track', 'PageView');
    state.meta = true;
  }

  async function init() {
    try {
      const res = await fetch('/api/public-config', { cache: 'no-store' });
      if (!res.ok) return;
      const config = await res.json();
      if (config.ga4MeasurementId) await initGA4(config.ga4MeasurementId);
      if (config.metaPixelId) await initMetaPixel(config.metaPixelId);
    } catch {
      // sem config alcançável, o site segue funcionando sem tracking — nunca deve travar a loja.
    }
  }

  function toItem(p, variant) {
    return {
      item_id: p.id,
      item_name: p.name,
      item_variant: variant ? [variant.size, variant.color].filter(Boolean).join(' / ') : undefined,
      price: Number(p.price || 0),
      quantity: 1,
    };
  }

  window.byNanaAnalytics = {
    trackViewItem(p) {
      if (state.ga4) gtag('event', 'view_item', { currency: 'BRL', value: Number(p.price || 0), items: [toItem(p)] });
      if (state.meta) fbq('track', 'ViewContent', { content_ids: [p.id], content_name: p.name, currency: 'BRL', value: Number(p.price || 0) });
    },
    trackAddToCart(p, variant) {
      if (state.ga4) gtag('event', 'add_to_cart', { currency: 'BRL', value: Number(p.price || 0), items: [toItem(p, variant)] });
      if (state.meta) fbq('track', 'AddToCart', { content_ids: [p.id], content_name: p.name, currency: 'BRL', value: Number(p.price || 0) });
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
    trackLead(source) {
      if (state.ga4) gtag('event', 'generate_lead', { source });
      if (state.meta) fbq('track', 'Lead', { content_name: source });
    },
  };

  init();
})();
