// Fase 1 — segurança financeira e PagBank (RELATORIO_IMPLEMENTACAO_ECOMMERCE.md).
// Testes de integração do fluxo de pagamento online contra um PagBank SIMULADO local (servidor
// HTTP neste arquivo). Nenhuma chamada sai da máquina: o servidor sobe com NODE_ENV=test e
// PAGSEGURO_API_BASE_URL apontando para o simulado — em teste, sem essa variável, o provedor
// recusa qualquer chamada (ver payment-providers/pagseguro.js). Banco: só PostgreSQL local
// (require-local-db), com produtos, pedidos e admins descartáveis apagados no fim.
//
// O simulado segue o formato confirmado na documentação oficial (POST /checkouts,
// GET /checkouts/{id}, GET /orders/{id}, GET /orders?charge_id=, POST /charges/{id}/cancel,
// erros em error_messages[], estorno com 201 e amount.summary.refunded). Isso NÃO substitui a
// homologação no sandbox do PagBank, que segue pendente.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
require('./require-local-db');

const projectRoot = path.resolve(__dirname, '..');
const port = 18793;
const sweepPort = 18794;
const origin = `http://127.0.0.1:${port}`;
const TOKEN = 'token-ficticio-pagamentos';
const ONLINE = 'Pagamento online (Pix/cartão)';
let server;
let sweepServer;
let pool;
let mockServer;
let mockUrl;
const serverLogs = [];

// ---------------------------------------------------------------- PagBank simulado
const mock = {
  checkouts: new Map(), // CHEC_ -> checkout
  orders: new Map(), // ORDE_ -> pedido PagBank
  byReference: new Map(), // nosso pedido -> ORDE_
  calls: [],
  idempotent: new Map(), // chave -> { status, body }
  refundMode: new Map(), // charge -> modo
  down: new Set(), // ids (CHEC_/ORDE_) cuja consulta responde 500
  pendingRefunds: new Map(), // charge -> valor aceito e ainda não liquidado (modo async)
  seq: 0,
};
const nextId = (prefix) => `${prefix}_${String(++mock.seq).padStart(6, '0')}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const cents = (reais) => Math.round(Number(reais) * 100);

function chargeFor(orderObj, chargeId) {
  return (orderObj.charges || []).find((c) => c.id === chargeId);
}
function orderOfCharge(chargeId) {
  for (const o of mock.orders.values()) if (chargeFor(o, chargeId)) return o;
  return null;
}
function sendMock(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
const pagbankError = (code, description, parameter = '') => ({ error_messages: [{ code, description, parameter_name: parameter }] });

function applyRefund(chargeId, value) {
  const o = orderOfCharge(chargeId);
  const c = chargeFor(o, chargeId);
  c.amount.summary.refunded += value;
  c.status = c.amount.summary.refunded >= c.amount.summary.paid ? 'CANCELED' : 'PAID';
  return c;
}

async function handleMock(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://mock');
  const call = { method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: raw ? JSON.parse(raw) : null };
  mock.calls.push(call);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return sendMock(res, 401, pagbankError('UNAUTHORIZED', 'invalid_authorization_header'));

  if (req.method === 'POST' && url.pathname === '/checkouts') {
    const id = nextId('CHEC');
    const checkout = {
      id, reference_id: call.body.reference_id, status: 'ACTIVE', expiration_date: call.body.expiration_date,
      items: call.body.items, links: [{ rel: 'PAY', href: `https://pagamento.simulado/${id}`, method: 'GET' }],
    };
    mock.checkouts.set(id, checkout);
    return sendMock(res, 201, checkout);
  }
  let m = url.pathname.match(/^\/checkouts\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    if (mock.down.has(m[1])) return sendMock(res, 500, {});
    const checkout = mock.checkouts.get(m[1]);
    return checkout ? sendMock(res, 200, checkout) : sendMock(res, 404, pagbankError('checkout_not_found', 'checkout_not_found'));
  }
  m = url.pathname.match(/^\/orders\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    if (mock.down.has(m[1])) return sendMock(res, 500, {});
    const o = mock.orders.get(m[1]);
    return o ? sendMock(res, 200, o) : sendMock(res, 404, pagbankError('40002', 'not_found'));
  }
  if (req.method === 'GET' && url.pathname === '/orders') {
    const o = orderOfCharge(url.searchParams.get('charge_id'));
    return sendMock(res, 200, { orders: o ? [o] : [] });
  }
  m = url.pathname.match(/^\/charges\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && m) {
    const chargeId = m[1];
    const key = req.headers['x-idempotency-key'];
    if (key && mock.idempotent.has(key)) {
      const prev = mock.idempotent.get(key);
      return sendMock(res, prev.status, prev.body);
    }
    const mode = mock.refundMode.get(chargeId) || 'confirm';
    const o = orderOfCharge(chargeId);
    const c = o && chargeFor(o, chargeId);
    const value = call.body && call.body.amount && call.body.amount.value;
    // Comportamento visto no sandbox real (12/11/2026): depois de uma recusa 4xx a chave fica
    // "em uso" e reenviá-la devolve 409 40005 idempotency_key_in_use.
    const refuse = (code, error) => {
      if (key) mock.idempotent.set(key, { status: 409, body: pagbankError('40005', 'idempotency_key_in_use') });
      return sendMock(res, 400, pagbankError(code, error));
    };
    if (mode === 'drop') return req.socket.destroy();
    if (mode === 'error500') return sendMock(res, 500, {});
    if (mode === 'not-found') return refuse('40008', 'Transaction is not found.');
    if (mode === 'reject' || !c || c.status !== 'PAID') return refuse('40016', 'charge_not_eligible');
    if (c.amount.summary.refunded + value > c.amount.summary.paid) return refuse('40007', 'unabled_refund');
    if (mode === 'timeout-noapply') return setTimeout(() => res.destroyed || sendMock(res, 504, {}), 3000);
    let body;
    if (mode === 'async') {
      mock.pendingRefunds.set(chargeId, value);
      body = JSON.parse(JSON.stringify(c));
    } else {
      body = JSON.parse(JSON.stringify(applyRefund(chargeId, value)));
    }
    if (key) mock.idempotent.set(key, { status: 201, body });
    if (mode === 'timeout-apply') {
      mock.refundMode.delete(chargeId); // a próxima chamada com outra chave volta ao normal
      return setTimeout(() => res.destroyed || sendMock(res, 201, body), 3000);
    }
    return sendMock(res, 201, body);
  }
  return sendMock(res, 404, {});
}

