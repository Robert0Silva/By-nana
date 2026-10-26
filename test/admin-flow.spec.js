// Painel no navegador, contra o servidor e o banco de teste de verdade: o bloqueio de envio de
// pedido online sem pagamento aparece pra quem opera o painel, e o limite de usos do cupom é
// salvo pelo formulário. Grava no banco de teste, então exige banco local (ver require-local-db.js).
require('./require-local-db');
const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');

const projectRoot = path.resolve(__dirname, '..');
const port = 18793;
const origin = `http://127.0.0.1:${port}`;
const password = 'senhaPainel123';
let server;
let pool;
let admin;
let orderId;
let productId;
const couponCode = `PAINEL${crypto.randomInt(1e6)}`;

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
  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  admin = { id, email: `painel-${id.slice(0, 8)}@example.com` };
  await pool.query("INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,'Painel E2E',$2,$3,'owner')",
    [id, admin.email, `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`]);

  productId = `e2e-adm-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [category] } = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1');
  await pool.query(`INSERT INTO products (id, name, category_id, price, img, description) VALUES ($1,'Peça Painel E2E',$2,120,'assets/img/processed/logo.png','teste')`, [productId, category.id]);
  await pool.query("INSERT INTO product_variants (id, product_id, size, stock, position) VALUES ($1,$2,'M',3,0)", [`${productId}-M`, productId]);

  // pedido online ainda aguardando o gateway
  orderId = `pedido-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO orders (id, customer_name, customer_phone, items, subtotal, discount, total, payment_method, delivery_method, payment_status)
     VALUES ($1,'Cliente Pagamento Pendente','31900001111',$2,120,0,120,'Pagamento online','Retirada em loja','pending')`,
    [orderId, JSON.stringify([{ id: productId, name: 'Peça Painel E2E', qty: 1, price: 120, variantId: `${productId}-M`, variantLabel: 'M' }])]
  );

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
    await pool.query('DELETE FROM inventory_movements WHERE order_id = $1', [orderId]);
    await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
    await pool.query('DELETE FROM coupons WHERE code = $1', [couponCode]);
    await pool.query('DELETE FROM admin_activity_log WHERE admin_user_id = $1', [admin.id]);
    await pool.query('DELETE FROM admin_users WHERE id = $1', [admin.id]);
    await pool.end();
  }
});

async function login(page) {
  await page.goto(`${origin}/admin`);
  await page.locator('#loginEmail').fill(admin.email);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginPassword').press('Enter');
  await expect(page.locator('#loginForm')).toBeHidden();
}

// as abas ficam dentro de menus agrupados; o que interessa aqui é o painel, não o menu
const openTab = (page, target) => page.locator(`.admin-tab[data-target="${target}"]`).evaluate((tab) => tab.click());

test('painel recusa enviar pedido online sem pagamento confirmado e avisa o motivo', async ({ page }) => {
  await login(page);
  await openTab(page, 'pedidos');
  const code = `#${orderId.replace(/^pedido-/, '').slice(0, 8).toUpperCase()}`;
  const select = page.locator(`select[aria-label="Status do pedido ${code}"]`);
  await expect(select).toBeVisible();
  await select.selectOption('enviado');
  await expect(page.locator('.admin-toast.is-error')).toContainText('pagamento');
  // a tela volta a mostrar o status real e o banco não mudou
  await expect(page.locator(`select[aria-label="Status do pedido ${code}"]`)).toHaveValue('novo');
  const { rows: [order] } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  expect(order.status).toBe('novo');
});

test('cupom criado pelo formulário grava o limite de usos e aparece na lista', async ({ page }) => {
  await login(page);
  await openTab(page, 'cupons');
  await page.locator('#couponCode').fill(couponCode);
  await page.locator('#couponValue').fill('10');
  await page.locator('#couponMaxUses').fill('5');
  await page.locator('#couponSubmit').click();
  await expect(page.locator('#couponMsg')).toContainText('Cupom criado');
  await expect(page.locator('#couponList')).toContainText(`${couponCode} — 10% OFF · 0/5 usos`);
  const { rows: [coupon] } = await pool.query('SELECT max_uses FROM coupons WHERE code = $1', [couponCode]);
  expect(coupon.max_uses).toBe(5);

  // depois de recarregar, o cupom (que não é de boas-vindas) continua listado
  await page.reload();
  await expect(page.locator('#loginForm')).toBeHidden();
  await openTab(page, 'cupons');
  await expect(page.locator('#couponList')).toContainText(`${couponCode} — 10% OFF · 0/5 usos`);
});
