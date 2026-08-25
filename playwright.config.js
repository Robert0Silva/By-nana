// Config mínima — só o suficiente pra rodar test/*.spec.js contra Chromium headless.
// Cada spec sobe/derruba o próprio serve.js (mesmo padrão de test/routes.test.js), então não
// há webServer aqui: os testes já cuidam disso pra poder escolher a porta e o timing certos.
const os = require('node:os');
const path = require('node:path');
const { devices } = require('@playwright/test');

module.exports = {
  testDir: './test',
  testMatch: '**/*.spec.js',
  // O workspace pode estar sincronizado pelo OneDrive, que ocasionalmente bloqueia a limpeza
  // de test-results com EPERM. Artefatos descartáveis ficam no diretório temporário do sistema.
  outputDir: path.join(os.tmpdir(), 'by-nana-playwright-results'),
  timeout: 30_000,
  fullyParallel: false,
  // Cada projeto sobe o servidor na mesma porta dentro do próprio beforeAll. Serializar evita
  // que Chromium/Firefox/WebKit encerrem o servidor uns dos outros na suíte combinada.
  workers: 1,
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  use: {
    headless: true,
  },
};
