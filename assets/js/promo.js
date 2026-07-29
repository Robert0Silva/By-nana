// Shared promotion/coupon math used by both the storefront (main.js) and the admin panel (admin.js).
(() => {
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function isPromoActive(promo, todayStr) {
    if (!promo.active) return false;
    const today = todayStr || todayISO();
    if (promo.startDate && today < promo.startDate) return false;
    if (promo.endDate && today > promo.endDate) return false;
    return true;
  }

  // 'agendada' (starts later), 'ativa' (live now) or 'expirada' (end date passed).
  function promoStatus(promo, todayStr) {
    const today = todayStr || todayISO();
    if (promo.endDate && today > promo.endDate) return 'expirada';
    if (promo.startDate && today < promo.startDate) return 'agendada';
    return 'ativa';
  }

  function appliesTo(promo, product) {
    if (promo.scope === 'site') return true;
    if (promo.scope === 'category') return product.category === promo.target;
    if (promo.scope === 'collection') return product.collection === promo.target;
    if (promo.scope === 'product') return product.id === promo.target;
    return false;
  }

  function discountedPrice(price, promo) {
    if (promo.type === 'percent') return Math.max(0, price * (1 - promo.value / 100));
    return Math.max(0, price - promo.value);
  }

  // Best (lowest) price across every currently-active promotion that applies to this product.
  function bestPromoForProduct(product, promotions, todayStr) {
    if (product.price == null) return null;
    const today = todayStr || todayISO();
    let best = null;
    let bestPrice = product.price;
    (promotions || []).forEach((promo) => {
      if (!isPromoActive(promo, today)) return;
      if (!appliesTo(promo, product)) return;
      const price = discountedPrice(product.price, promo);
      if (price < bestPrice) {
        bestPrice = price;
        best = promo;
      }
    });
    if (!best) return null;
    const rounded = Math.round(bestPrice * 100) / 100;
    const percent = Math.round((1 - rounded / product.price) * 100);
    return { promo: best, price: rounded, percent };
  }

  function activeSitePromo(promotions, todayStr) {
    const today = todayStr || todayISO();
    return (promotions || []).find((p) => p.scope === 'site' && isPromoActive(p, today)) || null;
  }

  function findCoupon(coupons, code, todayStr) {
    if (!code) return null;
    const today = todayStr || todayISO();
    const c = (coupons || []).find((x) => x.code.toUpperCase() === code.trim().toUpperCase());
    if (!c || !c.active) return null;
    if (c.startDate && today < c.startDate) return null;
    if (c.endDate && today > c.endDate) return null;
    return c;
  }

  function applyCoupon(total, coupon) {
    if (!coupon) return total;
    if (coupon.type === 'percent') return Math.max(0, total * (1 - coupon.value / 100));
    return Math.max(0, total - coupon.value);
  }

  // ---------- desconto automático de Pix e progressivo por quantidade ----------
  const PIX_DISCOUNT_PERCENT = 5;
  // Faixas em ordem decrescente de minQty — a primeira que a quantidade atender vence.
  const QUANTITY_DISCOUNT_TIERS = [
    { minQty: 3, percent: 30 },
    { minQty: 2, percent: 20 },
  ];

  function quantityDiscountTier(itemCount) {
    return QUANTITY_DISCOUNT_TIERS.find((t) => itemCount >= t.minQty) || null;
  }

  // Calcula cupom, Pix e desconto por quantidade sobre o mesmo subtotal e aplica só o maior
  // dos três (nunca soma) — mantém o total previsível para a cliente.
  function bestDiscount(subtotal, { coupon, itemCount, payment } = {}) {
    if (!subtotal) return null;
    const candidates = [];

    if (coupon) {
      const amount = subtotal - applyCoupon(subtotal, coupon);
      if (amount > 0) candidates.push({ type: 'coupon', label: `Cupom ${coupon.code}`, amount });
    }

    if (payment === 'Pix') {
      const amount = subtotal * (PIX_DISCOUNT_PERCENT / 100);
      if (amount > 0) candidates.push({ type: 'pix', label: `Desconto Pix (-${PIX_DISCOUNT_PERCENT}%)`, amount });
    }

    const tier = quantityDiscountTier(itemCount || 0);
    if (tier) {
      const amount = subtotal * (tier.percent / 100);
      if (amount > 0) candidates.push({ type: 'quantity', label: `${tier.minQty}+ itens (-${tier.percent}%)`, amount });
    }

    if (!candidates.length) return null;
    return candidates.reduce((best, c) => (c.amount > best.amount ? c : best));
  }

  window.PromoEngine = {
    todayISO,
    isPromoActive,
    promoStatus,
    appliesTo,
    discountedPrice,
    bestPromoForProduct,
    activeSitePromo,
    findCoupon,
    applyCoupon,
    bestDiscount,
    PIX_DISCOUNT_PERCENT,
    QUANTITY_DISCOUNT_TIERS,
  };
})();
