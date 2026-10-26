// Regressões da auditoria de outubro/2026: concorrência no checkout, integridade de estoque e
// preço, permissões do painel e entradas inválidas. Cada teste cria o próprio produto
// descartável (nunca mexe no estoque de peças reais) e apaga tudo o que criou no final.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
require('./require-local-db');

const projectRoot = path.resolve(__dirname, '..');
const port = 18789;
const origin = `http://127.0.0.1:${port}`;
let server;
let pool;

// IP de documentação diferente por requisição: o rate limit de /api/orders é por IP.
let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `192.0.2.${(ipCounter % 250) + 1}, 198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
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

const created = { products: [], admins: [], orders: [], customersByEmail: [], coupons: [], carts: [] };

async function createAdmin(role) {
  const id = crypto.randomUUID();
  const email = `audit-${role}-${id.slice(0, 8)}@example.com`;
  await pool.query('INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
    [id, `Audit ${role}`, email, hashPasswordForTest('senhaAudit123'), role]);
  created.admins.push(id);
  const { data } = await api('/api/admin/login', { email, password: 'senhaAudit123' });
  assert.ok(data && data.token, 'login do admin de teste');
  return { id, token: data.token };
}

async function createProduct({ price = 100, sizes = ['P'], stock = 5 } = {}) {
  const id = `audit-${crypto.randomUUID().slice(0, 12)}`;
  const { rows: [category] } = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1');
  await pool.query(
    `INSERT INTO products (id, name, category_id, price, img, description) VALUES ($1,$2,$3,$4,'assets/img/processed/logo.png','teste')`,
    [id, `Peça de Auditoria ${id}`, category.id, price]
  );
  created.products.push(id);
  const variants = [];
  for (const [position, size] of sizes.entries()) {
    const variantId = `${id}-v-${size.toLowerCase()}`;
    await pool.query('INSERT INTO product_variants (id, product_id, size, stock, position) VALUES ($1,$2,$3,$4,$5)', [variantId, id, size, stock, position]);
    variants.push(variantId);
  }
  return { id, variants };
}

function placeOrder(lines, extra = {}) {
  return api('/api/orders', {
    customerName: 'Cliente Auditoria',
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
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(async () => {
  if (server && !server.killed) server.kill();
  try {
    if (created.orders.length) {
      await pool.query('DELETE FROM inventory_movements WHERE order_id = ANY($1)', [created.orders]);
      await pool.query('DELETE FROM orders WHERE id = ANY($1)', [created.orders]);
    }
    if (created.products.length) {
      await pool.query('DELETE FROM inventory_movements WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = ANY($1))', [created.products]);
      await pool.query('DELETE FROM products WHERE id = ANY($1)', [created.products]);
    }
    if (created.coupons.length) await pool.query('DELETE FROM coupons WHERE code = ANY($1)', [created.coupons]);
    if (created.carts.length) await pool.query('DELETE FROM abandoned_carts WHERE contact_email = ANY($1)', [created.carts]);
    if (created.customersByEmail.length) await pool.query('DELETE FROM customers WHERE lower(email) = ANY($1)', [created.customersByEmail]);
    if (created.admins.length) {
      await pool.query('DELETE FROM admin_activity_log WHERE admin_user_id = ANY($1)', [created.admins]);
      await pool.query('DELETE FROM admin_users WHERE id = ANY($1)', [created.admins]);
    }
  } finally {
    await pool.end();
  }
});

// ---------- checkout: concorrência e estoque ----------

test('duas clientes disputando a última unidade: só um pedido é aprovado e o estoque não fica negativo', async () => {
  const product = await createProduct({ stock: 1 });
  const results = await Promise.all(Array.from({ length: 8 }, () => placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }])));
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1, statuses.join(','));
  assert.ok(statuses.filter((s) => s !== 201).every((s) => s === 409), statuses.join(','));
  assert.equal(await stockOf(product.variants[0]), 0);
});

test('pedidos simultâneos com as mesmas peças em ordem diferente não entram em deadlock', async () => {
  const a = await createProduct({ stock: 100 });
  const b = await createProduct({ stock: 100 });
  const lineA = { id: a.id, variantId: a.variants[0], qty: 1 };
  const lineB = { id: b.id, variantId: b.variants[0], qty: 1 };
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => placeOrder(i % 2 ? [lineA, lineB] : [lineB, lineA])));
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.every((s) => s === 201), `todas deveriam ser 201: ${statuses.join(',')}`);
  assert.equal(await stockOf(a.variants[0]), 76);
  assert.equal(await stockOf(b.variants[0]), 76);
});

test('a mesma variação em várias linhas soma para o limite de 10 unidades por peça', async () => {
  const product = await createProduct({ stock: 50 });
  const line = { id: product.id, variantId: product.variants[0], qty: 5 };
  const tooMany = await placeOrder([line, line, line]);
  assert.equal(tooMany.status, 400, JSON.stringify(tooMany.data));
  assert.equal(await stockOf(product.variants[0]), 50, 'pedido recusado não pode baixar estoque');

  const merged = await placeOrder([line, line]);
  assert.equal(merged.status, 201, JSON.stringify(merged.data));
  assert.equal(merged.data.items.length, 1, 'linhas repetidas viram uma só');
  assert.equal(merged.data.items[0].qty, 10);
  assert.equal(await stockOf(product.variants[0]), 40);
});

test('estoque insuficiente recusa o pedido inteiro sem baixar nenhuma das outras peças', async () => {
  const plenty = await createProduct({ stock: 10 });
  const scarce = await createProduct({ stock: 1 });
  const result = await placeOrder([
    { id: plenty.id, variantId: plenty.variants[0], qty: 2 },
    { id: scarce.id, variantId: scarce.variants[0], qty: 2 },
  ]);
  assert.equal(result.status, 409);
  assert.match(result.data.error, /somente 1 unidade/);
  assert.equal(await stockOf(plenty.variants[0]), 10, 'a transação inteira precisa ser desfeita');
});

test('variação de outro produto ou inexistente não é aceita no pedido', async () => {
  const a = await createProduct();
  const b = await createProduct();
  const mismatch = await placeOrder([{ id: a.id, variantId: b.variants[0], qty: 1 }]);
  assert.equal(mismatch.status, 400);
  const missing = await placeOrder([{ id: a.id, variantId: 'nao-existe', qty: 1 }]);
  assert.equal(missing.status, 400);
  const zero = await placeOrder([{ id: a.id, variantId: a.variants[0], qty: 0 }]);
  assert.equal(zero.status, 400);
  const negative = await placeOrder([{ id: a.id, variantId: a.variants[0], qty: -3 }]);
  assert.equal(negative.status, 400);
  assert.equal(await stockOf(a.variants[0]), 5);
});

// ---------- checkout: valores calculados só no servidor ----------

test('preço, desconto, frete e total enviados pelo navegador são ignorados', async () => {
  const product = await createProduct({ price: 120 });
  const result = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1, price: 0.01, listPrice: 0.01 }], {
    subtotal: 0.01, discount: 500, shipping: -10, total: 0.01,
    deliveryMethod: 'Entrega',
    address: { cep: '30000-000', rua: 'Rua Teste', numero: '1', bairro: 'Centro', cidade: 'Belo Horizonte', estado: 'MG' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.subtotal, 120);
  assert.equal(result.data.discount, 0);
  assert.equal(result.data.shipping, 15, 'frete da regra padrão do banco');
  assert.equal(result.data.total, 135);
  const { rows: [row] } = await pool.query('SELECT subtotal, discount, shipping, total FROM orders WHERE id = $1', [result.data.orderId]);
  assert.deepEqual([row.subtotal, row.discount, row.shipping, row.total].map(Number), [120, 0, 15, 135]);
});

test('frete grátis a partir do valor configurado e promoção vigente aplicada pelo servidor', async () => {
  const product = await createProduct({ price: 250, sizes: ['P', 'M'] });
  const promoId = `promo-audit-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const address = { cep: '30000000', rua: 'Rua Teste', numero: '1', bairro: 'Centro', cidade: 'BH', estado: 'MG' };
    const free = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 2 }], { deliveryMethod: 'Entrega', address });
    assert.equal(free.status, 201, JSON.stringify(free.data));
    assert.equal(free.data.subtotal, 500);
    assert.equal(free.data.shipping, 0, 'subtotal >= 499 não paga frete');
    // 2 peças: desconto progressivo de 20% (maior que qualquer outro aplicável)
    assert.equal(free.data.discount, 100);
    assert.equal(free.data.total, 400);

    await pool.query(`INSERT INTO promotions (id, scope, target_product_id, discount_type, discount_value, active) VALUES ($1,'product',$2,'percent',10,true)`, [promoId, product.id]);
    const promo = await placeOrder([{ id: product.id, variantId: product.variants[1], qty: 1 }]);
    assert.equal(promo.status, 201, JSON.stringify(promo.data));
    assert.equal(promo.data.items[0].price, 225);
    assert.equal(promo.data.items[0].listPrice, 250);
    assert.equal(promo.data.total, 225);
  } finally {
    await pool.query('DELETE FROM promotions WHERE id = $1', [promoId]);
  }
});

