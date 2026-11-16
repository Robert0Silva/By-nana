// Auditoria de regras de negócio (novembro/2026). Cada teste afirma a regra ESPERADA de uma loja
// de moda; um teste que falha aponta uma divergência registrada em RELATORIO_AUDITORIA_ECOMMERCE.md.
// Os testes marcados "comportamento atual" documentam regras comerciais que ainda dependem de
// decisão da loja — passam hoje e servem de alerta se o comportamento mudar sem querer.
//
// Mesmo padrão de test/audit.test.js: produtos, pedidos e clientes descartáveis, apagados no fim.
// O servidor sobe com PAYMENT_PROVIDER=pagseguro e um token fictício só pra assinar webhooks
// localmente; nenhum pedido daqui chama a API do PagBank (são criados como manuais e marcados
// como 'pending' direto no banco, simulando um checkout online).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
require('./require-local-db');

const projectRoot = path.resolve(__dirname, '..');
const port = 18791;
const origin = `http://127.0.0.1:${port}`;
const WEBHOOK_TOKEN = 'token-ficticio-da-auditoria';
let server;
let pool;

let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}, 198.19.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

async function api(route, body, method = 'POST') {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

function hashPasswordForTest(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

const created = { products: [], admins: [], orders: [], customersByEmail: [], coupons: [], promotions: [] };

async function createAdmin(role) {
  const id = crypto.randomUUID();
  const email = `regras-${role}-${id.slice(0, 8)}@example.com`;
  await pool.query('INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
    [id, `Regras ${role}`, email, hashPasswordForTest('senhaRegras123'), role]);
  created.admins.push(id);
  const { data } = await api('/api/admin/login', { email, password: 'senhaRegras123' });
  assert.ok(data && data.token, 'login do admin de teste');
  return { id, token: data.token };
}

// variants: [{ size, color, stock }]
async function createProduct({ price = 100, variants = [{ size: 'P', stock: 5 }] } = {}) {
  const id = `regras-${crypto.randomUUID().slice(0, 12)}`;
  const { rows: [category] } = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1');
  await pool.query(
    `INSERT INTO products (id, name, category_id, price, img, description) VALUES ($1,$2,$3,$4,'assets/img/processed/logo.png','teste')`,
    [id, `Peça Regras ${id}`, category.id, price]
  );
  created.products.push(id);
  const ids = [];
  for (const [position, v] of variants.entries()) {
    const variantId = `${id}-v-${position}`;
    await pool.query('INSERT INTO product_variants (id, product_id, size, color, stock, position) VALUES ($1,$2,$3,$4,$5,$6)',
      [variantId, id, v.size, v.color || null, v.stock, position]);
    ids.push(variantId);
  }
  return { id, variants: ids };
}

function placeOrder(lines, extra = {}) {
  return api('/api/orders', {
    customerName: 'Cliente Regras',
    customerPhone: `319${String(crypto.randomInt(1e8)).padStart(8, '0')}`,
    paymentMethod: 'Cartão de crédito',
    deliveryMethod: 'Retirada em loja',
    items: lines,
    ...extra,
  }).then((result) => {
    if (result.data && result.data.orderId) created.orders.push(result.data.orderId);
    return result;
  });
}

const stockOf = async (variantId) => (await pool.query('SELECT stock FROM product_variants WHERE id = $1', [variantId])).rows[0].stock;
const orderRow = async (id) => (await pool.query('SELECT status, payment_status AS "paymentStatus", total FROM orders WHERE id = $1', [id])).rows[0];

// Notificação assinada exatamente como o PagBank assina: sha256("{token}-{corpo bruto}").
async function sendWebhook(orderId, charges) {
  const raw = JSON.stringify({ id: `ORDE_${orderId}`, reference_id: orderId, charges });
  const signature = crypto.createHash('sha256').update(`${WEBHOOK_TOKEN}-${raw}`).digest('hex');
  const response = await fetch(`${origin}/api/webhooks/pagseguro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-authenticity-token': signature },
    body: raw,
  });
  return response.status;
}
const charge = (status, refunded = 0) => ({ id: `CHAR_${crypto.randomUUID()}`, status, amount: { value: 10000, summary: { total: 10000, paid: status === 'PAID' ? 10000 : 0, refunded } } });

// Pedido "online" simulado: nasce manual (sem chamar o PagBank) e vira 'pending' no banco.
async function placeOnlineOrder(product, qty = 1) {
  const order = await placeOrder([{ id: product.id, variantId: product.variants[0], qty }]);
  assert.equal(order.status, 201);
  await pool.query("UPDATE orders SET payment_status = 'pending', payment_method = 'Pagamento online (Pix/cartão)' WHERE id = $1", [order.data.orderId]);
  return order.data.orderId;
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('O servidor de teste não iniciou a tempo');
}

test.before(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  server = spawn(process.execPath, ['serve.js'], {
    cwd: projectRoot,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      PAYMENT_PROVIDER: 'pagseguro', PAGSEGURO_TOKEN: WEBHOOK_TOKEN, PAGSEGURO_SANDBOX: 'true',
      SITE_URL: '', RESEND_API_KEY: '', STORE_NOTIFY_EMAIL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(async () => {
  if (server && !server.killed) server.kill();
  try {
    if (created.orders.length) {
      await pool.query('DELETE FROM product_reviews WHERE order_id = ANY($1)', [created.orders]);
      await pool.query('DELETE FROM inventory_movements WHERE order_id = ANY($1)', [created.orders]);
      await pool.query('DELETE FROM orders WHERE id = ANY($1)', [created.orders]);
    }
    if (created.promotions.length) await pool.query('DELETE FROM promotions WHERE id = ANY($1)', [created.promotions]);
    if (created.products.length) {
      await pool.query('DELETE FROM inventory_movements WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = ANY($1))', [created.products]);
      await pool.query('DELETE FROM products WHERE id = ANY($1)', [created.products]);
    }
    if (created.coupons.length) await pool.query('DELETE FROM coupons WHERE code = ANY($1)', [created.coupons]);
    if (created.customersByEmail.length) await pool.query('DELETE FROM customers WHERE lower(email) = ANY($1)', [created.customersByEmail]);
    if (created.admins.length) {
      await pool.query('DELETE FROM admin_activity_log WHERE admin_user_id = ANY($1)', [created.admins]);
      await pool.query('DELETE FROM admin_users WHERE id = ANY($1)', [created.admins]);
    }
  } finally {
    await pool.end();
  }
});

// ---------- 2/3. Variações e estoque (cenários A, B e C) ----------

test('[CEN-A/C] compra de M preta baixa só M preta; M branca e G continuam intactas', async () => {
  const product = await createProduct({ variants: [
    { size: 'M', color: 'Preta', stock: 3 },
    { size: 'M', color: 'Branca', stock: 1 },
    { size: 'G', color: 'Preta', stock: 0 },
  ] });
  const [mPreta, mBranca, gPreta] = product.variants;
  const order = await placeOrder([{ id: product.id, variantId: mPreta, qty: 2 }]);
  assert.equal(order.status, 201);
  assert.equal(order.data.total, 160, 'duas unidades de R$ 100, retirada, com o desconto automático de 2 peças (-20%)');
  assert.equal(await stockOf(mPreta), 1);
  assert.equal(await stockOf(mBranca), 1, 'outra cor do mesmo tamanho não pode ser consumida');
  assert.equal(await stockOf(gPreta), 0);
  const { rows } = await pool.query('SELECT items FROM orders WHERE id = $1', [order.data.orderId]);
  assert.equal(rows[0].items[0].variantLabel, 'M - Preta', 'pedido grava a variação escolhida');
});

test('[CEN-B] variação esgotada (sapato 37 com estoque 0) não pode ser comprada', async () => {
  const product = await createProduct({ variants: [{ size: '36', stock: 2 }, { size: '37', stock: 0 }] });
  const blocked = await placeOrder([{ id: product.id, variantId: product.variants[1], qty: 1 }]);
  assert.equal(blocked.status, 409);
  assert.equal(await stockOf(product.variants[1]), 0);
  assert.equal(await stockOf(product.variants[0]), 2);
});

test('quantidade acima do estoque da variação é recusada sem baixar nada', async () => {
  const product = await createProduct({ variants: [{ size: 'M', color: 'Azul', stock: 2 }, { size: 'M', color: 'Rosa', stock: 9 }] });
  const blocked = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 3 }]);
  assert.equal(blocked.status, 409);
  assert.equal(await stockOf(product.variants[0]), 2);
  assert.equal(await stockOf(product.variants[1]), 9);
});

test('quantidade zero, negativa ou não numérica é recusada', async () => {
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  for (const qty of [0, -1, 'abc', null]) {
    const r = await placeOrder([{ id: product.id, variantId: product.variants[0], qty }]);
    assert.equal(r.status, 400, `qty=${qty}`);
  }
  assert.equal(await stockOf(product.variants[0]), 5);
});

test('quantidade fracionada não vira compra de unidade inteira silenciosamente', async () => {
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const r = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1.5 }]);
  assert.equal(r.status, 400, `qty=1.5 deveria ser recusada; o servidor respondeu ${r.status}`);
});

// ---------- 6. Checkout: validação de entrada ----------

test('forma de pagamento fora da lista oferecida é recusada', async () => {
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const r = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }], { paymentMethod: 'Boleto em 12x sem juros' });
  assert.equal(r.status, 400, `forma de pagamento inventada foi aceita (status ${r.status})`);
});

test('UF inexistente no endereço de entrega é recusada', async () => {
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const r = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }], {
    deliveryMethod: 'Entrega',
    address: { cep: '30000000', rua: 'Rua Teste', numero: '1', bairro: 'Centro', cidade: 'Belo Horizonte', estado: 'ZZ' },
  });
  assert.equal(r.status, 400, `UF "ZZ" foi aceita (status ${r.status})`);
});

// ---------- 8. Ciclo de vida do pedido ----------

test('pedido cancelado não pode ir direto para concluído', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const order = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }]);
  const id = order.data.orderId;
  assert.equal((await api('/api/orders/status', { adminToken: owner.token, id, status: 'cancelado' })).status, 200);
  const jump = await api('/api/orders/status', { adminToken: owner.token, id, status: 'concluido' });
  assert.equal(jump.status, 409, `cancelado → concluído foi aceito (status ${jump.status})`);
});

test('pedido concluído não pode voltar para "novo"', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const order = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }]);
  const id = order.data.orderId;
  for (const status of ['em_andamento', 'enviado', 'concluido']) {
    assert.equal((await api('/api/orders/status', { adminToken: owner.token, id, status, trackingCode: 'BR1' })).status, 200);
  }
  const back = await api('/api/orders/status', { adminToken: owner.token, id, status: 'novo' });
  assert.equal(back.status, 409, `concluído → novo foi aceito (status ${back.status})`);
});

test('cancelar no painel um pedido já pago online não deixa "cancelado + pago" sem estorno', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const id = await placeOnlineOrder(product);
  assert.equal(await sendWebhook(id, [charge('PAID')]), 200);
  await api('/api/orders/status', { adminToken: owner.token, id, status: 'cancelado' });
  const row = await orderRow(id);
  assert.ok(!(row.status === 'cancelado' && row.paymentStatus === 'paid'),
    'pedido ficou cancelado com pagamento "pago" e nenhum estorno solicitado/registrado');
});

// ---------- PagBank: webhook ----------

test('webhook PAID repetido é idempotente: um pagamento, estoque intacto', async () => {
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const id = await placeOnlineOrder(product);
  assert.equal(await stockOf(product.variants[0]), 4);
  const paid = [charge('PAID')];
  assert.equal(await sendWebhook(id, paid), 200);
  const first = (await pool.query('SELECT paid_at FROM orders WHERE id = $1', [id])).rows[0].paid_at;
  assert.equal(await sendWebhook(id, paid), 200);
  const row = await orderRow(id);
  assert.equal(row.paymentStatus, 'paid');
  assert.equal(row.status, 'novo');
  assert.equal(await stockOf(product.variants[0]), 4);
  assert.deepEqual((await pool.query('SELECT paid_at FROM orders WHERE id = $1', [id])).rows[0].paid_at, first);
});

test('webhook com assinatura errada é recusado e não altera o pedido', async () => {
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const id = await placeOnlineOrder(product);
  const response = await fetch(`${origin}/api/webhooks/pagseguro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-authenticity-token': 'a'.repeat(64) },
    body: JSON.stringify({ reference_id: id, charges: [charge('PAID')] }),
  });
  assert.equal(response.status, 401);
  assert.equal((await orderRow(id)).paymentStatus, 'pending');
});

