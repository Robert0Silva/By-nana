const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
require('dotenv').config({ quiet: true });

// Mesmo esquema de hash usado em serve.js (scryptSync + salt, formato "salt:hash") — os testes
// abaixo inserem usuários direto no banco pra não depender de credenciais reais de produção.
function hashPasswordForTest(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Gera um CPF com dígitos verificadores válidos (módulo 11) pra passar pela validação de
// serve.js/main.js sem precisar de uma lista fixa de CPFs de teste.
function generateValidCPF() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const digit = (digits, pos) => {
    let sum = 0;
    for (let i = 0; i < pos; i++) sum += digits[i] * (pos + 1 - i);
    return ((sum * 10) % 11) % 10;
  };
  const d9 = digit(base, 9);
  const d10 = digit([...base, d9], 10);
  return [...base, d9, d10].join('');
}

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

test('assets versionados usam cache longo e variantes WebP são servidas', async () => {
  const css = await fetch(`${origin}/assets/css/style.css?v=20260825`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const image = await fetch(`${origin}/assets/img/processed/site-hero-1-320.webp`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/webp');
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
  assert.match(html, /href="\/assets\/css\/style\.css\?v=\d+"/);
  assert.match(html, /href="\/assets\/img\/processed\/logo\.png"/);
});

test('não expõe arquivos internos do projeto', async () => {
  for (const route of ['/.env', '/serve.js', '/package.json', '/db/schema.sql']) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 404, route);
  }
});

test('health check confirma disponibilidade do servidor e do banco', async () => {
  const response = await fetch(`${origin}/api/health`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(data, { status: 'ok' });
});

test('configuração pública entrega apenas dados seguros para a vitrine', async () => {
  const response = await fetch(`${origin}/api/public-config`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(data).sort(), ['ga4MeasurementId', 'metaPixelId']);

  const catalogResponse = await fetch(`${origin}/api/data`);
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.status, 200);
  assert.match(catalog.whatsappNumber, /^\d{12,15}$/);
  assert.equal('DATABASE_URL' in catalog, false);
  const defaultShipping = catalog.shippingRules.find((rule) => rule.uf === '*');
  assert.ok(defaultShipping, 'a regra padrão de frete precisa estar configurada');
  assert.equal(Number(defaultShipping.price), 15);
  assert.equal(Number(defaultShipping.freeAbove), 499);
});

test('páginas públicas exibem os dados comerciais confirmados', async () => {
  const catalogResponse = await fetch(`${origin}/api/data`);
  const catalog = await catalogResponse.json();
  assert.ok(catalog.products.length, 'o catálogo precisa ter ao menos um produto');
  for (const route of ['/', `/produto/${catalog.products[0].id}`]) {
    const response = await fetch(`${origin}${route}`);
    const html = await response.text();
    assert.match(html, /52\.505\.441\/0001-49/);
    assert.match(html, /Av\. Guanabara, 237/);
    assert.match(html, /bynanaloja@gmail\.com/);
    assert.doesNotMatch(html, /value="Dinheiro"/);
  }
});

test('envia cabeçalhos de segurança nas páginas públicas', async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('strict-transport-security') || '', /max-age=/);
  assert.match(response.headers.get('permissions-policy') || '', /camera=\(\)/);
});

test('CSP não permite scripts ou estilos inline inseguros', async () => {
  const response = await fetch(origin);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp);
  assert.doesNotMatch(csp, /'unsafe-inline'/);
  assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com/);
});

