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

// fetch() normaliza "%2e%2e" antes de enviar, então o caminho cru vai por http.request —
// é assim que um atacante (curl --path-as-is) chegaria ao servidor.
function rawGetStatus(rawPath) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('não permite path traversal codificado dentro de /assets/', async () => {
  for (const route of [
    '/assets/..%2fserve.js',
    '/assets/%2e%2e/serve.js',
    '/assets/%2E%2E/package.json',
    '/assets/css/..%2f..%2f.env',
    '/assets/..%5cserve.js',
    '/assets/./..%2fdb/schema.sql',
  ]) {
    assert.equal(await rawGetStatus(route), 404, route);
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
  for (const route of ['/api/orders/list', '/api/customers/list', '/api/admin/dashboard', '/api/admin/products/list', '/api/products/visibility', '/api/admin/abandoned-carts/list']) {
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
      const phone = `31900${Date.now().toString().slice(-5)}${Math.floor(Math.random() * 10)}`; // 11 dígitos, como um celular real
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

// Produto oculto (products.active = false) sai da vitrine, da página de produto e do checkout,
// mas continua visível no painel e pode ser republicado — insere um produto descartável direto
// no banco pra não mexer na vitrine real.
test('produto oculto some da loja e do checkout, mas o painel ainda o enxerga e republica', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const productId = `teste-oculto-${Date.now()}`;
  const variantId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const email = `admin-oculto-${Date.now()}@example.com`;
  const password = 'senhaDeTeste123';
  try {
    const category = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1');
    assert.ok(category.rows.length, 'precisa existir ao menos uma categoria');
    await pool.query(
      `INSERT INTO products (id, name, category_id, price, img, description, active)
       VALUES ($1, 'Produto Oculto de Teste', $2, 10, 'assets/img/processed/logo.png', 'teste', false)`,
      [productId, category.rows[0].id]
    );
    await pool.query('INSERT INTO product_variants (id, product_id, size, stock) VALUES ($1, $2, $3, 5)', [variantId, productId, 'U']);
    await pool.query(
      'INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
      [adminId, 'Admin Teste', email, hashPasswordForTest(password), 'staff']
    );

    const publicData = await (await fetch(`${origin}/api/data`)).json();
    assert.ok(!publicData.products.some((p) => p.id === productId), 'oculto não pode aparecer em /api/data');
    const page = await fetch(`${origin}/produto/${productId}`);
    assert.equal(page.status, 404);

    const order = await fetch(`${origin}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Teste Automatizado',
        customerPhone: `31900${Date.now().toString().slice(-6)}`,
        items: [{ id: productId, variantId, qty: 1, name: 'Produto Oculto de Teste' }],
        paymentMethod: 'Pix',
        deliveryMethod: 'Retirada em loja',
      }),
    });
    assert.equal(order.status, 400, 'checkout não pode vender produto oculto');

    const login = await (await fetch(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })).json();
    const adminList = await (await fetch(`${origin}/api/admin/products/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminToken: login.token }),
    })).json();
    const hidden = adminList.products.find((p) => p.id === productId);
    assert.ok(hidden, 'o painel precisa listar o produto oculto');
    assert.equal(hidden.active, false);

    const show = await fetch(`${origin}/api/products/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminToken: login.token, id: productId, active: true }),
    });
    assert.equal(show.status, 200);
    const afterShow = await (await fetch(`${origin}/api/data`)).json();
    assert.ok(afterShow.products.some((p) => p.id === productId), 'republicado deve voltar para /api/data');
  } finally {
    await pool.query("DELETE FROM admin_activity_log WHERE entity_id = $1", [productId]).catch(() => {});
    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
    await pool.query('DELETE FROM admin_users WHERE id = $1', [adminId]);
    await pool.end();
  }
});

// CPF e data de nascimento são opcionais — cadastro só com nome, contato e senha funciona.
test('cadastro sem CPF e sem data de nascimento é aceito', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const email = `cliente-sem-cpf-${Date.now()}@example.com`;
  try {
    const response = await fetch(`${origin}/api/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Cliente',
        lastName: 'Sem CPF',
        email,
        phone: '31999997777',
        password: 'senhaDeTeste123',
        privacyAccepted: true,
      }),
    });
    const data = await response.json();
    assert.equal(response.status, 201, JSON.stringify(data));
    const row = await pool.query('SELECT cpf, birth_date FROM customers WHERE lower(email) = $1', [email]);
    assert.equal(row.rows[0].cpf, null);
    assert.equal(row.rows[0].birth_date, null);
  } finally {
    await pool.query('DELETE FROM customers WHERE lower(email) = $1', [email]);
    await pool.end();
  }
});