test('cupom expirado, agendado ou inativo não dá desconto; cupom de valor fixo nunca deixa total negativo', async () => {
  const product = await createProduct({ price: 40, stock: 20 });
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  const coupons = {
    expired: [`EXP${suffix}`, "'percent'", 50, "'2020-01-01'", 'true'],
    future: [`FUT${suffix}`, "'percent'", 50, 'NULL', 'true', "'2099-01-01'"],
    inactive: [`OFF${suffix}`, "'percent'", 50, 'NULL', 'false'],
    huge: [`BIG${suffix}`, "'fixed'", 1000, 'NULL', 'true'],
  };
  for (const [code, type, value, endDate, active, startDate = 'NULL'] of Object.values(coupons)) {
    await pool.query(`INSERT INTO coupons (code, discount_type, discount_value, end_date, active, start_date) VALUES ($1, ${type}, $2, ${endDate}, ${active}, ${startDate})`, [code, value]);
    created.coupons.push(code);
  }
  for (const key of ['expired', 'future', 'inactive']) {
    const result = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }], { couponCode: coupons[key][0] });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.discount, 0, `cupom ${key} não pode valer`);
    assert.equal(result.data.total, 40);
  }
  const huge = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }], { couponCode: coupons.huge[0] });
  assert.equal(huge.status, 201);
  assert.equal(huge.data.discount, 40);
  assert.equal(huge.data.total, 0);
});

