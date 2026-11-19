// Fase 1: painel financeiro do pedido (DC-4). Pedido cancelado que recebeu pagamento depois:
// o painel mostra o alerta, os valores e o histórico, e a reativação passa pelo servidor com a
// justificativa e a validação de estoque. Grava no banco de teste, então exige banco local.
require('./require-local-db');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');

const projectRoot = path.resolve(__dirname, '..');
const port = 18795;
const origin = `http://127.0.0.1:${port}`;
const password = 'senhaFinanceiro123';
let server;
let pool;
let admin;
let productId;
let orderId;

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('O servidor de teste não iniciou a tempo');
}

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  admin = { id, email: `financeiro-${id.slice(0, 8)}@example.com` };
  await pool.query("INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,'Financeiro E2E',$2,$3,'staff')",
    [id, admin.email, `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`]);

  productId = `e2e-fin-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [category] } = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1');
  await pool.query("INSERT INTO products (id, name, category_id, price, img, description) VALUES ($1,'Peça Financeiro E2E',$2,150,'assets/img/processed/logo.png','teste')", [productId, category.id]);
  await pool.query("INSERT INTO product_variants (id, product_id, size, stock, position) VALUES ($1,$2,'M',2,0)", [`${productId}-M`, productId]);

  // estado sintético: pedido cancelado (peça já devolvida) que recebeu pagamento depois
  orderId = `pedido-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO orders (id, customer_name, customer_phone, items, subtotal, discount, total, payment_method, delivery_method,
                         status, payment_status, paid_amount, payment_charge_id, payment_attention, paid_at)
     VALUES ($1,'Cliente Pagou Depois','31900002222',$2,150,0,150,'Pagamento online (Pix/cartão)','Retirada em loja',
             'cancelado','paid',150,'CHAR_E2E_0001','paid_after_cancel',now())`,
    [orderId, JSON.stringify([{ id: productId, name: 'Peça Financeiro E2E', qty: 1, price: 150, variantId: `${productId}-M`, variantLabel: 'M' }])]
  );
  await pool.query(
    `INSERT INTO order_events (order_id, event_type, from_status, to_status, from_payment_status, to_payment_status, source)
     VALUES ($1,'payment_approved','cancelado','cancelado','pending','paid','webhook'),
            ($1,'payment_after_cancel','cancelado','cancelado','paid','paid','webhook')`,
    [orderId]
  );

  server = spawn(process.execPath, ['serve.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PAYMENT_PROVIDER: '', RESEND_API_KEY: '', STORE_NOTIFY_EMAIL: '' },
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
    await pool.query('DELETE FROM admin_activity_log WHERE admin_user_id = $1', [admin.id]);
    await pool.query('DELETE FROM admin_users WHERE id = $1', [admin.id]);
    await pool.end();
  }
});

test('financeiro do pedido: pago após cancelamento mostra alerta e reativa com justificativa e estoque', async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  await page.goto(`${origin}/admin`);
  await page.locator('#loginEmail').fill(admin.email);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginPassword').press('Enter');
  await expect(page.locator('#loginForm')).toBeHidden();
  await page.locator('.admin-tab[data-target="pedidos"]').evaluate((tab) => tab.click());
  await page.waitForLoadState('networkidle'); // a aba recarrega a lista de pedidos
  await page.locator('[data-status-tab="cancelado"]').click();

  const item = page.locator('#orderList .admin-order-item', { hasText: 'Cliente Pagou Depois' });
  await expect(item.locator('.admin-order-stale-badge')).toContainText('Pago após cancelamento');
  await item.locator('.admin-order-finance-toggle').click();
  const panel = item.locator('.admin-order-finance');
  await expect(panel).toContainText('o pedido NÃO foi reativado automaticamente');
  await expect(panel).toContainText('CHAR_E2E_0001');
  await expect(panel.locator('.admin-order-finance-events li')).toHaveCount(2);
  await expect(panel.locator('[data-fin="refund"]')).toBeVisible();
  if (process.env.FIN_SCREENSHOT) await item.screenshot({ path: process.env.FIN_SCREENSHOT });

  await panel.locator('[data-fin="reactivate"]').click();
  await page.locator('#adminPromptInput').fill('Cliente confirmou pelo WhatsApp');
  await page.locator('#adminPromptInput').press('Enter');
  await expect(page.locator('.admin-toast').last()).toContainText('reativado');

  const { rows: [order] } = await pool.query('SELECT status, payment_attention FROM orders WHERE id = $1', [orderId]);
  expect(order.status).toBe('novo');
  expect(order.payment_attention).toBeNull();
  const { rows: [variant] } = await pool.query('SELECT stock FROM product_variants WHERE id = $1', [`${productId}-M`]);
  expect(variant.stock).toBe(1);
  const { rows: [decision] } = await pool.query("SELECT reason, admin_user_id FROM order_events WHERE order_id = $1 AND event_type = 'admin_decision'", [orderId]);
  expect(decision.reason).toBe('Cliente confirmou pelo WhatsApp');
  expect(decision.admin_user_id).toBe(admin.id);
  expect(consoleErrors).toEqual([]);
});