test('bloqueia acesso anônimo a dados administrativos', async () => {
  for (const route of ['/api/orders/list', '/api/customers/list', '/api/admin/dashboard']) {
    const response = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401, route);
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

test('entrega exige endereço completo antes de reservar estoque', async () => {
  const response = await fetch(`${origin}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Cliente Teste',
      customerPhone: '31999999999',
      paymentMethod: 'Pix',
      deliveryMethod: 'Entrega',
      items: [{ id: 'produto-inexistente', variantId: 'variante-inexistente', qty: 1 }],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.match(data.error, /endereço/i);
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

// Regressão: /api/admin/login é a porta de entrada de todo o painel e não tinha nenhum teste
// automatizado — insere um admin descartável direto no banco (mesmo hash usado em serve.js)
// pra não depender de credenciais reais de produção.
test('login de admin: rejeita senha errada e aceita a senha correta', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const id = crypto.randomUUID();
  const email = `admin-teste-${Date.now()}@example.com`;
  const password = 'senhaDeTeste123';
  try {
    await pool.query(
      'INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
      [id, 'Admin Teste', email, hashPasswordForTest(password), 'staff']
    );

    const wrong = await fetch(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'senhaErrada' }),
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const okData = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(okData));
    assert.ok(okData.token);
    assert.equal(okData.adminUser.email, email);
  } finally {
    await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
    await pool.end();
  }
});

// Regressão: cadastro/login de cliente (conta na loja) não tinha cobertura — cobre CPF inválido
// sendo rejeitado, cadastro válido criando a conta, e login aceitando/rejeitando a senha certa.
test('cadastro de cliente rejeita CPF inválido e permite login depois de cadastrado', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const email = `cliente-teste-${Date.now()}@example.com`;
  const password = 'senhaDeTeste123';
  let customerCreated = false;
  try {
    const invalidCpf = await fetch(`${origin}/api/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Cliente',
        lastName: 'Teste',
        email,
        phone: '31999998888',
        birthDate: '1990-01-01',
        cpf: '111.111.111-11', // sequência repetida — dígito verificador inválido
        password,
        privacyAccepted: true,
      }),
    });
    const invalidData = await invalidCpf.json();
    assert.equal(invalidCpf.status, 400);
    assert.match(invalidData.error, /cpf/i);

    const signup = await fetch(`${origin}/api/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Cliente',
        lastName: 'Teste',
        email,
        phone: '31999998888',
        birthDate: '1990-01-01',
        cpf: generateValidCPF(),
        password,
        privacyAccepted: true,
      }),
    });
    const signupData = await signup.json();
    assert.equal(signup.status, 201, JSON.stringify(signupData));
    customerCreated = true;
    assert.ok(signupData.token);

    const wrongLogin = await fetch(`${origin}/api/customers/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'senhaErrada' }),
    });
    assert.equal(wrongLogin.status, 401);

    const okLogin = await fetch(`${origin}/api/customers/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const okLoginData = await okLogin.json();
    assert.equal(okLogin.status, 200, JSON.stringify(okLoginData));
    assert.ok(okLoginData.token);
  } finally {
    if (customerCreated) await pool.query('DELETE FROM customers WHERE lower(email) = $1', [email]);
    await pool.end();
  }
});

test('cadastro rejeita senha com menos de oito caracteres', async () => {
  const response = await fetch(`${origin}/api/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Cliente',
      lastName: 'Teste',
      email: `senha-curta-${Date.now()}@example.com`,
      phone: '31999998888',
      birthDate: '1990-01-01',
      cpf: generateValidCPF(),
      password: 'curta7!',
      privacyAccepted: true,
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.match(data.error, /8 caracteres/);
});

test('trocar a senha invalida imediatamente o token anterior do cliente', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const email = `sessao-teste-${Date.now()}@example.com`;
  const password = 'senhaDeTeste123';
  const newPassword = 'senhaNovaTeste456';
  let customerCreated = false;
  try {
    const signup = await fetch(`${origin}/api/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Sessão', lastName: 'Teste', email, phone: '31999997777',
        birthDate: '1990-01-01', cpf: generateValidCPF(), password, privacyAccepted: true,
      }),
    });
    const signupData = await signup.json();
    assert.equal(signup.status, 201, JSON.stringify(signupData));
    customerCreated = true;

    const change = await fetch(`${origin}/api/customers/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: signupData.token, currentPassword: password, newPassword }),
    });
    assert.equal(change.status, 200);

    const stale = await fetch(`${origin}/api/customers/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: signupData.token }),
    });
    assert.equal(stale.status, 401);

    const login = await fetch(`${origin}/api/customers/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: newPassword }),
    });
    assert.equal(login.status, 200);
  } finally {
    if (customerCreated) await pool.query('DELETE FROM customers WHERE lower(email) = $1', [email]);
    await pool.end();
  }
});