// ---------- pedidos: ciclo de vida e estoque ----------

test('cancelar duas vezes devolve o estoque uma vez só; reativar reserva de novo', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ stock: 5 });
  const order = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 2 }]);
  assert.equal(order.status, 201);
  assert.equal(await stockOf(product.variants[0]), 3);

  for (let i = 0; i < 2; i += 1) {
    const cancel = await api('/api/orders/status', { adminToken: owner.token, id: order.data.orderId, status: 'cancelado' });
    assert.equal(cancel.status, 200);
  }
  assert.equal(await stockOf(product.variants[0]), 5);

  const reopen = await api('/api/orders/status', { adminToken: owner.token, id: order.data.orderId, status: 'em_andamento' });
  assert.equal(reopen.status, 200);
  assert.equal(await stockOf(product.variants[0]), 3);

  const { rows } = await pool.query(
    'SELECT movement_type AS type, quantity FROM inventory_movements WHERE order_id = $1 ORDER BY id', [order.data.orderId]);
  assert.deepEqual(rows.map((r) => `${r.type}:${r.quantity}`), ['sale:-2', 'cancellation:2', 'sale:-2']);
});

test('reativar pedido cancelado sem estoque suficiente é recusado sem mexer em nada', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ stock: 2 });
  const order = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 2 }]);
  await api('/api/orders/status', { adminToken: owner.token, id: order.data.orderId, status: 'cancelado' });
  await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }]);
  const reopen = await api('/api/orders/status', { adminToken: owner.token, id: order.data.orderId, status: 'novo' });
  assert.equal(reopen.status, 409);
  assert.equal(await stockOf(product.variants[0]), 1);
  const { rows: [row] } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.data.orderId]);
  assert.equal(row.status, 'cancelado');
});

test('status de pedido inválido é recusado', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct();
  const order = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }]);
  const invalid = await api('/api/orders/status', { adminToken: owner.token, id: order.data.orderId, status: 'pago' });
  assert.equal(invalid.status, 400);
  const missing = await api('/api/orders/status', { adminToken: owner.token, id: 'pedido-nao-existe', status: 'novo' });
  assert.equal(missing.status, 404);
});

// ---------- painel: produto, estoque e permissões ----------

test('preço negativo, zero ou não numérico é recusado; vazio continua sendo "sob consulta"', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ price: 80 });
  const base = { adminToken: owner.token, id: product.id, name: 'Peça de Auditoria', category: (await pool.query('SELECT name FROM categories ORDER BY id LIMIT 1')).rows[0].name, desc: 'teste' };
  for (const price of [-50, 0, 'abc', 'Infinity', 1e12]) {
    const result = await api('/api/products/update', { ...base, price });
    assert.equal(result.status, 400, `preço ${price}: ${JSON.stringify(result.data)}`);
    assert.match(result.data.error, /preço/i);
  }
  assert.equal(Number((await pool.query('SELECT price FROM products WHERE id = $1', [product.id])).rows[0].price), 80);

  const consult = await api('/api/products/update', { ...base, price: '' });
  assert.equal(consult.status, 200);
  assert.equal((await pool.query('SELECT price FROM products WHERE id = $1', [product.id])).rows[0].price, null);

  const valid = await api('/api/products/update', { ...base, price: '149.905' });
  assert.equal(valid.status, 200);
  assert.equal(Number((await pool.query('SELECT price FROM products WHERE id = $1', [product.id])).rows[0].price), 149.91);
});

