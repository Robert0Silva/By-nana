// Config mínima, não-invasiva: só eslint:recommended (pega bug real — variável não definida,
// não usada, case sem break, código inalcançável — nada de regra de estilo/formatação, que
// geraria um diff gigante sem benefício em código legado sem lint prévio).
const js = require('@eslint/js');

module.exports = [
  { ignores: ['node_modules/**', 'assets/img/**', 'assets/videos/**'] },
  js.configs.recommended,
  {
    // catch{} vazio é o padrão já usado no projeto pra "tentar de novo, ignorando o motivo"
    // (polling de servidor, parse de JSON opcional) — não é bug, é decisão deliberada.
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    // scripts Node (servidor, seeds, utilitários de imagem, testes, este próprio config)
    files: ['serve.js', 'email.js', 'payment-provider.js', 'payment-providers/**/*.js', 'process-images.js', 'process-new-photos.js', 'db/**/*.js', 'test/**/*.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', console: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        global: 'readonly', fetch: 'readonly', URL: 'readonly',
      },
    },
  },
  {
    // JS do navegador (vitrine e painel admin)
    files: ['assets/js/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', fetch: 'readonly',
        navigator: 'readonly', location: 'readonly', history: 'readonly',
        URLSearchParams: 'readonly', URL: 'readonly', crypto: 'readonly', Intl: 'readonly',
        FormData: 'readonly', FileReader: 'readonly', Blob: 'readonly',
        IntersectionObserver: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', clearTimeout: 'readonly', alert: 'readonly',
        confirm: 'readonly', requestAnimationFrame: 'readonly',
        // promo.js roda tanto no navegador quanto importado via require() em serve.js/testes —
        // "module" precisa existir como global pro guarda `typeof module !== 'undefined'` (ver
        // final de assets/js/promo.js) não disparar no-undef.
        module: 'writable',
        // scripts de terceiro (Google Analytics / Meta Pixel) carregados via <script> externo
        // quando as env vars GA4_MEASUREMENT_ID/META_PIXEL_ID estão configuradas — ver analytics.js.
        gtag: 'readonly', fbq: 'readonly',
      },
    },
    rules: {
      // admin.js insere de propósito um caractere BOM (U+FEFF) no início do CSV exportado, pra
      // o Excel no Windows abrir o arquivo já reconhecendo UTF-8 (senão acento/ç quebra).
      'no-irregular-whitespace': ['error', { skipTemplates: true }],
    },
  },
];