// A cliente paga (ou tenta) na página do PagBank: cria/atualiza o pedido PagBank e devolve o
// payload da notificação transacional.
function customerPays(orderId, total, chargeStatus) {
  let ordeId = mock.byReference.get(orderId);
  if (!ordeId) {
    ordeId = nextId('ORDE');
    mock.byReference.set(orderId, ordeId);
    mock.orders.set(ordeId, { id: ordeId, reference_id: orderId, charges: [] });
  }
  const o = mock.orders.get(ordeId);
  const value = cents(total);
  o.charges.push({
    id: nextId('CHAR'), reference_id: orderId, status: chargeStatus,
    amount: { value, currency: 'BRL', summary: { total: value, paid: chargeStatus === 'PAID' ? value : 0, refunded: 0 } },
  });
  return JSON.parse(JSON.stringify(o));
}
const pagbankOrderOf = (orderId) => JSON.parse(JSON.stringify(mock.orders.get(mock.byReference.get(orderId))));
const capturedCharge = (orderId) => mock.orders.get(mock.byReference.get(orderId)).charges.find((c) => c.amount.summary.paid > 0);
const cancelCalls = (chargeId) => mock.calls.filter((c) => c.method === 'POST' && c.path === `/charges/${chargeId}/cancel`);

// ---------------------------------------------------------------- helpers da loja
let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}, 198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};
async function api(route, body, base = origin) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}
async function sendWebhook(payload, { signature, raw } = {}) {
  const body = raw || JSON.stringify(payload);
  const sig = signature !== undefined ? signature : crypto.createHash('sha256').update(`${TOKEN}-${body}`).digest('hex');
  const response = await fetch(`${origin}/api/webhooks/pagseguro`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-authenticity-token': sig }, body,
  });
  return response.status;
}