// Regressão: a lógica de cupom no checkout (serve.js recalculando o desconto a partir do banco,
// nunca confiando no valor vindo do cliente) não tinha nenhum teste cobrindo o caminho completo
// — criar o cupom via admin, aplicar num pedido de verdade e conferir o desconto gravado.
test('cupom válido aplica desconto no pedido; código inexistente é ignorado sem travar o pedido', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adminId = crypto.randomUUID();
  const adminEmail = `admin-cupom-teste-${Date.now()}@example.com`;
  const adminPassword = 'senhaDeTeste123';
  const couponCode = `TESTE${Date.now().toString(36).toUpperCase()}`;
  let variantId = null;
  let originalStock = null;
  const orderIds = [];
  try {
    await pool.query(
      'INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
      [adminId, 'Admin Cupom Teste', adminEmail, hashPasswordForTest(adminPassword), 'staff']
    );
    const loginRes = await fetch(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    const { token: adminToken } = await loginRes.json();
    assert.ok(adminToken, 'login do admin de teste precisa funcionar pra continuar o teste');

    const createCoupon = await fetch(`${origin}/api/coupons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminToken, code: couponCode, type: 'percent', value: 15 }),
    });
    assert.equal(createCoupon.status, 201, JSON.stringify(await createCoupon.json()));

    const { rows } = await pool.query(
      `SELECT v.id AS variant_id, v.product_id, v.stock, p.name, p.price
       FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE p.price IS NOT NULL ORDER BY v.stock DESC LIMIT 1`
    );
    assert.ok(rows.length, 'o catálogo precisa ter ao menos uma variação com preço para este teste');
    const variant = rows[0];
    variantId = variant.variant_id;
    originalStock = variant.stock;
    await pool.query('UPDATE product_variants SET stock = $1 WHERE id = $2', [Math.max(originalStock, 5), variantId]);

    const placeOrder = async (couponCodeToUse) => {
      const phone = `31900${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10)}`;
      const response = await fetch(`${origin}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Teste Cupom',
          customerPhone: phone,
          items: [{ id: variant.product_id, variantId, qty: 1, name: variant.name }],
          paymentMethod: 'Dinheiro', // evita o desconto automático de Pix, que mascararia o do cupom
          deliveryMethod: 'Retirada em loja',
          couponCode: couponCodeToUse,
        }),
      });
      const data = await response.json();
      assert.equal(response.status, 201, JSON.stringify(data));
      orderIds.push(data.orderId);
      return data.orderId;
    };

    const withCouponId = await placeOrder(couponCode);
    const withCouponRow = await pool.query('SELECT discount, coupon_code AS "couponCode" FROM orders WHERE id = $1', [withCouponId]);
    const expectedDiscount = Number(variant.price) * 0.15;
    assert.equal(withCouponRow.rows[0].couponCode, couponCode);
    assert.ok(
      Math.abs(Number(withCouponRow.rows[0].discount) - expectedDiscount) < 0.01,
      `desconto de 15% esperado (${expectedDiscount}), veio ${withCouponRow.rows[0].discount}`
    );

    const withBogusCodeId = await placeOrder('CODIGO-QUE-NAO-EXISTE');
    const bogusRow = await pool.query('SELECT discount, coupon_code AS "couponCode" FROM orders WHERE id = $1', [withBogusCodeId]);
    assert.equal(bogusRow.rows[0].couponCode, null);
    assert.equal(Number(bogusRow.rows[0].discount), 0);
  } finally {
    for (const orderId of orderIds) {
      await pool.query('DELETE FROM inventory_movements WHERE order_id = $1', [orderId]);
      await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
    }
    if (variantId && originalStock !== null) {
      await pool.query('UPDATE product_variants SET stock = $1 WHERE id = $2', [originalStock, variantId]);
    }
    await pool.query('DELETE FROM coupons WHERE code = $1', [couponCode]);
    await pool.query('DELETE FROM admin_users WHERE id = $1', [adminId]);
    await pool.end();
  }
});