test('preço e estoque alterados no painel aparecem na vitrine, na página e no dado estruturado', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ price: 100, sizes: ['P', 'M'], stock: 3 });
  const category = (await pool.query('SELECT name FROM categories ORDER BY id LIMIT 1')).rows[0].name;
  const update = await api('/api/products/update', { adminToken: owner.token, id: product.id, name: 'Blusa Atualizada', category, desc: 'Nova descrição', price: 89.9 });
  assert.equal(update.status, 200);
  const stock = await api('/api/products/variants/update', { adminToken: owner.token, id: product.variants[1], size: 'M', stock: 0, expectedStock: 3 });
  assert.equal(stock.status, 200);

  const data = await (await fetch(`${origin}/api/data`)).json();
  const shown = data.products.find((p) => p.id === product.id);
  assert.equal(shown.name, 'Blusa Atualizada');
  assert.equal(shown.price, 89.9);
  assert.deepEqual(shown.variants.map((v) => [v.size, v.stock]), [['P', 3], ['M', 0]]);
  assert.equal(shown.totalStock, 3);

  const html = await (await fetch(`${origin}/produto/${product.id}`)).text();
  assert.match(html, /<title>Blusa Atualizada — By NaNa<\/title>/);
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
  assert.equal(jsonLd.offers.price, '89.90');
  assert.equal(jsonLd.offers.availability, 'https://schema.org/InStock');

  await api('/api/products/variants/update', { adminToken: owner.token, id: product.variants[0], size: 'P', stock: 0, expectedStock: 3 });
  const soldOut = JSON.parse((await (await fetch(`${origin}/produto/${product.id}`)).text()).match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
  assert.equal(soldOut.offers.availability, 'https://schema.org/OutOfStock');
});

test('excluir produto com venda registrada orienta a ocultar; sem histórico, exclui', async () => {
  const owner = await createAdmin('owner');
  const sold = await createProduct({ stock: 3 });
  assert.equal((await placeOrder([{ id: sold.id, variantId: sold.variants[0], qty: 1 }])).status, 201);
  const blocked = await api('/api/products', { adminToken: owner.token, id: sold.id }, 'DELETE');
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /Oculte/);
  assert.equal((await pool.query('SELECT 1 FROM products WHERE id = $1', [sold.id])).rowCount, 1);

  const fresh = await createProduct({ stock: 0 });
  const removed = await api('/api/products', { adminToken: owner.token, id: fresh.id }, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await pool.query('SELECT 1 FROM products WHERE id = $1', [fresh.id])).rowCount, 0);
});

test('estoque acima do limite é recusado com mensagem clara, sem erro 500', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ stock: 1 });
  const update = await api('/api/products/variants/update', { adminToken: owner.token, id: product.variants[0], size: 'P', stock: 1e12 });
  assert.equal(update.status, 400);
  const create = await api('/api/products/variants', { adminToken: owner.token, productId: product.id, size: 'GG', stock: 1e9 });
  assert.equal(create.status, 400);
  const orphan = await api('/api/products/variants', { adminToken: owner.token, productId: 'produto-inexistente', size: 'GG', stock: 1 });
  assert.equal(orphan.status, 404);
  assert.equal(await stockOf(product.variants[0]), 1);
});

test('ajuste de estoque com valor desatualizado é recusado (venda aconteceu com o painel aberto)', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ stock: 5 });
  await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }]);
  const stale = await api('/api/products/variants/update', { adminToken: owner.token, id: product.variants[0], size: 'P', stock: 5, expectedStock: 5 });
  assert.equal(stale.status, 409);
  assert.equal(await stockOf(product.variants[0]), 4, 'a venda não pode ser apagada pelo ajuste');
});