test('cartão recusado no checkout do PagBank não cancela o pedido enquanto o link ainda aceita outra tentativa', async () => {
  const product = await createProduct({ variants: [{ size: 'P', stock: 1 }] });
  const id = await placeOnlineOrder(product);
  const declined = charge('DECLINED');
  assert.equal(await sendWebhook(id, [declined]), 200);
  const afterDecline = await orderRow(id);
  const stockAfterDecline = await stockOf(product.variants[0]);
  // a cliente tenta outro cartão no mesmo link e paga
  assert.equal(await sendWebhook(id, [declined, charge('PAID')]), 200);
  const final = await orderRow(id);
  assert.equal(afterDecline.status, 'novo',
    `1ª recusa já cancelou o pedido e devolveu a peça (estoque ${stockAfterDecline}); depois o pagamento aprovado caiu num pedido ${final.status}/${final.paymentStatus}`);
});

test('estorno de pedido já concluído não devolve automaticamente ao estoque peça que não voltou', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ variants: [{ size: 'P', stock: 3 }] });
  const id = await placeOnlineOrder(product);
  assert.equal(await sendWebhook(id, [charge('PAID')]), 200);
  for (const status of ['em_andamento', 'enviado', 'concluido']) {
    assert.equal((await api('/api/orders/status', { adminToken: owner.token, id, status, trackingCode: 'BR1' })).status, 200);
  }
  assert.equal(await stockOf(product.variants[0]), 2);
  assert.equal(await sendWebhook(id, [charge('PAID', 10000)]), 200);
  const row = await orderRow(id);
  assert.equal(row.paymentStatus, 'refunded');
  assert.equal(await stockOf(product.variants[0]), 2,
    `estorno de pedido entregue somou a peça de volta ao estoque (agora ${await stockOf(product.variants[0])}) e marcou o pedido como ${row.status}`);
});

