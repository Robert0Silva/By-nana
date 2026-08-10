const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
require('dotenv').config({ quiet: true });

const projectRoot = path.resolve(__dirname, '..');
const port = 18787;
const origin = `http://127.0.0.1:${port}`;
let server;

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('O servidor de teste não iniciou a tempo');
}

test.before(async () => {
  server = spawn(process.execPath, ['serve.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(() => {
  if (server && !server.killed) server.kill();
});

test('serve as páginas públicas e os assets principais', async () => {
  for (const route of ['/', '/admin', '/assets/css/style.css', '/assets/js/main.js']) {
    const response = await fetch(`${origin}${route}`, { redirect: 'manual' });
    assert.equal(response.status, 200, route);
  }
});

test('redireciona as URLs HTML para as formas canônicas', async () => {
  const cases = [
    ['/index.html', '/'],
    ['/admin.html', '/admin'],
  ];
  for (const [route, location] of cases) {
    const response = await fetch(`${origin}${route}`, { redirect: 'manual' });
    assert.equal(response.status, 301, route);
    assert.equal(new URL(response.headers.get('location'), origin).pathname, location);
  }
});

test('retorna uma página 404 estilizada inclusive em rotas aninhadas', async () => {
  const response = await fetch(`${origin}/rota/inexistente`);
  const html = await response.text();
  assert.equal(response.status, 404);
  assert.match(html, /href="\/assets\/css\/style\.css"/);
  assert.match(html, /href="\/assets\/img\/processed\/logo\.png"/);
});

test('não expõe arquivos internos do projeto', async () => {
  for (const route of ['/.env', '/serve.js', '/package.json', '/db/schema.sql']) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 404, route);
  }
});

test('rejeita URL malformada sem derrubar o servidor', async () => {
  const invalid = await fetch(`${origin}/%E0%A4%A`);
  assert.equal(invalid.status, 400);

  const healthy = await fetch(origin);
  assert.equal(healthy.status, 200);
});

test('esqueci minha senha responde com sucesso genérico mesmo para e-mail inexistente (não revela contas)', async () => {
  const response = await fetch(`${origin}/api/customers/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `nao-existe-${Date.now()}@example.com` }),
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
});

test('redefinir senha com token inválido ou expirado é rejeitado', async () => {
  const response = await fetch(`${origin}/api/customers/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'token-que-nao-existe', newPassword: 'novaSenha123' }),
  });
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.ok(data.error);
});

test('serve a página de redefinição de senha', async () => {
  const response = await fetch(`${origin}/redefinir-senha.html`);
  assert.equal(response.status, 200);
});

test('pedido sem e-mail continua sendo rejeitado só por falta dos campos obrigatórios existentes (e-mail não é um deles)', async () => {
  // Sem produtos/itens válidos o pedido é rejeitado antes de tocar o banco — isso já basta pra
  // confirmar que a ausência de customerEmail não é o motivo da rejeição (a mensagem de erro
  // não menciona e-mail) sem precisar criar um pedido/baixar estoque real no banco de dados.
  const response = await fetch(`${origin}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Cliente Teste',
      customerPhone: '31999999999',
      paymentMethod: 'Pix',
      deliveryMethod: 'Retirada em loja',
      items: [],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.doesNotMatch(data.error, /e-?mail/i);
});

// Regressão: uma variável de e-mail perdida num merge anterior fazia TODO pedido bem-sucedido
// retornar 500 (ReferenceError), e nenhum teste existente exercitava o caminho de sucesso —
// só o de rejeição por campo faltando, que nunca chega perto do bug. Este teste cria um pedido
// de verdade contra o banco configurado em DATABASE_URL e sempre limpa o que criou/alterou,
// mesmo se uma asserção falhar no meio do caminho.
test('cria um pedido com sucesso (baixa estoque e aplica desconto Pix) sem deixar resíduo no banco', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let variantId = null;
  let originalStock = null;
  let orderId = null;
  try {
    const { rows } = await pool.query(
      `SELECT v.id AS variant_id, v.product_id, v.stock, p.name, p.price
       FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE p.price IS NOT NULL ORDER BY v.stock DESC LIMIT 1`
    );
    assert.ok(rows.length, 'o catálogo precisa ter ao menos uma variação com preço para este teste');
    const variant = rows[0];
    variantId = variant.variant_id;
    originalStock = variant.stock;
    // garante estoque suficiente pro teste sem depender do que sobra em produção no momento
    await pool.query('UPDATE product_variants SET stock = $1 WHERE id = $2', [Math.max(originalStock, 5), variantId]);

    const phone = `31900${Date.now().toString().slice(-6)}`; // único por execução, não colide com clientes reais
    const response = await fetch(`${origin}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Teste Automatizado',
        customerPhone: phone,
        customerEmail: 'teste.automatizado@example.com',
        items: [{ id: variant.product_id, variantId, qty: 1, name: variant.name }],
        paymentMethod: 'Pix',
        deliveryMethod: 'Retirada em loja',
      }),
    });
    const data = await response.json();
    assert.equal(response.status, 201, JSON.stringify(data));
    assert.ok(data.orderId);
    orderId = data.orderId;

    const orderRow = await pool.query('SELECT discount, payment_status FROM orders WHERE id = $1', [orderId]);
    assert.equal(orderRow.rows.length, 1);
    const expectedDiscount = Number(variant.price) * 0.05;
    assert.ok(
      Math.abs(Number(orderRow.rows[0].discount) - expectedDiscount) < 0.01,
      `desconto Pix de 5% esperado (${expectedDiscount}), veio ${orderRow.rows[0].discount}`
    );
    assert.equal(orderRow.rows[0].payment_status, 'manual');
  } finally {
    if (orderId) {
      await pool.query('DELETE FROM inventory_movements WHERE order_id = $1', [orderId]);
      await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
    }
    if (variantId && originalStock !== null) {
      await pool.query('UPDATE product_variants SET stock = $1 WHERE id = $2', [originalStock, variantId]);
    }
    await pool.end();
  }
});