test('staff não gerencia usuários; o único owner não pode se rebaixar nem se desativar', async () => {
  const staff = await createAdmin('staff');
  const createUser = await api('/api/admin/users', { adminToken: staff.token, name: 'X', email: `x-${Date.now()}@example.com`, password: 'senhaLonga123', role: 'owner' });
  assert.equal(createUser.status, 403);
  const promote = await api('/api/admin/users/update', { adminToken: staff.token, id: staff.id, role: 'owner' });
  assert.equal(promote.status, 403);

  const owner = await createAdmin('owner');
  // isola o cenário "único owner": os demais owners do banco de teste viram staff durante o teste
  const { rows: others } = await pool.query("UPDATE admin_users SET role = 'staff' WHERE role = 'owner' AND id <> $1 RETURNING id", [owner.id]);
  try {
    const demote = await api('/api/admin/users/update', { adminToken: owner.token, id: owner.id, role: 'staff', active: true });
    assert.equal(demote.status, 409, JSON.stringify(demote.data));
    assert.equal((await pool.query('SELECT role FROM admin_users WHERE id = $1', [owner.id])).rows[0].role, 'owner');

    const second = await createAdmin('owner');
    const demoteNow = await api('/api/admin/users/update', { adminToken: owner.token, id: second.id, role: 'staff', active: true });
    assert.equal(demoteNow.status, 200, 'rebaixar outro owner é permitido quando sobra um');
  } finally {
    if (others.length) await pool.query("UPDATE admin_users SET role = 'owner' WHERE id = ANY($1)", [others.map((r) => r.id)]);
  }
});

test('token de cliente não abre rotas do painel', async () => {
  const email = `cliente-painel-${Date.now()}@example.com`;
  created.customersByEmail.push(email);
  const signup = await api('/api/customers', { firstName: 'A', lastName: 'B', email, phone: '31999990000', password: 'senhaLonga123', privacyAccepted: true });
  assert.equal(signup.status, 201);
  for (const route of ['/api/orders/list', '/api/customers/list', '/api/admin/dashboard']) {
    const result = await api(route, { adminToken: signup.data.token, token: signup.data.token });
    assert.equal(result.status, 401, route);
  }
  // token adulterado (troca do id no payload) também não vale como cliente
  const [payload, sig] = signup.data.token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), id: crypto.randomUUID() })).toString('base64url');
  const session = await api('/api/customers/session', { token: `${forged}.${sig}` });
  assert.equal(session.status, 401);
});

test('cadastro simultâneo com o mesmo e-mail cria uma conta só, sem erro 500', async () => {
  const email = `duplo-clique-${Date.now()}@example.com`;
  created.customersByEmail.push(email);
  const results = await Promise.all(Array.from({ length: 6 }, () => api('/api/customers', {
    firstName: 'A', lastName: 'B', email, phone: '31999990000', password: 'senhaLonga123', privacyAccepted: true,
  })));
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1, statuses.join(','));
  assert.ok(statuses.every((s) => s === 201 || s === 409 || s === 429), statuses.join(','));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE lower(email) = $1', [email])).rows[0].n, 1);
});

// ---------- carrinho abandonado ----------

test('lembrete de carrinho usa nome e preço do catálogo, nunca o texto enviado pelo navegador', async () => {
  const product = await createProduct({ price: 90 });
  const email = `carrinho-${Date.now()}@example.com`;
  created.carts.push(email);
  const injected = await api('/api/cart-activity', {
    email,
    name: 'Sua conta foi bloqueada acesse http://golpe.example',
    items: [{ id: product.id, qty: 2, name: 'Clique em http://golpe.example' }, { qty: 1, name: 'sem id' }],
    subtotal: 0.01,
  });
  assert.equal(injected.status, 201);
  const { rows: [row] } = await pool.query('SELECT customer_name AS name, items, subtotal FROM abandoned_carts WHERE contact_email = $1', [email]);
  assert.equal(row.name, 'Sua');
  assert.deepEqual(row.items, [{ id: product.id, qty: 2, name: `Peça de Auditoria ${product.id}` }]);
  assert.equal(Number(row.subtotal), 180);

  const onlyText = await api('/api/cart-activity', { email: `so-texto-${Date.now()}@example.com`, items: [{ qty: 1, name: 'qualquer coisa' }], subtotal: 10 });
  assert.equal(onlyText.status, 400);
});

// ---------- itens recomendados da auditoria: idempotência, limite de cupom, pagamento ----------