// ---------- 9/12. Conta do cliente e isolamento ----------

test('cliente só vê os próprios pedidos; token de uma não lista pedidos da outra', async () => {
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const tokens = [];
  for (const who of ['ana', 'bia']) {
    const email = `regras-${who}-${crypto.randomUUID().slice(0, 8)}@example.com`;
    created.customersByEmail.push(email);
    const r = await api('/api/customers', { firstName: who, lastName: 'Teste', email, phone: '31999990000', password: 'senhaSegura1', privacyAccepted: true });
    assert.equal(r.status, 201);
    tokens.push(r.data.token);
  }
  const anaOrder = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }], { customerToken: tokens[0] });
  assert.equal(anaOrder.status, 201);
  const bia = await api('/api/customers/orders', { token: tokens[1] });
  assert.equal(bia.status, 200);
  assert.ok(!bia.data.orders.some((o) => o.id === anaOrder.data.orderId));
  const ana = await api('/api/customers/orders', { token: tokens[0] });
  assert.ok(ana.data.orders.some((o) => o.id === anaOrder.data.orderId));
  const forged = await api('/api/customers/orders', { token: `${tokens[1].split('.')[0]}.assinatura-falsa` });
  assert.equal(forged.status, 401);
});

test('nome com HTML é guardado como texto e não quebra a resposta do pedido', async () => {
  const product = await createProduct({ variants: [{ size: 'P', stock: 5 }] });
  const r = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }], { customerName: '<img src=x onerror=alert(1)>' });
  assert.equal(r.status, 201);
  const { rows } = await pool.query('SELECT customer_name FROM orders WHERE id = $1', [r.data.orderId]);
  assert.equal(rows[0].customer_name, '<img src=x onerror=alert(1)>', 'grava literal; o escape é feito na exibição');
});

