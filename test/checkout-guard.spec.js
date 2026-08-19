// Teste de UI de fumaça (Playwright) — cobre dois pontos que test/routes.test.js (backend puro)
// não alcança: 1) a home carrega no navegador sem erro de console e a topbar dinâmica renderiza
// uma mensagem ativa; 2) o botão de checkout, quando ativado várias vezes seguidas (duplo
// clique, Enter repetido), dispara só UMA tentativa de envio — a regressão corrigida em
// assets/js/main.js (checkoutInFlight). Roda separado de `npm test` (node:test); use
// `npm run test:e2e`.
//
// A requisição /api/orders é interceptada e nunca chega no servidor de verdade: este teste
// valida só o comportamento do front (quantas vezes ele TENTA enviar), não a criação do pedido
// em si (isso já é coberto por test/routes.test.js) — então nenhum pedido de teste é gravado no
// banco de dados real.
const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const port = 18788;
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

test.beforeAll(async () => {
  server = spawn(process.execPath, ['serve.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.afterAll(() => {
  if (server && !server.killed) server.kill();
});

test('home carrega sem erro de console e a topbar mostra uma mensagem ativa', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(new Error(msg.text()));
  });

  await page.goto(origin);
  await expect(page.locator('.topbar-msg.is-active')).toBeVisible();
  expect(errors).toEqual([]);
});

test('catálogo abre uma página de produto válida sem erros de navegador', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto(origin);
  const firstProduct = page.locator('.product-card .product-media').first();
  await expect(firstProduct).toBeVisible();
  const productName = await firstProduct.locator('img').getAttribute('alt');
  await firstProduct.click();

  await expect(page).toHaveURL(/\/produto\/[^/?#]+$/);
  await expect(page.locator('#pdpLayout')).toBeVisible();
  await expect(page.locator('#pdpName')).toHaveText(productName);
  await expect(page.locator('#pdpMainImg')).toHaveAttribute('alt', productName);
  expect(errors).toEqual([]);
});

test('catálogo exibe parcelamento compatível com mínimo de R$ 50', async ({ page }) => {
  await page.goto(origin);
  const pricedCard = page.locator('.product-card:has(.product-price:not(.consult))').first();
  await expect(pricedCard).toBeVisible();
  await expect(pricedCard.locator('.installments')).toHaveText(/(?:[2-6]x de .* sem juros|pagamento em 1x no cartão)/i);
});

test('sacola permite adicionar e remover sem recarregar', async ({ page }) => {
  await page.goto(origin);
  const addBtn = page.locator('.add-btn:not(.is-soldout)').first();
  await addBtn.waitFor({ state: 'visible' });
  await addBtn.click();

  await expect(page.locator('#bagDrawer')).toHaveClass(/is-open/);
  await expect(page.locator('#bagItems .bag-item')).toHaveCount(1);
  await expect(page.locator('#bagItems .qty-btn[data-op="dec"]')).toHaveAttribute('aria-label', /Diminuir quantidade/);
  await page.locator('#bagItems .bag-item-remove').click();
  await expect(page.locator('#bagItems .bag-empty')).toBeVisible();
});

test('checkout incompleto mostra validação e não envia pedido', async ({ page }) => {
  await page.goto(origin);
  await page.locator('.add-btn:not(.is-soldout)').first().click();

  let orderRequests = 0;
  await page.on('request', (request) => {
    if (request.url().endsWith('/api/orders')) orderRequests += 1;
  });
  await page.locator('#bagCheckout').click();

  await expect(page.locator('#bagFormError')).toBeVisible();
  expect(orderRequests).toBe(0);
});

test('modal de conta abre, recebe foco e fecha com Escape', async ({ page }) => {
  await page.goto(origin);
  await page.locator('#accountBtn').click();
  await expect(page.locator('#accountModal')).toHaveClass(/is-open/);
  await expect(page.locator('#accountClose')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#accountModal')).not.toHaveClass(/is-open/);
  await expect(page.locator('#accountBtn')).toBeFocused();
});

test('layout móvel não cria rolagem horizontal e o menu pode ser aberto', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await expect(page.locator('#menuToggle')).toBeVisible();
  await page.locator('#menuToggle').click();
  await expect(page.locator('#mainNav')).toHaveClass(/is-open/);
  await expect(page.locator('#menuToggle')).toHaveAttribute('aria-expanded', 'true');

  const overflow = await page.evaluate(() => {
    // eslint-disable-next-line no-undef -- executado no contexto da página pelo Playwright.
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test('ativar o botão de checkout várias vezes seguidas dispara só uma tentativa de envio', async ({ page }) => {
  await page.goto(origin);

  // adicionar já abre a sacola sozinho (ver "if (addToCart(...)) openBag()" em main.js) —
  // não precisa (e não deve) clicar de novo no ícone da sacola.
  const addBtn = page.locator('.add-btn:not(.is-soldout)').first();
  await addBtn.waitFor({ state: 'visible' });
  await addBtn.click();
  await expect(page.locator('#bagDrawer')).toHaveClass(/is-open/);

  await page.locator('#bagName').fill('Cliente Teste');
  await page.locator('#bagPhone').fill('31999999999');
  // os radios ficam fora da viewport visível (escondidos atrás do chip estilizado .bag-chip) —
  // clica no <label> visível, igual um clique real faria, em vez do <input> escondido.
  await page.locator('label.bag-chip:has(input[name="payment"][value="Pix"])').click();
  await page.locator('label.bag-chip:has(input[name="delivery"][value="Retirada em loja"])').click();

  let orderRequests = 0;
  await page.route('**/api/orders', async (route) => {
    orderRequests += 1;
    // resposta de propósito lenta: é exatamente essa janela (servidor ainda processando o
    // primeiro clique) que um duplo clique real exploraria sem a guarda checkoutInFlight.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ orderId: 'pedido-teste-fake' }) });
  });

  // 3 ativações na mesma tick do JS — a simulação mais fiel de clique duplo/tecla Enter repetida.
  await page.evaluate(() => {
    // eslint-disable-next-line no-undef -- roda injetado no navegador (contexto da página), não no Node.
    const btn = document.getElementById('bagCheckout');
    btn.click();
    btn.click();
    btn.click();
  });

  await page.waitForTimeout(800);
  expect(orderRequests).toBe(1);
});