test('reenvio do mesmo pedido (mesma chave) devolve o pedido já gravado e não baixa o estoque de novo', async () => {
  const product = await createProduct({ stock: 10 });
  const line = [{ id: product.id, variantId: product.variants[0], qty: 2 }];
  const phone = '31977776666';
  const key = crypto.randomUUID();

  const first = await placeOrder(line, { customerPhone: phone, idempotencyKey: key });
  assert.equal(first.status, 201);
  const again = await placeOrder(line, { customerPhone: phone, idempotencyKey: key });
  assert.equal(again.status, 200);
  assert.equal(again.data.orderId, first.data.orderId);
  assert.equal(again.data.total, first.data.total);
  assert.equal(await stockOf(product.variants[0]), 8);

  // a chave não serve pra ler o pedido de outra pessoa
  const otherPhone = await placeOrder(line, { customerPhone: '31955554444', idempotencyKey: key });
  assert.equal(otherPhone.status, 409);
  assert.equal(otherPhone.data.items, undefined);

  // envios simultâneos da mesma chave: um pedido só
  const raceKey = crypto.randomUUID();
  const race = await Promise.all(Array.from({ length: 6 }, () => placeOrder(line, { customerPhone: phone, idempotencyKey: raceKey })));
  const ids = new Set(race.map((r) => r.data && r.data.orderId));
  assert.equal(ids.size, 1, race.map((r) => r.status).join(','));
  assert.ok(race.every((r) => r.status === 201 || r.status === 200), race.map((r) => r.status).join(','));
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders WHERE idempotency_key = $1', [raceKey]);
  assert.equal(rows[0].n, 1);
  assert.equal(await stockOf(product.variants[0]), 6);

  // sem chave (ou chave malformada) continua criando pedidos independentes
  const loose = await placeOrder(line, { customerPhone: phone, idempotencyKey: 'curta' });
  assert.equal(loose.status, 201);
  assert.notEqual(loose.data.orderId, first.data.orderId);
});

test('cupom com limite de usos: pedidos simultâneos não passam do limite e o cupom esgotado é recusado', async () => {
  const product = await createProduct({ stock: 50, price: 100 });
  const code = `LIMITE${crypto.randomInt(1e6)}`;
  await pool.query("INSERT INTO coupons (code, discount_type, discount_value, max_uses) VALUES ($1, 'percent', 10, 2)", [code]);
  created.coupons.push(code);

  const valid = await api('/api/coupons/validate', { code });
  assert.equal(valid.status, 200);

  const line = [{ id: product.id, variantId: product.variants[0], qty: 1 }];
  const results = await Promise.all(Array.from({ length: 6 }, () => placeOrder(line, { couponCode: code })));
  assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join(','));
  const withCoupon = results.filter((r) => r.data.discount === 10);
  const without = results.filter((r) => r.data.discount === 0);
  assert.equal(withCoupon.length, 2);
  assert.equal(without.length, 4);
  assert.ok(without.every((r) => r.data.total === 100));
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders WHERE coupon_code = $1', [code]);
  assert.equal(rows[0].n, 2);

  const exhausted = await api('/api/coupons/validate', { code });
  assert.equal(exhausted.status, 404);
  assert.match(exhausted.data.error, /limite de usos/);

  // cancelar um pedido que usou o cupom devolve o uso
  const owner = await createAdmin('owner');
  const cancel = await api('/api/orders/status', { adminToken: owner.token, id: withCoupon[0].data.orderId, status: 'cancelado' });
  assert.equal(cancel.status, 200);
  assert.equal((await api('/api/coupons/validate', { code })).status, 200);

  // painel: lista todos os cupons (não só o de boas-vindas) com a contagem de usos
  const list = await api('/api/admin/coupons/list', { adminToken: owner.token });
  assert.equal(list.status, 200);
  const listed = list.data.coupons.find((c) => c.code === code);
  assert.equal(listed.maxUses, 2);
  assert.equal(listed.uses, 1);
  assert.equal((await api('/api/admin/coupons/list', {})).status, 401);

  // limite inválido é recusado; vazio = ilimitado
  const base = { adminToken: owner.token, type: 'percent', value: 5 };
  const zero = await api('/api/coupons', { ...base, code: `${code}Z`, maxUses: 0 });
  assert.equal(zero.status, 400);
  const fraction = await api('/api/coupons', { ...base, code: `${code}F`, maxUses: 1.5 });
  assert.equal(fraction.status, 400);
  const unlimited = await api('/api/coupons', { ...base, code: `${code}U`, maxUses: '' });
  assert.equal(unlimited.status, 201);
  created.coupons.push(`${code}U`);
  assert.equal(unlimited.data.coupons.find((c) => c.code === `${code}U`).maxUses, null);
  const update = await api('/api/coupons/update', { ...base, code: `${code}U`, maxUses: 7 });
  assert.equal(update.status, 200);
  assert.equal(update.data.coupons.find((c) => c.code === `${code}U`).maxUses, 7);
});