function hashPasswordForTest(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
const created = { products: [], admins: [], orders: [] };

let owner;
async function createAdmin(role) {
  const id = crypto.randomUUID();
  const email = `pagamentos-${role}-${id.slice(0, 8)}@example.com`;
  await pool.query('INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
    [id, `Pagamentos ${role}`, email, hashPasswordForTest('senhaPagamentos123'), role]);
  created.admins.push(id);
  const { data } = await api('/api/admin/login', { email, password: 'senhaPagamentos123' });
  assert.ok(data && data.token, 'login do admin de teste');
  return { id, token: data.token };
}

async function createProduct(stocks = [5], price = 100) {
  const id = `pag-${crypto.randomUUID().slice(0, 12)}`;
  const { rows: [category] } = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1');
  await pool.query(
    "INSERT INTO products (id, name, category_id, price, img, description) VALUES ($1,$2,$3,$4,'assets/img/processed/logo.png','teste')",
    [id, `Peça Pagamentos ${id}`, category.id, price]
  );
  created.products.push(id);
  const variants = [];
  for (const [position, stock] of stocks.entries()) {
    const variantId = `${id}-v-${position}`;
    await pool.query('INSERT INTO product_variants (id, product_id, size, stock, position) VALUES ($1,$2,$3,$4,$5)',
      [variantId, id, ['P', 'M', 'G'][position] || `T${position}`, stock, position]);
    variants.push(variantId);
  }
  return { id, variants };
}

// Pedido com pagamento online de verdade: o servidor cria o checkout no PagBank simulado.
async function placeOnlineOrder(product, lines = [{ variant: 0, qty: 1 }]) {
  const result = await api('/api/orders', {
    customerName: 'Cliente Pagamentos',
    customerPhone: `319${String(crypto.randomInt(1e8)).padStart(8, '0')}`,
    customerEmail: 'cliente-pagamentos@example.com',
    paymentMethod: ONLINE,
    deliveryMethod: 'Retirada em loja',
    items: lines.map((l) => ({ id: product.id, variantId: product.variants[l.variant], qty: l.qty })),
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  created.orders.push(result.data.orderId);
  assert.match(result.data.checkoutUrl || '', /pagamento\.simulado/, 'pedido online recebeu o link do PagBank simulado');
  const row = await orderRow(result.data.orderId);
  return { id: result.data.orderId, total: Number(row.total), checkoutId: row.checkoutId };
}

const stockOf = async (variantId) => (await pool.query('SELECT stock FROM product_variants WHERE id = $1', [variantId])).rows[0].stock;
const orderRow = async (id) => (await pool.query(
  `SELECT status, payment_status AS "paymentStatus", total, paid_amount AS "paidAmount", refunded_amount AS "refundedAmount",
          payment_reference AS "checkoutId", payment_order_id AS "providerOrderId", payment_charge_id AS "chargeId",
          payment_attention AS "attention", payment_check_failures AS "checkFailures", payment_checked_at AS "checkedAt", paid_at AS "paidAt"
     FROM orders WHERE id = $1`, [id])).rows[0];
const eventsOf = async (id) => (await pool.query(
  'SELECT event_type AS type, from_status AS "fromStatus", to_status AS "toStatus", from_payment_status AS "fromPayment", to_payment_status AS "toPayment", source, admin_user_id AS "adminId", reason, metadata FROM order_events WHERE order_id = $1 ORDER BY id', [id])).rows;
const eventTypes = async (id) => (await eventsOf(id)).map((e) => e.type);
const count = (list, type) => list.filter((t) => t === type).length;
const movementsOf = async (id) => (await pool.query(
  'SELECT movement_type AS type, quantity FROM inventory_movements WHERE order_id = $1 ORDER BY id', [id])).rows;
const refundsOf = async (id) => (await pool.query(
  'SELECT status, amount, attempts, idempotency_key AS key FROM payment_refunds WHERE order_id = $1 ORDER BY created_at', [id])).rows;
const finance = (action, id, extra = {}) => api(`/api/orders/payment/${action}`, { adminToken: owner.token, id, ...extra });
const setStatus = (id, status, extra = {}) => api('/api/orders/status', { adminToken: owner.token, id, status, trackingCode: 'BR1', ...extra });

async function paidOrder(stocks = [5]) {
  const product = await createProduct(stocks);
  const order = await placeOnlineOrder(product);
  assert.equal(await sendWebhook(customerPays(order.id, order.total, 'PAID')), 200);
  assert.equal((await orderRow(order.id)).paymentStatus, 'paid');
  return { product, order, charge: capturedCharge(order.id) };
}

async function waitFor(fn, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Tempo esgotado esperando: ${label}`);
}

function startServer(serverPort, extraEnv) {
  const child = spawn(process.execPath, ['serve.js'], {
    cwd: projectRoot,
    env: {
      ...process.env, PORT: String(serverPort), HOST: '127.0.0.1', NODE_ENV: 'test',
      PAYMENT_PROVIDER: 'pagseguro', PAGSEGURO_TOKEN: TOKEN, PAGSEGURO_SANDBOX: 'true',
      PAGSEGURO_API_BASE_URL: mockUrl, PAGSEGURO_TIMEOUT_MS: '1500',
      SITE_URL: '', RESEND_API_KEY: '', EMAIL_FROM: '', STORE_NOTIFY_EMAIL: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => serverLogs.push(String(d)));
  child.stderr.on('data', (d) => serverLogs.push(String(d)));
  return child;
}
async function waitForServer(base) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`O servidor de teste ${base} não iniciou a tempo`);
}

test.before(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  mockServer = http.createServer((req, res) => {
    handleMock(req, res).catch((err) => { if (!res.headersSent) sendMock(res, 500, { error: err.message }); });
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${mockServer.address().port}`;
  // servidor principal: varredura praticamente desligada (os testes chamam as ações direto)
  server = startServer(port, { PAYMENT_SWEEP_INTERVAL_MS: String(60 * 60 * 1000) });
  // segundo servidor só para exercitar a varredura automática (B-04) em intervalo curto
  sweepServer = startServer(sweepPort, { PAYMENT_SWEEP_INTERVAL_MS: '400' });
  await waitForServer(origin);
  await waitForServer(`http://127.0.0.1:${sweepPort}`);
  owner = await createAdmin('owner');
});

test.after(async () => {
  for (const child of [server, sweepServer]) if (child && !child.killed) child.kill();
  await new Promise((resolve) => mockServer.close(resolve));
  try {
    if (created.orders.length) {
      await pool.query('DELETE FROM inventory_movements WHERE order_id = ANY($1)', [created.orders]);
      await pool.query('DELETE FROM orders WHERE id = ANY($1)', [created.orders]); // histórico e estornos vão junto (CASCADE)
    }
    if (created.products.length) {
      await pool.query('DELETE FROM inventory_movements WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = ANY($1))', [created.products]);
      await pool.query('DELETE FROM products WHERE id = ANY($1)', [created.products]);
    }
    if (created.admins.length) {
      await pool.query('DELETE FROM admin_activity_log WHERE admin_user_id = ANY($1)', [created.admins]);
      await pool.query('DELETE FROM admin_users WHERE id = ANY($1)', [created.admins]);
    }
  } finally {
    await pool.end();
  }
});

// ================================================================ isolamento

test('isolamento: banco local, PagBank simulado e nenhuma chamada a host real', async () => {
  const host = new URL(process.env.DATABASE_URL).hostname;
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(host), `banco de teste não é local: ${host}`);
  const product = await createProduct([3]);
  const order = await placeOnlineOrder(product);
  const checkoutCall = mock.calls.find((c) => c.method === 'POST' && c.path === '/checkouts' && c.body.reference_id === order.id);
  assert.ok(checkoutCall, 'o checkout foi criado no simulado local');
  assert.equal(checkoutCall.body.items[0].unit_amount, cents(order.total));
  assert.ok(order.checkoutId.startsWith('CHEC_'));
  assert.deepEqual(await eventTypes(order.id), ['checkout_created']);

  // Em NODE_ENV=test, sem PAGSEGURO_API_BASE_URL, o provedor recusa a chamada antes de abrir conexão.
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: 'test', PAGSEGURO_TOKEN: 'x', PAGSEGURO_SANDBOX: 'true' });
    delete process.env.PAGSEGURO_API_BASE_URL;
    const provider = require('../payment-providers/pagseguro');
    await assert.rejects(provider.getPaymentStatus({ checkoutId: 'CHEC_X' }), /bloqueada em ambiente de teste/);
    await assert.rejects(provider.refund({ chargeId: 'CHAR_X', amount: 1, idempotencyKey: 'k' }), /bloqueada em ambiente de teste/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

// ================================================================ 1–8: pagamento e webhooks

test('01 pagamento aprovado: pago, valores e cobrança gravados, estoque baixado uma única vez', async () => {
  const { product, order, charge } = await paidOrder([5]);
  const row = await orderRow(order.id);
  assert.equal(row.status, 'novo');
  assert.equal(Number(row.paidAmount), order.total);
  assert.equal(row.chargeId, charge.id);
  assert.ok(row.providerOrderId.startsWith('ORDE_'));
  assert.ok(row.paidAt);
  assert.equal(await stockOf(product.variants[0]), 4);
  assert.deepEqual(await eventTypes(order.id), ['checkout_created', 'payment_approved']);
  const [, approved] = await eventsOf(order.id);
  assert.equal(approved.source, 'webhook');
  assert.equal(approved.fromPayment, 'pending');
  assert.equal(approved.toPayment, 'paid');
});

test('02 pagamento recusado: pedido continua pendente, reserva mantida e tentativa registrada (B-01)', async () => {
  const product = await createProduct([1]);
  const order = await placeOnlineOrder(product);
  assert.equal(await sendWebhook(customerPays(order.id, order.total, 'DECLINED')), 200);
  const row = await orderRow(order.id);
  assert.equal(row.status, 'novo');
  assert.equal(row.paymentStatus, 'pending');
  assert.equal(await stockOf(product.variants[0]), 0, 'a peça continua reservada para a nova tentativa');
  assert.deepEqual(await movementsOf(order.id), [{ type: 'sale', quantity: -1 }]);
  assert.equal(count(await eventTypes(order.id), 'payment_declined'), 1);
});

test('03 recusado seguido de aprovado no mesmo link: pago, sem nova baixa de estoque', async () => {
  const product = await createProduct([2]);
  const order = await placeOnlineOrder(product);
  assert.equal(await sendWebhook(customerPays(order.id, order.total, 'DECLINED')), 200);
  assert.equal(await sendWebhook(customerPays(order.id, order.total, 'PAID')), 200);
  const row = await orderRow(order.id);
  assert.equal(row.paymentStatus, 'paid');
  assert.equal(row.status, 'novo');
  assert.equal(await stockOf(product.variants[0]), 1);
  assert.equal((await movementsOf(order.id)).length, 1, 'uma única baixa');
  assert.deepEqual((await eventTypes(order.id)).slice(1), ['payment_declined', 'payment_approved']);
});

test('04 pagamento expirado: varredura consulta o PagBank e só cancela com checkout vencido (B-04)', async () => {
  const product = await createProduct([3]);
  const expired = await placeOnlineOrder(product);
  const stillOpen = await placeOnlineOrder(product);
  const paidLate = await placeOnlineOrder(product);
  assert.equal(await stockOf(product.variants[0]), 0);
  mock.checkouts.get(expired.checkoutId).status = 'EXPIRED';
  // link ainda ativo no PagBank (ex.: prazo diferente): nada é cancelado
  // terceiro: a cliente pagou mas a notificação nunca chegou — a consulta acha o pagamento
  customerPays(paidLate.id, paidLate.total, 'PAID');
  mock.checkouts.get(paidLate.checkoutId).orders = [{ id: mock.byReference.get(paidLate.id) }];
  await pool.query("UPDATE orders SET created_at = now() - interval '30 hours' WHERE id = ANY($1)", [[expired.id, stillOpen.id, paidLate.id]]);

  await waitFor(async () => (await orderRow(expired.id)).status === 'cancelado', 'varredura cancelar o pedido vencido');
  await waitFor(async () => (await orderRow(paidLate.id)).paymentStatus === 'paid', 'varredura achar o pagamento sem webhook');
  await waitFor(async () => (await orderRow(stillOpen.id)).checkedAt, 'varredura consultar o pedido ainda aberto');

  const e = await orderRow(expired.id);
  assert.equal(e.paymentStatus, 'failed');
  assert.deepEqual(await movementsOf(expired.id), [{ type: 'sale', quantity: -1 }, { type: 'cancellation', quantity: 1 }]);
  const expiredEvents = await eventsOf(expired.id);
  assert.ok(expiredEvents.some((ev) => ev.type === 'payment_checked' && ev.source === 'sweep'));
  assert.equal(count(expiredEvents.map((ev) => ev.type), 'payment_expired'), 1);

  const o = await orderRow(stillOpen.id);
  assert.equal(o.status, 'novo');
  assert.equal(o.paymentStatus, 'pending');

  const p = await orderRow(paidLate.id);
  assert.equal(p.status, 'novo', 'pago sem webhook não é cancelado');
  assert.equal(await stockOf(product.variants[0]), 1, 'só a peça do pedido vencido voltou');

  // nova consulta manual do pedido já cancelado não devolve a peça de novo
  assert.equal((await finance('refresh', expired.id)).status, 200);
  assert.equal(await stockOf(product.variants[0]), 1);
  assert.equal((await movementsOf(expired.id)).length, 2);
});

test('05 webhook duplicado: um pagamento, um evento, paid_at preservado', async () => {
  const product = await createProduct([5]);
  const order = await placeOnlineOrder(product);
  const payload = customerPays(order.id, order.total, 'PAID');
  assert.equal(await sendWebhook(payload), 200);
  const first = (await orderRow(order.id)).paidAt;
  assert.equal(await sendWebhook(payload), 200);
  assert.equal(await sendWebhook(payload), 200);
  assert.deepEqual((await orderRow(order.id)).paidAt, first);
  assert.equal(count(await eventTypes(order.id), 'payment_approved'), 1);
  assert.equal(await stockOf(product.variants[0]), 4);
});

test('06 webhook atrasado: aviso antigo de "aguardando"/recusado não despaga um pedido pago', async () => {
  const product = await createProduct([5]);
  const order = await placeOnlineOrder(product);
  const waiting = customerPays(order.id, order.total, 'WAITING');
  const stale = JSON.parse(JSON.stringify(waiting));
  mock.orders.get(mock.byReference.get(order.id)).charges[0].status = 'PAID';
  mock.orders.get(mock.byReference.get(order.id)).charges[0].amount.summary.paid = cents(order.total);
  assert.equal(await sendWebhook(pagbankOrderOf(order.id)), 200);
  assert.equal(await sendWebhook(stale), 200); // chega depois
  assert.equal(await sendWebhook({ ...stale, charges: [{ ...stale.charges[0], id: 'CHAR_ANTIGA', status: 'DECLINED' }] }), 200);
  const row = await orderRow(order.id);
  assert.equal(row.paymentStatus, 'paid');
  assert.equal(row.status, 'novo');
});

test('07 webhook fora de ordem: estorno chega antes do aviso de pago e a situação não volta atrás', async () => {
  const product = await createProduct([5]);
  const order = await placeOnlineOrder(product);
  const paid = customerPays(order.id, order.total, 'PAID');
  const refunded = JSON.parse(JSON.stringify(paid));
  refunded.charges[0].amount.summary.refunded = cents(order.total);
  refunded.charges[0].status = 'CANCELED';
  assert.equal(await sendWebhook(refunded), 200);
  assert.equal(await sendWebhook(paid), 200);
  const row = await orderRow(order.id);
  assert.equal(row.paymentStatus, 'refunded');
  assert.equal(row.status, 'cancelado', 'estorno integral antes do envio cancela');
  assert.equal(await stockOf(product.variants[0]), 5);
  assert.equal(count((await movementsOf(order.id)).map((m) => m.type), 'cancellation'), 1);
  assert.ok(!(await eventTypes(order.id)).includes('payment_approved'), 'o aviso atrasado de pago foi ignorado');
});

test('08 assinatura inválida: 401, pedido intacto e nada no histórico', async () => {
  const product = await createProduct([5]);
  const order = await placeOnlineOrder(product);
  const payload = customerPays(order.id, order.total, 'PAID');
  assert.equal(await sendWebhook(payload, { signature: 'a'.repeat(64) }), 401);
  assert.equal(await sendWebhook(payload, { signature: '' }), 401);
  // corpo alterado depois de assinado
  const raw = JSON.stringify(payload);
  const sig = crypto.createHash('sha256').update(`${TOKEN}-${raw}`).digest('hex');
  assert.equal(await sendWebhook(null, { raw: raw.replace(order.id, `${order.id} `), signature: sig }), 401);
  assert.equal((await orderRow(order.id)).paymentStatus, 'pending');
  assert.deepEqual(await eventTypes(order.id), ['checkout_created']);
});

// ================================================================ 9–17: estornos

test('09 estorno integral pelo cancelamento no painel: confirmado pelo PagBank, peça volta uma vez', async () => {
  const { product, order, charge } = await paidOrder([5]);
  const result = await setStatus(order.id, 'cancelado');
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.match(result.data.message, /confirmado/i);
  const row = await orderRow(order.id);
  assert.equal(row.status, 'cancelado');
  assert.equal(row.paymentStatus, 'refunded');
  assert.equal(Number(row.refundedAmount), order.total);
  assert.equal(await stockOf(product.variants[0]), 5);
  assert.equal(count((await movementsOf(order.id)).map((m) => m.type), 'cancellation'), 1);

  const calls = cancelCalls(charge.id);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { amount: { value: cents(order.total) } });
  const [refund] = await refundsOf(order.id);
  assert.equal(refund.status, 'confirmed');
  assert.equal(calls[0].headers['x-idempotency-key'], refund.key, 'chave de idempotência enviada ao PagBank');

  const types = await eventTypes(order.id);
  assert.deepEqual(types.slice(2), ['order_cancelled', 'refund_requested', 'refund_response', 'refund_confirmed']);
  const ev = await eventsOf(order.id);
  assert.ok(ev.find((e) => e.type === 'refund_requested').adminId, 'responsável registrado');
});

test('10 estorno parcial feito no PagBank: estorno parcial, pedido segue e pode ser enviado', async () => {
  const { product, order, charge } = await paidOrder([5]);
  applyRefund(charge.id, 3000);
  assert.equal(await sendWebhook(pagbankOrderOf(order.id)), 200);
  const row = await orderRow(order.id);
  assert.equal(row.paymentStatus, 'partially_refunded');
  assert.equal(Number(row.refundedAmount), 30);
  assert.equal(row.status, 'novo');
  assert.equal(await stockOf(product.variants[0]), 4);
  assert.equal((await setStatus(order.id, 'enviado')).status, 200, 'pagamento parcialmente estornado continua liberando o envio');
  const detail = await finance('detail', order.id);
  assert.equal(detail.data.finance.notRefundedAmount, order.total - 30);
});

test('11 estorno integral antes do envio (pedido em andamento): cancela e devolve a peça', async () => {
  const { product, order, charge } = await paidOrder([5]);
  assert.equal((await setStatus(order.id, 'em_andamento')).status, 200);
  applyRefund(charge.id, cents(order.total));
  assert.equal(await sendWebhook(pagbankOrderOf(order.id)), 200);
  const row = await orderRow(order.id);
  assert.equal(row.paymentStatus, 'refunded');
  assert.equal(row.status, 'cancelado');
  assert.equal(await stockOf(product.variants[0]), 5);
  assert.ok((await eventTypes(order.id)).includes('order_cancelled_by_refund'));
});

for (const [label, finalStatus] of [['12 estorno após envio', 'enviado'], ['13 estorno após entrega', 'concluido']]) {
  test(`${label}: só financeiro — status logístico e estoque intactos (B-02)`, async () => {
    const { product, order, charge } = await paidOrder([5]);
    for (const status of ['em_andamento', 'enviado', 'concluido']) {
      assert.equal((await setStatus(order.id, status)).status, 200);
      if (status === finalStatus) break;
    }
    applyRefund(charge.id, cents(order.total));
    assert.equal(await sendWebhook(pagbankOrderOf(order.id)), 200);
    assert.equal(await sendWebhook(pagbankOrderOf(order.id)), 200); // repetido
    const row = await orderRow(order.id);
    assert.equal(row.paymentStatus, 'refunded');
    assert.equal(row.status, finalStatus);
    assert.equal(await stockOf(product.variants[0]), 4, 'peça que saiu da loja não volta sozinha ao estoque');
    const types = await eventTypes(order.id);
    assert.equal(count(types, 'refund_confirmed'), 1);
    assert.equal(count(types, 'refund_after_shipment'), 1);
  });
}

test('14 falha de comunicação no estorno: não é sucesso, fica "estorno com falha" e não confirma nada', async () => {
  const { product, order, charge } = await paidOrder([5]);
  mock.refundMode.set(charge.id, 'drop');
  const result = await setStatus(order.id, 'cancelado');
  assert.equal(result.status, 200);
  assert.match(result.data.message, /NÃO está confirmado/);
  const row = await orderRow(order.id);
  assert.equal(row.status, 'cancelado');
  assert.equal(row.paymentStatus, 'refund_failed');
  assert.equal(row.attention, 'refund_uncertain');
  assert.equal(Number(row.refundedAmount), 0);
  assert.equal(await stockOf(product.variants[0]), 5);
  const [refund] = await refundsOf(order.id);
  assert.equal(refund.status, 'unknown');
  const types = await eventTypes(order.id);
  assert.ok(types.includes('refund_failed'));
  assert.ok(!types.includes('refund_confirmed'));
  // a equipe não consegue reativar nem enviar um pedido nessa situação
  assert.equal((await setStatus(order.id, 'novo')).status, 409);
});

test('15 consulta ao PagBank indisponível: pedido vencido NÃO é cancelado, falhas contadas e alerta', async () => {
  const product = await createProduct([1]);
  const order = await placeOnlineOrder(product);
  mock.down.add(order.checkoutId);
  for (let i = 1; i <= 3; i += 1) {
    const r = await finance('refresh', order.id);
    assert.equal(r.status, 200);
    assert.match(r.data.message, /Não foi possível consultar/);
  }
  let row = await orderRow(order.id);
  assert.equal(row.checkFailures, 3);
  assert.equal(row.attention, 'check_failing');
  // a varredura também não cancela pedido vencido sem resposta do PagBank
  await pool.query("UPDATE orders SET created_at = now() - interval '30 hours', payment_checked_at = NULL WHERE id = $1", [order.id]);
  await waitFor(async () => (await orderRow(order.id)).checkFailures >= 4, 'varredura tentar a consulta');
  row = await orderRow(order.id);
  assert.equal(row.status, 'novo');
  assert.equal(row.paymentStatus, 'pending');
  assert.equal(await stockOf(product.variants[0]), 0, 'a reserva continua');
  assert.ok(count(await eventTypes(order.id), 'payment_check_failed') >= 4);
  // PagBank volta: a consulta seguinte limpa o alerta
  mock.down.delete(order.checkoutId);
  assert.equal((await finance('refresh', order.id)).status, 200);
  row = await orderRow(order.id);
  assert.equal(row.checkFailures, 0);
  assert.equal(row.attention, null);
});

test('16 cancelamento de pedido pago com estorno assíncrono: pendente até o PagBank confirmar (DC-5)', async () => {
  const { product, order, charge } = await paidOrder([5]);
  mock.refundMode.set(charge.id, 'async');
  const result = await setStatus(order.id, 'cancelado');
  assert.match(result.data.message, /Aguardando a confirmação/);
  let row = await orderRow(order.id);
  assert.equal(row.status, 'cancelado');
  assert.equal(row.paymentStatus, 'refund_pending');
  assert.equal(Number(row.refundedAmount), 0, 'sem confirmação, nada é dado como estornado');
  assert.equal(await stockOf(product.variants[0]), 5);
  assert.ok(!(await eventTypes(order.id)).includes('refund_confirmed'));
  // a equipe não contorna o fluxo pelo status
  assert.equal((await setStatus(order.id, 'novo')).status, 409);
  assert.equal((await setStatus(order.id, 'enviado')).status, 409);
  // PagBank liquida e avisa
  applyRefund(charge.id, mock.pendingRefunds.get(charge.id));
  assert.equal(await sendWebhook(pagbankOrderOf(order.id)), 200);
  row = await orderRow(order.id);
  assert.equal(row.paymentStatus, 'refunded');
  assert.equal(Number(row.refundedAmount), order.total);
  assert.equal((await refundsOf(order.id))[0].status, 'confirmed');
  assert.equal(await stockOf(product.variants[0]), 5, 'confirmação não devolve a peça de novo');
});

test('17 tentativa duplicada de estorno: bloqueada no servidor, um único pedido ao PagBank', async () => {
  const { order, charge } = await paidOrder([5]);
  mock.refundMode.set(charge.id, 'async');
  assert.equal((await setStatus(order.id, 'cancelado')).status, 200);
  const again = await finance('refund', order.id, { reason: 'clique duplo' });
  assert.equal(again.status, 409);
  assert.equal((await finance('retry-refund', order.id)).status, 409);
  assert.equal((await setStatus(order.id, 'cancelado')).status, 200, 'mesmo status: nada muda');
  assert.equal(cancelCalls(charge.id).length, 1);
  assert.equal((await refundsOf(order.id)).length, 1);
  // sem sessão de admin, nenhuma ação financeira passa
  assert.equal((await api('/api/orders/payment/refund', { id: order.id, reason: 'x' })).status, 401);
  assert.equal((await api('/api/orders/payment/detail', { adminToken: 'token-falso', id: order.id })).status, 401);
});

// ================================================================ 18–23: concorrência, DC-4 e falhas

test('18 notificações simultâneas: um pagamento, um evento; cancelamentos simultâneos: um estorno', async () => {
  const product = await createProduct([5]);
  const order = await placeOnlineOrder(product);
  const declined = customerPays(order.id, order.total, 'DECLINED');
  const paid = customerPays(order.id, order.total, 'PAID');
  const statuses = await Promise.all([
    ...Array.from({ length: 6 }, () => sendWebhook(paid)),
    ...Array.from({ length: 3 }, () => sendWebhook(declined)),
  ]);
  assert.ok(statuses.every((s) => s === 200));
  const row = await orderRow(order.id);
  assert.equal(row.paymentStatus, 'paid');
  assert.equal(count(await eventTypes(order.id), 'payment_approved'), 1);
  assert.equal(await stockOf(product.variants[0]), 4);

  const charge = capturedCharge(order.id);
  const results = await Promise.all([setStatus(order.id, 'cancelado'), setStatus(order.id, 'cancelado'), setStatus(order.id, 'cancelado')]);
  assert.ok(results.every((r) => [200, 409].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
  assert.equal(cancelCalls(charge.id).length, 1, 'um único pedido de estorno ao PagBank');
  assert.equal((await refundsOf(order.id)).length, 1);
  assert.equal(count((await movementsOf(order.id)).map((m) => m.type), 'cancellation'), 1, 'uma única reposição');
  assert.equal(await stockOf(product.variants[0]), 5);
});

async function paidAfterCancel(stocks = [1]) {
  const product = await createProduct(stocks);
  const order = await placeOnlineOrder(product);
  assert.equal((await setStatus(order.id, 'cancelado')).status, 200);
  assert.equal(await sendWebhook(customerPays(order.id, order.total, 'PAID')), 200);
  return { product, order };
}

test('19 pagamento aprovado após cancelamento: registrado como pago, sem reativar sozinho (DC-4)', async () => {
  const { product, order } = await paidAfterCancel([1]);
  const row = await orderRow(order.id);
  assert.equal(row.status, 'cancelado');
  assert.equal(row.paymentStatus, 'paid');
  assert.equal(row.attention, 'paid_after_cancel');
  assert.equal(await stockOf(product.variants[0]), 1, 'nenhuma nova baixa automática');
  const types = await eventTypes(order.id);
  assert.ok(types.includes('payment_approved'));
  assert.ok(types.includes('payment_after_cancel'));
  const list = await api('/api/orders/list', { adminToken: owner.token });
  assert.equal(list.data.orders.find((o) => o.id === order.id).paymentAttention, 'paid_after_cancel');
  // webhook repetido não gera outro alerta
  assert.equal(await sendWebhook(pagbankOrderOf(order.id)), 200);
  assert.equal(count(await eventTypes(order.id), 'payment_after_cancel'), 1);
});

test('20 reativação administrativa com estoque: baixa única, alerta resolvido e decisão no histórico', async () => {
  const { product, order } = await paidAfterCancel([1]);
  assert.equal((await finance('reactivate', order.id, { reason: '' })).status, 400, 'justificativa obrigatória');
  const r = await finance('reactivate', order.id, { reason: 'Cliente confirmou que ainda quer a peça' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = await orderRow(order.id);
  assert.equal(row.status, 'novo');
  assert.equal(row.paymentStatus, 'paid');
  assert.equal(row.attention, null);
  assert.equal(await stockOf(product.variants[0]), 0);
  assert.equal((await finance('reactivate', order.id, { reason: 'de novo' })).status, 409);
  assert.equal(await stockOf(product.variants[0]), 0, 'sem baixa duplicada');
  const decision = (await eventsOf(order.id)).find((e) => e.type === 'admin_decision');
  assert.equal(decision.reason, 'Cliente confirmou que ainda quer a peça');
  assert.equal(decision.adminId, owner.id);
  assert.deepEqual(decision.metadata.decision, 'reactivate');
});

test('21 reativação sem estoque: negada sem alterar nada; estorno segue disponível', async () => {
  const { product, order } = await paidAfterCancel([1]);
  await pool.query('UPDATE product_variants SET stock = 0 WHERE id = $1', [product.variants[0]]); // peça vendida de novo
  const movementsBefore = (await movementsOf(order.id)).length;
  const r = await finance('reactivate', order.id, { reason: 'tentar reativar' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Estoque insuficiente/);
  const row = await orderRow(order.id);
  assert.equal(row.status, 'cancelado');
  assert.equal(row.attention, 'paid_after_cancel');
  assert.equal(await stockOf(product.variants[0]), 0);
  assert.equal((await movementsOf(order.id)).length, movementsBefore);
  assert.ok((await eventTypes(order.id)).includes('reactivation_denied'));

  const refund = await finance('refund', order.id, { reason: 'Peça indisponível, devolver o valor' });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
  const after = await orderRow(order.id);
  assert.equal(after.paymentStatus, 'refunded');
  assert.equal(after.attention, null);
  assert.equal(await stockOf(product.variants[0]), 0, 'pedido já cancelado: estorno não mexe no estoque');
});

test('22 falha durante a transação de estoque: reativação de 2 peças com uma faltando é tudo-ou-nada', async () => {
  const product = await createProduct([1, 1]);
  const order = await placeOnlineOrder(product, [{ variant: 0, qty: 1 }, { variant: 1, qty: 1 }]);
  assert.equal((await setStatus(order.id, 'cancelado')).status, 200);
  assert.equal(await sendWebhook(customerPays(order.id, order.total, 'PAID')), 200);
  await pool.query('UPDATE product_variants SET stock = 0 WHERE id = $1', [product.variants[1]]);
  const before = (await movementsOf(order.id)).length;
  const r = await finance('reactivate', order.id, { reason: 'teste de atomicidade' });
  assert.equal(r.status, 409);
  assert.equal(await stockOf(product.variants[0]), 1, 'a primeira peça não ficou baixada pela metade');
  assert.equal(await stockOf(product.variants[1]), 0);
  assert.equal((await movementsOf(order.id)).length, before);
  assert.equal((await orderRow(order.id)).status, 'cancelado');
});

test('23 repetição após timeout: consulta antes, sem estorno duplicado; reenvio usa a mesma chave', async () => {
  // a) o PagBank processou, mas a resposta não chegou a tempo
  const a = await paidOrder([5]);
  mock.refundMode.set(a.charge.id, 'timeout-apply');
  await setStatus(a.order.id, 'cancelado');
  let row = await orderRow(a.order.id);
  assert.equal(row.paymentStatus, 'refund_failed', 'timeout não é estorno confirmado');
  assert.equal(Number(row.refundedAmount), 0);
  const retryA = await finance('retry-refund', a.order.id);
  assert.equal(retryA.status, 200, JSON.stringify(retryA.data));
  row = await orderRow(a.order.id);
  assert.equal(row.paymentStatus, 'refunded');
  assert.equal(Number(row.refundedAmount), a.order.total);
  assert.equal(cancelCalls(a.charge.id).length, 1, 'confirmado pela consulta, sem segundo pedido de estorno');
  assert.equal(mock.orders.get(mock.byReference.get(a.order.id)).charges.find((c) => c.id === a.charge.id).amount.summary.refunded, cents(a.order.total));

  // b) o PagBank não processou: a nova tentativa reenvia com a MESMA chave de idempotência
  const b = await paidOrder([5]);
  mock.refundMode.set(b.charge.id, 'timeout-noapply');
  await setStatus(b.order.id, 'cancelado');
  assert.equal((await orderRow(b.order.id)).paymentStatus, 'refund_failed');
  mock.refundMode.delete(b.charge.id);
  const retryB = await finance('retry-refund', b.order.id);
  assert.equal(retryB.status, 200);
  assert.equal((await orderRow(b.order.id)).paymentStatus, 'refunded');
  const calls = cancelCalls(b.charge.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['x-idempotency-key'], calls[1].headers['x-idempotency-key']);
  const [attempt] = await refundsOf(b.order.id);
  assert.equal(attempt.attempts, 2);
  assert.equal(attempt.status, 'confirmed');

  // c) recusa definitiva: nova tentativa com chave nova
  const c = await paidOrder([5]);
  mock.refundMode.set(c.charge.id, 'reject');
  await setStatus(c.order.id, 'cancelado');
  assert.equal((await orderRow(c.order.id)).paymentStatus, 'refund_failed');
  assert.equal((await refundsOf(c.order.id))[0].status, 'failed');
  mock.refundMode.delete(c.charge.id);
  assert.equal((await finance('retry-refund', c.order.id)).status, 200);
  const attempts = await refundsOf(c.order.id);
  assert.deepEqual(attempts.map((x) => x.status), ['failed', 'confirmed']);
  assert.notEqual(attempts[0].key, attempts[1].key);
  assert.equal((await orderRow(c.order.id)).paymentStatus, 'refunded');
});

test('24 chave em uso (409 40005, visto no sandbox): incerto, nunca recusa; chave nova só após consulta e prazo', async () => {
  const { product, order, charge } = await paidOrder([5]);
  const pagbankOrderId = mock.byReference.get(order.id);
  // sequência real do sandbox: 400 40008 e, ao reenviar a mesma chave, 409 40005
  mock.refundMode.set(charge.id, 'not-found');
  await setStatus(order.id, 'cancelado');
  assert.equal((await refundsOf(order.id))[0].status, 'unknown');

  const retry1 = await finance('retry-refund', order.id);
  assert.equal(retry1.status, 200, JSON.stringify(retry1.data));
  assert.match(retry1.data.message, /NÃO está confirmado/);
  let attempts = await refundsOf(order.id);
  assert.equal(attempts.length, 1, '409 não libera chave nova');
  assert.equal(attempts[0].status, 'unknown', '409 é incerto, não recusa definitiva');
  assert.equal(attempts[0].attempts, 2);
  let calls = cancelCalls(charge.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['x-idempotency-key'], calls[1].headers['x-idempotency-key']);
  assert.equal((await orderRow(order.id)).paymentStatus, 'refund_failed');

  // consulta ao PagBank fora do ar: nada é enviado
  mock.down.add(order.checkoutId);
  mock.down.add(pagbankOrderId);
  const blocked = await finance('retry-refund', order.id);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /Nenhuma nova tentativa de estorno foi enviada/);
  assert.equal(cancelCalls(charge.id).length, 2);
  mock.down.delete(order.checkoutId);
  mock.down.delete(pagbankOrderId);

  // passado o prazo, com a consulta mostrando que não houve estorno: chave nova, valor da consulta
  mock.refundMode.delete(charge.id);
  await pool.query("UPDATE payment_refunds SET updated_at = now() - interval '11 minutes' WHERE order_id = $1", [order.id]);
  const retry2 = await finance('retry-refund', order.id);
  assert.equal(retry2.status, 200, JSON.stringify(retry2.data));
  attempts = await refundsOf(order.id);
  assert.deepEqual(attempts.map((x) => x.status), ['failed', 'confirmed']);
  assert.notEqual(attempts[0].key, attempts[1].key);
  calls = cancelCalls(charge.id);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.amount.value, cents(order.total));
  const row = await orderRow(order.id);
  assert.equal(row.paymentStatus, 'refunded');
  assert.equal(Number(row.refundedAmount), order.total);
  assert.equal(capturedCharge(order.id).amount.summary.refunded, cents(order.total), 'estornado uma única vez no PagBank');
  assert.equal(await stockOf(product.variants[0]), 5);
  const types = await eventTypes(order.id);
  assert.equal(count(types, 'refund_superseded'), 1);
  assert.equal(count(types, 'refund_confirmed'), 1);
});

test('25 após resposta incerta, consulta mostra o estorno feito: confirma sem nova chamada nem chave nova', async () => {
  const { order, charge } = await paidOrder([5]);
  mock.refundMode.set(charge.id, 'timeout-apply');
  await setStatus(order.id, 'cancelado');
  // mesmo passado o prazo, a consulta acha o estorno e nada é reenviado
  await pool.query("UPDATE payment_refunds SET updated_at = now() - interval '11 minutes' WHERE order_id = $1", [order.id]);
  const retry = await finance('retry-refund', order.id);
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.match(retry.data.message, /já tinha processado/);
  assert.equal(cancelCalls(charge.id).length, 1);
  assert.deepEqual((await refundsOf(order.id)).map((x) => x.status), ['confirmed']);
  assert.equal((await orderRow(order.id)).paymentStatus, 'refunded');
});

// ================================================================ consistência geral

test('histórico consistente em TODOS os pedidos desta suíte: eventos encadeados e terminando no estado atual', async () => {
  const { order } = await paidOrder([5]);
  await setStatus(order.id, 'em_andamento');
  await setStatus(order.id, 'cancelado');
  assert.ok(created.orders.length >= 25, `poucos pedidos na suíte: ${created.orders.length}`);
  for (const id of created.orders) {
    const ev = await eventsOf(id);
    assert.ok(ev.length >= 1, `${id} sem histórico`);
    assert.equal(ev[0].type, 'checkout_created');
    for (let i = 1; i < ev.length; i += 1) {
      assert.equal(ev[i].fromStatus, ev[i - 1].toStatus, `${id}: ${ev[i - 1].type} -> ${ev[i].type} (status)`);
      assert.equal(ev[i].fromPayment, ev[i - 1].toPayment, `${id}: ${ev[i - 1].type} -> ${ev[i].type} (pagamento)`);
    }
    const last = ev[ev.length - 1];
    const row = await orderRow(id);
    assert.equal(last.toStatus, row.status, `${id}: último evento x status atual`);
    assert.equal(last.toPayment, row.paymentStatus, `${id}: último evento x pagamento atual`);
    // estoque: nunca mais reposições do que baixas para o mesmo pedido
    const moves = await movementsOf(id);
    const sold = -moves.filter((m) => m.type === 'sale').reduce((acc, m) => acc + m.quantity, 0);
    const back = moves.filter((m) => m.type === 'cancellation').reduce((acc, m) => acc + m.quantity, 0);
    assert.ok(back <= sold, `${id}: reposição (${back}) maior que a baixa (${sold})`);
    if (row.status === 'cancelado') assert.equal(back, sold, `${id}: pedido cancelado sem a peça de volta`);
  }
});

test('servidor não registrou chamada a host real do PagBank', () => {
  const logs = serverLogs.join('');
  assert.doesNotMatch(logs, /api\.pagseguro\.com|sandbox\.api\.pagseguro\.com/);
  assert.ok(mock.calls.length > 0);
});
