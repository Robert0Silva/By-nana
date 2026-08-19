// Config mínima — só o suficiente pra rodar test/*.spec.js contra Chromium headless.
// Cada spec sobe/derruba o próprio serve.js (mesmo padrão de test/routes.test.js), então não
// há webServer aqui: os testes já cuidam disso pra poder escolher a porta e o timing certos.
const os = require('node:os');
const path = require('node:path');

module.exports = {
  testDir: './test',
  testMatch: '**/*.spec.js',
  // O workspace pode estar sincronizado pelo OneDrive, que ocasionalmente bloqueia a limpeza
  // de test-results com EPERM. Artefatos descartáveis ficam no diretório temporário do sistema.
  outputDir: path.join(os.tmpdir(), 'by-nana-playwright-results'),
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    headless: true,
  },
};