test('pedido online com pagamento não confirmado não pode ser enviado nem concluído', async () => {
  const owner = await createAdmin('owner');
  const product = await createProduct({ stock: 5 });
  const order = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }]);
  assert.equal(order.status, 201);
  const id = order.data.orderId;
  const setStatus = (status) => api('/api/orders/status', { adminToken: owner.token, id, status, trackingCode: 'BR123' });

  for (const paymentStatus of ['pending', 'failed', 'refunded']) {
    await pool.query("UPDATE orders SET payment_status = $1, status = 'novo' WHERE id = $2", [paymentStatus, id]);
    for (const status of ['enviado', 'concluido']) {
      const blocked = await setStatus(status);
      assert.equal(blocked.status, 409, `${paymentStatus} → ${status}`);
      assert.match(blocked.data.error, /pagamento/i);
    }
  }
  const { rows: [still] } = await pool.query('SELECT status, tracking_code FROM orders WHERE id = $1', [id]);
  assert.equal(still.status, 'novo');
  assert.equal(still.tracking_code, null);

  // separar a peça continua permitido enquanto o pagamento não chega
  await pool.query("UPDATE orders SET payment_status = 'pending' WHERE id = $1", [id]);
  assert.equal((await setStatus('em_andamento')).status, 200);

  await pool.query("UPDATE orders SET payment_status = 'paid' WHERE id = $1", [id]);
  assert.equal((await setStatus('enviado')).status, 200);
  assert.equal((await setStatus('concluido')).status, 200);

  // pedido combinado no WhatsApp (manual) segue o fluxo de sempre
  const manual = await placeOrder([{ id: product.id, variantId: product.variants[0], qty: 1 }]);
  assert.equal((await api('/api/orders/status', { adminToken: owner.token, id: manual.data.orderId, status: 'enviado' })).status, 200);
});

// ---------- revisão da auditoria: caminhos que estavam sem teste ----------

test('dois envios da mesma chave presos no mesmo estoque: o segundo bate no índice único e recebe o pedido do primeiro', async () => {
  const product = await createProduct({ stock: 10 });
  const line = [{ id: product.id, variantId: product.variants[0], qty: 1 }];
  const key = crypto.randomUUID();
  const phone = '31966665555';

  // segura a variação: as duas requisições passam pela checagem prévia (nenhum pedido existe
  // ainda) e ficam esperando a trava — quem chegar em segundo só pode cair no 23505
  const holder = await pool.connect();
  let results;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM product_variants WHERE id = $1 FOR UPDATE', [product.variants[0]]);
    const pending = [placeOrder(line, { customerPhone: phone, idempotencyKey: key }), placeOrder(line, { customerPhone: phone, idempotencyKey: key })];
    const deadline = Date.now() + 5000;
    for (;;) {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()"
      );
      if (rows[0].n >= 2) break;
      assert.ok(Date.now() < deadline, 'as duas requisições deveriam estar esperando a trava');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await holder.query('COMMIT');
    results = await Promise.all(pending);
  } finally {
    holder.release();
  }
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.equal(results[0].data.orderId, results[1].data.orderId);
  assert.equal(await stockOf(product.variants[0]), 9);
});

test('reenvio de pedido online devolve o mesmo link de pagamento e o mesmo rótulo de desconto', async () => {
  const product = await createProduct({ stock: 5, price: 200 });
  const line = [{ id: product.id, variantId: product.variants[0], qty: 1 }];
  const key = crypto.randomUUID();
  const phone = '31944443333';
  const first = await placeOrder(line, { customerPhone: phone, idempotencyKey: key, paymentMethod: 'Pix' });
  assert.equal(first.status, 201);
  assert.ok(first.data.discountLabel, 'pedido no Pix tem rótulo de desconto');
  // o provedor real não roda nos testes: simula o link gravado depois do COMMIT
  await pool.query('UPDATE orders SET checkout_url = $1 WHERE id = $2', ['https://example.com/pagar/abc', first.data.orderId]);

  const again = await placeOrder(line, { customerPhone: phone, idempotencyKey: key, paymentMethod: 'Pix' });
  assert.equal(again.status, 200);
  assert.equal(again.data.checkoutUrl, 'https://example.com/pagar/abc');
  assert.equal(again.data.discountLabel, first.data.discountLabel);
  assert.equal(await stockOf(product.variants[0]), 4);
});

