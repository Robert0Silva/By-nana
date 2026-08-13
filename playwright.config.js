// Config mínima — só o suficiente pra rodar test/*.spec.js contra Chromium headless.
// Cada spec sobe/derruba o próprio serve.js (mesmo padrão de test/routes.test.js), então não
// há webServer aqui: os testes já cuidam disso pra poder escolher a porta e o timing certos.
module.exports = {
  testDir: './test',
  testMatch: '**/*.spec.js',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    headless: true,
  },
};
