// Testes sem banco e sem servidor: regra de preço/desconto (assets/js/promo.js, a mesma usada na
// vitrine e no checkout) e validação da assinatura do webhook do PagBank.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const PromoEngine = require('../assets/js/promo.js');
const pagseguro = require('../payment-providers/pagseguro');

const TODAY = '2026-10-24';

test('promoção: escolhe o menor preço entre as vigentes e respeita datas e escopo', () => {
  const product = { id: 'vestido-1', price: 200, category: 'Vestidos', collection: 'Verão' };
  const promos = [
    { id: 'a', scope: 'site', type: 'percent', value: 10, active: true },
    { id: 'b', scope: 'category', target: 'Vestidos', type: 'fixed', value: 50, active: true },
    { id: 'c', scope: 'product', target: 'vestido-1', type: 'percent', value: 40, active: true, endDate: '2026-10-23' },
    { id: 'd', scope: 'collection', target: 'Inverno', type: 'percent', value: 90, active: true },
    { id: 'e', scope: 'site', type: 'percent', value: 60, active: false },
    { id: 'f', scope: 'site', type: 'percent', value: 70, active: true, startDate: '2026-11-01' },
  ];
  const best = PromoEngine.bestPromoForProduct(product, promos, TODAY);
  assert.equal(best.promo.id, 'b');
  assert.equal(best.price, 150);
  assert.equal(best.percent, 25);
  assert.equal(PromoEngine.bestPromoForProduct({ ...product, price: null }, promos, TODAY), null, 'sob consulta não tem promoção');
});

test('promoção de valor fixo maior que o preço não gera preço negativo', () => {
  const best = PromoEngine.bestPromoForProduct({ id: 'x', price: 30 }, [{ id: 'z', scope: 'site', type: 'fixed', value: 100, active: true }], TODAY);
  assert.equal(best.price, 0);
});

test('arredondamento monetário em centavos', () => {
  const best = PromoEngine.bestPromoForProduct({ id: 'x', price: 99.99 }, [{ id: 'z', scope: 'site', type: 'percent', value: 33, active: true }], TODAY);
  assert.equal(best.price, 66.99);
});

test('cupom: código sem diferenciar maiúsculas, recusado se inativo, expirado ou agendado', () => {
  const coupons = [
    { code: 'BEMVINDA', type: 'percent', value: 10, active: true },
    { code: 'VELHO', type: 'percent', value: 10, active: true, endDate: '2026-10-23' },
    { code: 'FUTURO', type: 'percent', value: 10, active: true, startDate: '2026-10-25' },
    { code: 'OFF', type: 'percent', value: 10, active: false },
  ];
  assert.equal(PromoEngine.findCoupon(coupons, ' bemvinda ', TODAY).code, 'BEMVINDA');
  for (const code of ['VELHO', 'FUTURO', 'OFF', 'NAOEXISTE', '', null]) {
    assert.equal(PromoEngine.findCoupon(coupons, code, TODAY), null, String(code));
  }
  assert.equal(PromoEngine.findCoupon(coupons, 'VELHO', '2026-10-23').code, 'VELHO', 'vale até o fim do último dia');
});

test('descontos de cupom, Pix e quantidade não se somam: vale só o maior', () => {
  const coupon = { code: 'C10', type: 'percent', value: 10 };
  assert.equal(PromoEngine.bestDiscount(100, { coupon, itemCount: 1, payment: 'Cartão' }).type, 'coupon');
  assert.equal(PromoEngine.bestDiscount(100, { coupon: { code: 'C3', type: 'percent', value: 3 }, itemCount: 1, payment: 'Pix' }).type, 'pix');
  const qty = PromoEngine.bestDiscount(100, { coupon, itemCount: 3, payment: 'Pix' });
  assert.equal(qty.type, 'quantity');
  assert.equal(qty.amount, 30);
  assert.equal(PromoEngine.bestDiscount(100, { itemCount: 2 }).amount, 20);
  assert.equal(PromoEngine.bestDiscount(0, { coupon, itemCount: 3 }), null, 'sem subtotal não há desconto');
  assert.equal(PromoEngine.bestDiscount(50, { coupon: { code: 'F', type: 'fixed', value: 80 }, itemCount: 1 }).amount, 50, 'cupom fixo limitado ao subtotal');
});

test('webhook PagBank: só aceita assinatura correta e interpreta pago, recusado e estornado', async () => {
  const previous = process.env.PAGSEGURO_TOKEN;
  process.env.PAGSEGURO_TOKEN = 'token-de-teste';
  try {
    const sign = (raw) => crypto.createHash('sha256').update(`token-de-teste-${raw}`).digest('hex');
    const call = (payload, signature) => {
      const raw = Buffer.from(JSON.stringify(payload));
      return pagseguro.handleWebhook({ headers: signature === undefined ? { 'x-authenticity-token': sign(raw.toString()) } : { 'x-authenticity-token': signature } }, raw);
    };
    const paid = { reference_id: 'pedido-1', charges: [{ id: 'CHAR_1', status: 'PAID', amount: { summary: { refunded: 0 } } }] };
    // Fase 1: o contrato do webhook passou a devolver também a cobrança e os valores (necessários
    // para estorno e histórico). Os três campos originais continuam verificados com o mesmo valor.
    assert.deepEqual(await call(paid), {
      orderId: 'pedido-1', status: 'paid', providerReference: 'CHAR_1',
      providerOrderId: null, chargeId: 'CHAR_1', chargeStatus: 'PAID', paidAmount: 0, refundedAmount: 0,
    });
    assert.equal(await call(paid, 'ab'.repeat(32)), null, 'assinatura errada');
    assert.equal(await call(paid, ''), null, 'sem assinatura');

    const declinedAfterPaid = { reference_id: 'pedido-1', charges: [{ id: 'C1', status: 'PAID' }, { id: 'C2', status: 'DECLINED' }] };
    assert.equal((await call(declinedAfterPaid)).status, 'paid', 'tentativa recusada depois não "despaga"');
    const declined = { reference_id: 'pedido-2', charges: [{ id: 'C3', status: 'DECLINED' }] };
    assert.equal((await call(declined)).status, 'failed');
    const refunded = { reference_id: 'pedido-3', charges: [{ id: 'C4', status: 'PAID', amount: { summary: { refunded: 1000 } } }] };
    assert.equal((await call(refunded)).status, 'refunded');
    assert.deepEqual(await call({ reference_id: 'pedido-4' }), { ignored: true }, 'evento sem cobrança é ignorado');

    process.env.PAGSEGURO_TOKEN = '';
    assert.equal(await call(paid), null, 'sem token configurado nenhum webhook é aceito');
  } finally {
    if (previous === undefined) delete process.env.PAGSEGURO_TOKEN;
    else process.env.PAGSEGURO_TOKEN = previous;
  }
});
