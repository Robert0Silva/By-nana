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
  };
})();
