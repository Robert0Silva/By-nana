// Fotos e vídeos enviados pelo painel sem disco persistente só existem no servidor que está no ar
// e somem no próximo deploy. Este script lista tudo o que o banco referencia (capas, galeria,
// stories e as imagens fixas do site), baixa cada arquivo do site publicado e compara com o
// que está no repositório. Ver docs/migracao-render.md.
//
// Uso: DATABASE_URL=... SITE_URL=https://... node db/rescue-uploads.js           (só relatório)
//      DATABASE_URL=... SITE_URL=https://... node db/rescue-uploads.js --write   (salva em assets/)
//      ... --write --out <pasta>   (salva numa pasta separada, com a mesma estrutura assets/...)
//
// Com --write, o que só existe no site (ou está diferente) é gravado na pasta assets/ do projeto:
// o servidor procura primeiro no UPLOAD_DIR e depois no repositório, então depois do commit esses
// arquivos continuam no ar mesmo com o disco novo vazio. O banco só é lido (transação READ ONLY).
// Sem dotenv de propósito: o banco lido precisa vir explícito na linha de comando, nunca do .env.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
const PREFIXES = ['assets/img/processed/', 'assets/videos/'];
const RESPONSIVE_WIDTHS = [320, 640, 1000];

// as imagens fixas do site (capa, sobre, favicon) não ficam no banco: vêm de SITE_IMAGE_SLOTS
function siteSlotPaths() {
  const source = fs.readFileSync(path.join(root, 'serve.js'), 'utf8');
  const block = source.slice(source.indexOf('const SITE_IMAGE_SLOTS'), source.indexOf('};', source.indexOf('const SITE_IMAGE_SLOTS')));
  return [...block.matchAll(/path: '([^']+)'/g)].map((m) => m[1]);
}

function normalize(value, siteOrigin) {
  if (!value) return null;
  let rel = String(value).trim();
  if (/^https?:\/\//i.test(rel)) {
    const url = new URL(rel);
    if (url.origin !== siteOrigin) return null; // arquivo hospedado fora do site
    rel = url.pathname;
  }
  rel = decodeURIComponent(rel.split(/[?#]/)[0]).replace(/^\/+/, '');
  return PREFIXES.some((prefix) => rel.startsWith(prefix)) && !rel.includes('..') ? rel : null;
}

function withVariants(rel) {
  if (!/\.(?:jpe?g|png)$/i.test(rel)) return [rel];
  const stem = rel.slice(0, -path.extname(rel).length);
  return [rel, ...RESPONSIVE_WIDTHS.map((width) => `${stem}-${width}.webp`)];
}

async function referencedPaths(siteOrigin) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(`
      SELECT img AS ref FROM products
      UNION SELECT url FROM product_images
      UNION SELECT video FROM stories
      UNION SELECT cover FROM stories`);
    const refs = [...rows.map((r) => r.ref), ...siteSlotPaths()];
    return [...new Set(refs.map((ref) => normalize(ref, siteOrigin)).filter(Boolean).flatMap(withVariants))].sort();
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

async function main() {
  const write = process.argv.includes('--write');
  const outIndex = process.argv.indexOf('--out');
  const outRoot = outIndex > 0 && process.argv[outIndex + 1] ? path.resolve(process.argv[outIndex + 1]) : root;
  if (!process.env.DATABASE_URL || !process.env.SITE_URL) {
    console.error('Defina DATABASE_URL (banco que está no ar) e SITE_URL (endereço do site que está no ar).');
    process.exit(2);
  }
  const siteOrigin = new URL(process.env.SITE_URL).origin;
  const files = await referencedPaths(siteOrigin);
  const result = { igual: [], salvar: [], faltando: [] };

  for (const rel of files) {
    const response = await fetch(`${siteOrigin}/${rel.split('/').map(encodeURIComponent).join('/')}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // variante .webp ausente não é perda: é regerada a partir da foto original
      if (!/-\d+\.webp$/.test(rel)) result.faltando.push(`${rel} (HTTP ${response.status})`);
      continue;
    }
    const remote = Buffer.from(await response.arrayBuffer());
    const localPath = path.join(root, rel);
    const local = fs.existsSync(localPath) ? fs.readFileSync(localPath) : null;
    if (local && local.equals(remote)) {
      result.igual.push(rel);
      continue;
    }
    result.salvar.push(`${rel} (${local ? 'diferente do repositório' : 'só no site'}, ${Math.round(remote.length / 1024)} KB)`);
    if (write) {
      const outPath = path.join(outRoot, rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, remote);
    }
  }

  console.log(`Arquivos referenciados: ${files.length}`);
  console.log(`Iguais ao repositório: ${result.igual.length}`);
  console.log(`\n${write ? `Salvos em ${outRoot}` : 'Precisam ser salvos (rode com --write)'}: ${result.salvar.length}`);
  result.salvar.forEach((line) => console.log(`  ${line}`));
  console.log(`\nJá perdidos (o site não tem mais; reenviar pelo painel): ${result.faltando.length}`);
  result.faltando.forEach((line) => console.log(`  ${line}`));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