// ---------- Regras comerciais a confirmar (comportamento atual) ----------

test('comportamento atual: promoção do produto e cupom do pedido se somam', async () => {
  const product = await createProduct({ price: 100, variants: [{ size: 'P', stock: 5 }] });
  const promoId = `regras-promo-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query("INSERT INTO promotions (id, scope, target_product_id, discount_type, discount_value, label) VALUES ($1,'product',$2,'percent',40,'teste')", [promoId, product.id]);
  created.promotions.push(promoId);
  const code = `REGRAS${crypto.randomInt(1e6)}`;
  await pool.query("INSERT INTO coupons (code, discount_type, discount_value) VALUES ($1,'percent',30)", [code]);
  created.coupons.push(code);
  const r = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }], { couponCode: code });
  assert.equal(r.status, 201);
  assert.equal(r.data.total, 42, 'R$ 100 → 60 (promoção 40%) → 42 (cupom 30%)');
});

test('comportamento atual: 3 peças em promoção ganham +30% automático por quantidade', async () => {
  const product = await createProduct({ price: 100, variants: [{ size: 'P', stock: 5 }] });
  const promoId = `regras-promo-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query("INSERT INTO promotions (id, scope, target_product_id, discount_type, discount_value, label) VALUES ($1,'product',$2,'percent',50,'teste')", [promoId, product.id]);
  created.promotions.push(promoId);
  const r = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 3 }]);
  assert.equal(r.status, 201);
  assert.equal(r.data.total, 105, 'R$ 300 → 150 (promoção 50%) → 105 (3+ itens -30%): 65% abaixo do preço de tabela');
});

