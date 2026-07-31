const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

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