// Cupons de parceiras/agendados/inativos não podem vazar pela vitrine: /api/data só traz o de
// boas-vindas vigente, e o resto só é revelado digitando o código exato.
test('cupons privados não aparecem em /api/data, mas validam pelo código', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const code = `PRIVADO${Date.now().toString(36).toUpperCase()}`;
  try {
    await pool.query(
      `INSERT INTO coupons (code, discount_type, discount_value, active, first_purchase_only) VALUES ($1, 'percent', 12, true, false)`,
      [code]
    );
    const catalog = await (await fetch(`${origin}/api/data`)).json();
    assert.ok(!catalog.coupons.some((c) => c.code === code), 'cupom privado não pode vir na vitrine');
    assert.ok(catalog.coupons.every((c) => c.firstPurchaseOnly && c.active), 'só o cupom de boas-vindas ativo é público');

    const valid = await fetch(`${origin}/api/coupons/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
      body: JSON.stringify({ code: code.toLowerCase() }),
    });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).coupon.code, code);

    const invalid = await fetch(`${origin}/api/coupons/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
      body: JSON.stringify({ code: 'NAO-EXISTE-123' }),
    });
    assert.equal(invalid.status, 404);
  } finally {
    await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
    await pool.end();
  }
});

// Sem limite, um script reservava todo o estoque com pedidos falsos. O IP vem do
// X-Forwarded-For (último hop), então um IP de documentação isola este teste dos demais.
test('/api/orders limita pedidos em sequência do mesmo IP', async () => {
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    const response = await fetch(`${origin}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.77' },
      body: JSON.stringify({}),
    });
    statuses.push(response.status);
  }
  assert.ok(statuses.slice(0, 10).every((status) => status === 400), statuses.join(','));
  assert.equal(statuses[10], 429);
});

test('/api/orders recusa telefone inválido, pedido gigante e corpo grande demais', async () => {
  const post = (body, ip) => fetch(`${origin}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const base = { customerName: 'Teste', paymentMethod: 'Pix', deliveryMethod: 'Retirada em loja' };
  const badPhone = await post({ ...base, customerPhone: '123', items: [{ id: 'x', variantId: 'y', qty: 1 }] }, '198.51.100.80');
  assert.equal(badPhone.status, 400);
  assert.match((await badPhone.json()).error, /telefone/i);

  const tooMany = await post({ ...base, customerPhone: '31999990000', items: [{ id: 'x', variantId: 'y', qty: 500 }] }, '198.51.100.81');
  assert.equal(tooMany.status, 400);

  const huge = await post(JSON.stringify({ ...base, customerPhone: '31999990000', padding: 'x'.repeat(200 * 1024) }), '198.51.100.82');
  assert.equal(huge.status, 413);
});

// A mensagem do WhatsApp é montada com o que o servidor devolve; o cupom só é gravado no
// pedido quando foi ele o desconto aplicado (Pix/quantidade não se somam e podem vencer).
test('pedido devolve totais do servidor e não grava cupom que não foi aplicado', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const code = `CUPOM3${Date.now().toString(36).toUpperCase()}`;
  let orderId;
  let variantId;
  let originalStock = null;
  try {
    const { rows } = await pool.query(
      `SELECT v.id AS variant_id, v.stock, v.size, v.color, p.id AS product_id, p.name, p.price
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE p.active AND p.price IS NOT NULL ORDER BY p.created_at LIMIT 1`
    );
    assert.ok(rows.length, 'precisa de uma variação com preço');
    const variant = rows[0];
    variantId = variant.variant_id;
    originalStock = variant.stock;
    await pool.query('UPDATE product_variants SET stock = $1 WHERE id = $2', [Math.max(originalStock, 5), variantId]);
    // 3% de cupom perde para os 5% do Pix
    await pool.query(`INSERT INTO coupons (code, discount_type, discount_value, active) VALUES ($1, 'percent', 3, true)`, [code]);

    const response = await fetch(`${origin}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.90' },
      body: JSON.stringify({
        customerName: 'Teste Totais',
        customerPhone: `31900${Date.now().toString().slice(-6)}`,
        items: [{ id: variant.product_id, variantId, qty: 1, name: variant.name, variantLabel: 'rótulo forjado' }],
        paymentMethod: 'Pix',
        deliveryMethod: 'Retirada em loja',
        couponCode: code,
      }),
    });
    const data = await response.json();
    assert.equal(response.status, 201, JSON.stringify(data));
    orderId = data.orderId;
    assert.match(data.orderCode, /^#[0-9A-F]{8}$/);
    const expectedDiscount = Math.round(Number(variant.price) * 0.05 * 100) / 100;
    assert.ok(Math.abs(data.discount - expectedDiscount) < 0.01, `desconto Pix esperado ${expectedDiscount}, veio ${data.discount}`);
    assert.ok(Math.abs(data.total - (Number(variant.price) - expectedDiscount)) < 0.01);
    assert.equal(data.items[0].variantLabel, [variant.size, variant.color].filter(Boolean).join(' - '));

    const row = await pool.query('SELECT coupon_code AS "couponCode" FROM orders WHERE id = $1', [orderId]);
    assert.equal(row.rows[0].couponCode, null);
  } finally {
    if (orderId) {
      await pool.query('DELETE FROM inventory_movements WHERE order_id = $1', [orderId]);
      await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
    }
    if (variantId && originalStock !== null) {
      await pool.query('UPDATE product_variants SET stock = $1 WHERE id = $2', [originalStock, variantId]);
    }
    await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
    await pool.end();
  }
});