test('comportamento atual: peça "sob consulta" fecha pedido com total R$ 0', async () => {
  const product = await createProduct({ price: null, variants: [{ size: 'P', stock: 5 }] });
  const r = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }]);
  assert.equal(r.status, 201);
  assert.equal(r.data.total, 0);
  assert.equal(await stockOf(product.variants[0]), 4, 'e a peça fica reservada');
});

test('comportamento atual: usuária staff consegue excluir cliente', async () => {
  const staff = await createAdmin('staff');
  const email = `regras-del-${crypto.randomUUID().slice(0, 8)}@example.com`;
  created.customersByEmail.push(email);
  const c = await api('/api/customers', { firstName: 'Del', lastName: 'Teste', email, phone: '31999990000', password: 'senhaSegura1', privacyAccepted: true });
  assert.equal(c.status, 201);
  const r = await api('/api/customers', { adminToken: staff.token, id: c.data.customer.id }, 'DELETE');
  assert.equal(r.status, 200);
});

// ---------- Revisão de 16/11/2026 ----------

test('pagamento online com peça "sob consulta" na sacola é recusado sem reservar estoque', async () => {
  const consult = await createProduct({ price: null, variants: [{ size: 'P', stock: 5 }] });
  const priced = await createProduct({ price: 100, variants: [{ size: 'P', stock: 5 }] });
  const r = await placeOrder([
    { id: priced.id, variantId: priced.variants[0], qty: 1 },
    { id: consult.id, variantId: consult.variants[0], qty: 1 },
  ], { paymentMethod: 'Pagamento online (Pix/cartão)' });
  assert.equal(r.status, 400, `pedido online com peça sob consulta foi aceito (status ${r.status})`);
  assert.equal(await stockOf(priced.variants[0]), 5);
  assert.equal(await stockOf(consult.variants[0]), 5);
  const manual = await placeOrder([{ id: consult.id, variantId: consult.variants[0], qty: 1 }], { paymentMethod: 'Pix' });
  assert.equal(manual.status, 201, 'pelo WhatsApp a peça sob consulta continua podendo ser pedida');
});

test('pagamento aprovado com valor menor que o total fica marcado para conferência', async () => {
  const product = await createProduct({ price: 250, variants: [{ size: 'P', stock: 5 }] });
  const id = await placeOnlineOrder(product);
  assert.equal(Number((await orderRow(id)).total), 250);
  assert.equal(await sendWebhook(id, [charge('PAID')]), 200); // a cobrança simulada é de R$ 100
  const { rows: [row] } = await pool.query('SELECT payment_status AS "paymentStatus", payment_attention AS "attention" FROM orders WHERE id = $1', [id]);
  assert.equal(row.paymentStatus, 'paid', 'o dinheiro recebido continua registrado');
  assert.equal(row.attention, 'amount_mismatch');
});

test('pagamento aprovado com o valor certo não gera alerta de valor', async () => {
  const product = await createProduct({ price: 100, variants: [{ size: 'P', stock: 5 }] });
  const id = await placeOnlineOrder(product);
  assert.equal(await sendWebhook(id, [charge('PAID')]), 200);
  const { rows: [row] } = await pool.query('SELECT payment_attention AS "attention" FROM orders WHERE id = $1', [id]);
  assert.equal(row.attention, null);
});

test('relatório de vendas não conta pedido online ainda sem pagamento', async () => {
  const owner = await createAdmin('owner');
  const range = { adminToken: owner.token, from: '2000-01-01', to: '2100-01-01' };
  const revenue = async () => Number((await api('/api/admin/reports/sales', range)).data.summary.revenue);
  const before = await revenue();
  const product = await createProduct({ price: 100, variants: [{ size: 'P', stock: 5 }] });
  const id = await placeOnlineOrder(product);
  assert.equal(await revenue(), before, 'pedido pendente entrou no faturamento');
  assert.equal(await sendWebhook(id, [charge('PAID')]), 200);
  assert.equal(await revenue(), before + 100, 'depois de pago, entra no faturamento');
});

test('JSON malformado responde 400, não 500', async () => {
  const response = await fetch(`${origin}/api/orders/list`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() }, body: '{"adminToken":',
  });
  assert.equal(response.status, 400);
});

test('rota do painel recusa corpo grande antes de conferir a sessão', async () => {
  const response = await fetch(`${origin}/api/orders/list`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ adminToken: 'x', lixo: 'a'.repeat(2 * 1024 * 1024) }),
  });
  assert.equal(response.status, 413);
});