test('token de redefinição de senha fica só com hash no banco', async () => {
  const email = `reset-${crypto.randomUUID().slice(0, 8)}@example.com`;
  created.customersByEmail.push(email);
  const signup = await api('/api/customers', {
    firstName: 'Teste', lastName: 'Reset', email, phone: '31922221111', password: 'senhaAntiga123', privacyAccepted: true,
  });
  assert.equal(signup.status, 201);

  const forgot = await api('/api/customers/forgot-password', { email });
  assert.equal(forgot.status, 200);
  const { rows: [stored] } = await pool.query('SELECT reset_token FROM customers WHERE lower(email) = $1', [email]);
  assert.match(stored.reset_token, /^[0-9a-f]{64}$/);
  // quem lê o banco não consegue usar o valor guardado como link
  const leaked = await api('/api/customers/reset-password', { token: stored.reset_token, newPassword: 'senhaInvasor123' });
  assert.equal(leaked.status, 400);

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('UPDATE customers SET reset_token = $1 WHERE lower(email) = $2',
    [crypto.createHash('sha256').update(token).digest('hex'), email]);
  const reset = await api('/api/customers/reset-password', { token, newPassword: 'senhaNova12345' });
  assert.equal(reset.status, 200);
  const login = await api('/api/customers/login', { email, password: 'senhaNova12345' });
  assert.equal(login.status, 200);
  // link de uso único
  assert.equal((await api('/api/customers/reset-password', { token, newPassword: 'outraSenha123' })).status, 400);
});

test('/api/data sai comprimido quando o navegador aceita gzip', async () => {
  const response = await fetch(`${origin}/api/data`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.ok(Array.isArray(data.products));
});

test('dois owners rebaixando um ao outro ao mesmo tempo não deixam a loja sem owner', async () => {
  const a = await createAdmin('owner');
  const b = await createAdmin('owner');
  // durante o teste, a e b são os únicos owners ativos (os demais voltam no finally)
  const { rows: others } = await pool.query(
    "SELECT id FROM admin_users WHERE role = 'owner' AND active AND id <> ALL($1)", [[a.id, b.id]]);
  const otherIds = others.map((r) => r.id);
  await pool.query('UPDATE admin_users SET active = false WHERE id = ANY($1)', [otherIds]);
  try {
    for (let round = 0; round < 5; round += 1) {
      await pool.query("UPDATE admin_users SET role = 'owner', active = true WHERE id = ANY($1)", [[a.id, b.id]]);
      const [r1, r2] = await Promise.all([
        api('/api/admin/users/update', { adminToken: a.token, id: b.id, role: 'staff', active: true }),
        api('/api/admin/users/update', { adminToken: b.token, id: a.id, role: 'staff', active: true }),
      ]);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM admin_users WHERE role = 'owner' AND active AND id = ANY($1)", [[a.id, b.id]]);
      assert.equal(rows[0].n, 1, `rodada ${round}: ${r1.status}/${r2.status}`);
      assert.deepEqual([r1.status, r2.status].sort(), [200, 409], `rodada ${round}`);
    }
  } finally {
    await pool.query('UPDATE admin_users SET active = true WHERE id = ANY($1)', [otherIds]);
  }
});

test('alerta de erro: banco fora do ar gera um e-mail só, mesmo com várias falhas seguidas', async () => {
  const alertPort = 18792;
  const output = [];
  const broken = spawn(process.execPath, ['serve.js'], {
    cwd: projectRoot,
    env: {
      ...process.env, PORT: String(alertPort), HOST: '127.0.0.1',
      DATABASE_URL: 'postgresql://ninguem:nada@127.0.0.1:1/inexistente',
      ALERT_EMAIL: 'alerta-teste@example.com', RESEND_API_KEY: '', EMAIL_FROM: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  broken.stdout.on('data', (chunk) => output.push(chunk.toString()));
  broken.stderr.on('data', (chunk) => output.push(chunk.toString()));
  try {
    const deadline = Date.now() + 10_000;
    const statuses = [];
    while (Date.now() < deadline && statuses.length < 4) {
      try {
        statuses.push((await fetch(`http://127.0.0.1:${alertPort}/api/health`)).status);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.deepEqual(statuses, [503, 503, 503, 503]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const attempts = output.join('').split('\n').filter((l) => l.includes('alerta-teste@example.com'));
    // sem Resend configurado o envio é só registrado no log (nenhuma mensagem sai de verdade)
    assert.equal(attempts.length, 1, attempts.join('\n'));
  } finally {
    broken.kill();
  }
});
