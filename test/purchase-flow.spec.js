// Compra de ponta a ponta no navegador, SEM interceptar a API: escolher o tamanho na página do
// produto, fechar o pedido na sacola e conferir no banco (não na mensagem da tela) que o pedido
// foi gravado com a variação certa, o total do servidor e a baixa de estoque daquele tamanho.
// Grava no banco de teste, então exige banco local (ver require-local-db.js).
require('./require-local-db');
const { test, expect, devices } = require('@playwright/test');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');

const projectRoot = path.resolve(__dirname, '..');
const port = 18790;
const origin = `http://127.0.0.1:${port}`;
let server;
let pool;
let product;

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

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const id = `e2e-${crypto.randomUUID().slice(0, 12)}`;
  const { rows: [category] } = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1');
  await pool.query(
    `INSERT INTO products (id, name, category_id, price, img, description) VALUES ($1,$2,$3,150,'assets/img/processed/logo.png','Peça criada pelo teste de compra')`,
    [id, `Vestido Teste ${id.slice(-6)}`, category.id]
  );
  const stock = { P: 0, M: 2, G: 5 };
  for (const [position, size] of ['P', 'M', 'G'].entries()) {
    await pool.query('INSERT INTO product_variants (id, product_id, size, stock, position) VALUES ($1,$2,$3,$4,$5)', [`${id}-${size}`, id, size, stock[size], position]);
  }
  product = { id, variant: (size) => `${id}-${size}` };
  server = spawn(process.execPath, ['serve.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.afterAll(async () => {
  if (server && !server.killed) server.kill();
  if (pool) {
    const { rows } = await pool.query("SELECT id FROM orders WHERE items @> $1::jsonb", [JSON.stringify([{ id: product.id }])]);
    const orderIds = rows.map((r) => r.id);
    await pool.query('DELETE FROM inventory_movements WHERE order_id = ANY($1) OR variant_id LIKE $2', [orderIds, `${product.id}-%`]);
    await pool.query('DELETE FROM orders WHERE id = ANY($1)', [orderIds]);
    await pool.query("DELETE FROM abandoned_carts WHERE contact_email LIKE 'compra-e2e-%'");
    await pool.query('DELETE FROM products WHERE id = $1', [product.id]);
    await pool.end();
  }
});

for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['celular', devices['iPhone 13'].viewport]]) {
  test(`compra completa pelo navegador (${label}): tamanho escolhido vira o pedido e baixa o estoque certo`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    // o WhatsApp abre numa aba nova; fecha sem navegar pra fora
    context.on('page', (popup) => popup.close().catch(() => {}));
    const stockBefore = (await pool.query('SELECT size, stock FROM product_variants WHERE product_id = $1', [product.id])).rows;
    const stockM = stockBefore.find((v) => v.size === 'M').stock;
    test.skip(stockM < 1, 'tamanho M já esgotado por uma execução anterior');

    await page.goto(`${origin}/produto/${product.id}`);
    const picker = page.locator('#pdpVariantPicker');
    await expect(picker).toBeVisible();
    await expect(picker.locator(`[data-variant-id="${product.variant('P')}"]`)).toBeDisabled();
    await picker.locator(`[data-variant-id="${product.variant('M')}"]`).click();
    await page.locator('#pdpAdd').click();
    await expect(page.locator('#bagDrawer')).toHaveClass(/is-open/);
    await expect(page.locator('#bagItems .bag-item')).toHaveCount(1);

    const email = `compra-e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await page.locator('#bagName').fill('Cliente Compra E2E');
    await page.locator('#bagPhone').fill('31988887777');
    await page.locator('#bagEmail').fill(email);
    await page.locator('#bagName').focus(); // blur do e-mail registra o carrinho (lembrete)
    await page.locator('label.bag-chip:has(input[name="payment"][value="Pix"])').click();
    await page.locator('label.bag-chip:has(input[name="delivery"][value="Retirada em loja"])').click();
    await page.locator('#bagCheckout').click();
    await expect(page.locator('#bagConfirmation')).toBeVisible();
    const shownCode = (await page.locator('#bagConfirmationCode').textContent()).trim();

    // a prova é o banco, não a tela
    const { rows: [order] } = await pool.query(
      `SELECT id, items, total, discount, status, payment_status AS "paymentStatus", idempotency_key AS "idempotencyKey" FROM orders
        WHERE email = $1 ORDER BY created_at DESC LIMIT 1`, [email]);
    expect(order, 'pedido precisa existir no banco').toBeTruthy();
    expect(`#${order.id.replace(/^pedido-/, '').slice(0, 8).toUpperCase()}`).toBe(shownCode);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ id: product.id, variantId: product.variant('M'), variantLabel: 'M', qty: 1, price: 150 });
    expect(Number(order.discount)).toBe(7.5); // Pix 5%
    expect(Number(order.total)).toBe(142.5);
    expect(order.status).toBe('novo');
    expect(order.paymentStatus).toBe('manual');
    expect(order.idempotencyKey, 'a sacola manda a chave contra pedido duplicado').toMatch(/^[0-9a-f-]{36}$/);
    const stockAfter = (await pool.query('SELECT size, stock FROM product_variants WHERE product_id = $1', [product.id])).rows;
    expect(stockAfter.find((v) => v.size === 'M').stock).toBe(stockM - 1);
    expect(stockAfter.find((v) => v.size === 'G').stock).toBe(stockBefore.find((v) => v.size === 'G').stock);

    // carrinho registrado com dados do catálogo e encerrado pela compra
    await expect.poll(async () => (await pool.query('SELECT converted_at FROM abandoned_carts WHERE contact_email = $1', [email])).rows[0]?.converted_at ?? null).not.toBeNull();
    const { rows: [cart] } = await pool.query('SELECT items, subtotal FROM abandoned_carts WHERE contact_email = $1', [email]);
    expect(cart.items[0]).toMatchObject({ id: product.id, qty: 1 });
    expect(Number(cart.subtotal)).toBe(150);

    // sacola esvaziada depois do pedido (evita pedido duplicado ao recarregar)
    await page.reload();
    await page.locator('#bagBtn').click();
    await expect(page.locator('#bagItems .bag-empty')).toBeVisible();
  });
}
