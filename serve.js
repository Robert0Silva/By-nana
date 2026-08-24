require('dotenv').config({ quiet: true });
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const sharp = require('sharp');
const { Pool, types } = require('pg');
const { sendEmail } = require('./email');
const PromoEngine = require('./assets/js/promo.js');
const { getActiveProvider } = require('./payment-provider');

// Valor exato de paymentMethod que o front usa pra sinalizar "quero pagar agora, online" (ver
// index.html/produto.html) — as demais opções (Pix combinado, dinheiro etc.) continuam indo
// pro fluxo manual/WhatsApp de sempre mesmo com um gateway configurado. Tem que casar
// caractere a caractere com o value do <input name="payment"> correspondente no HTML.
const ONLINE_PAYMENT_METHOD = 'Pagamento online (Pix/cartão)';

// numeric -> number, date -> plain 'YYYY-MM-DD' string (avoids timezone drift from Date objects)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, (v) => v);

const REQUIRED_ENV_VARS = ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_SESSION_SECRET'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missingEnvVars.length) {
  console.error(`[boot] Variáveis de ambiente obrigatórias ausentes: ${missingEnvVars.join(', ')}. Configure o .env antes de iniciar o servidor.`);
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Sem este listener, um erro num client ocioso do pool (ex.: o Neon derrubando a conexão por
// inatividade) vira uncaughtException e derruba o processo inteiro — não só a request atual.
pool.on('error', (err) => console.error('[pg pool] erro em client ocioso:', err.message));

const root = __dirname;
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '0.0.0.0';
const uploadDir = path.join(root, 'assets/img/processed');
const videosDir = path.join(root, 'assets/videos');
fs.mkdirSync(videosDir, { recursive: true });
const MAX_STORY_VIDEO_BYTES = 25 * 1024 * 1024; // 25MB — mantém a duração dos stories curta (~30s)

// Secret used to sign customer session tokens (HMAC). Set in .env, never commit it.
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

// Secret usado para assinar o token de sessão do admin — separado do SESSION_SECRET dos
// clientes de propósito, para que um token de cliente nunca possa ser reaproveitado como
// admin (e vice-versa), mesmo que a checagem de "scope" abaixo tenha algum bug.
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
const ADMIN_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias — teto no servidor; o navegador já derruba a sessão ao fechar (sessionStorage)

// Fixed-location landing page photos the admin can replace. The key ("slot") is the only
// thing the client ever sends — the real file path always comes from this whitelist, so a
// request can never write outside these exact files.
const SITE_IMAGE_SLOTS = {
  logo: { path: 'assets/img/processed/logo.png', label: 'Ícone da aba do navegador (favicon)' },
  hero_1: { path: 'assets/img/processed/site-hero-1.jpg', label: 'Capa — imagem grande' },
  hero_2: { path: 'assets/img/processed/site-hero-2.jpg', label: 'Capa — imagem 2' },
  hero_3: { path: 'assets/img/processed/site-hero-3.jpg', label: 'Capa — imagem 3' },
  sobre: { path: 'assets/img/processed/site-sobre.jpg', label: 'Seção "Sobre a By NaNa"' },
};

async function processSiteImage(buffer, destPath) {
  const ext = path.extname(destPath).toLowerCase();
  const pipeline = sharp(buffer).rotate();
  if (ext === '.png') {
    await pipeline.resize({ width: 500, withoutEnlargement: true }).png({ quality: 90 }).toFile(destPath);
  } else {
    await pipeline
      .normalize({ lower: 1, upper: 99 })
      .modulate({ brightness: 1.03, saturation: 1.05 })
      .sharpen({ sigma: 0.5 })
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(destPath);
  }
}

// Pipeline de imagem de produto (capa e galeria) — era duplicado inline em criar/atualizar
// produto; extraído aqui pra ser reaproveitado também pelos endpoints de galeria.
async function processProductImage(buffer, outPath) {
  await sharp(buffer)
    .rotate()
    .normalize({ lower: 1, upper: 99 })
    .modulate({ brightness: 1.03, saturation: 1.05 })
    .sharpen({ sigma: 0.5 })
    .resize({ width: 1000, withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outPath);
}

function decodeImageDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const match = dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
  return match ? Buffer.from(match[1], 'base64') : null;
}

const types_ = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function slugify(str) {
  const stripped = str
    .toString()
    .normalize('NFD')
    .replace(new RegExp('[̀-ͯ]', 'g'), '');
  const slug = stripped
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'peca';
}

// ---------- data access (PostgreSQL / Neon) ----------
async function getCategories() {
  const { rows } = await pool.query('SELECT name FROM categories ORDER BY id');
  return rows.map((r) => r.name);
}

async function getCollections() {
  const { rows } = await pool.query('SELECT name FROM collections ORDER BY id');
  return rows.map((r) => r.name);
}

// Produto sem nenhuma linha em product_variants não ganha variants/hasVariants=false — se comporta
// exatamente como antes (sem seletor, sem bloqueio por estoque no site).
async function attachVariants(products) {
  if (!products.length) return products;
  const { rows: variants } = await pool.query(
    `SELECT id, product_id AS "productId", size, color, sku, stock, measurements FROM product_variants ORDER BY position ASC`
  );
  const byProduct = new Map();
  variants.forEach((v) => {
    if (!byProduct.has(v.productId)) byProduct.set(v.productId, []);
    byProduct.get(v.productId).push(v);
  });
  return products.map((p) => {
    const vs = byProduct.get(p.id) || [];
    return { ...p, variants: vs, hasVariants: vs.length > 0, totalStock: vs.reduce((sum, v) => sum + v.stock, 0) };
  });
}

// resumo (média + contagem) usado nos cards da vitrine e na página de produto; produto sem
// nenhuma avaliação fica com rating null (não 0 — 0 pareceria "nota mínima", não "sem avaliação").
async function attachReviewSummary(products) {
  if (!products.length) return products;
  const { rows } = await pool.query(
    `SELECT product_id AS "productId", ROUND(AVG(rating)::numeric, 1) AS rating, COUNT(*)::int AS "reviewCount"
     FROM product_reviews GROUP BY product_id`
  );
  const byProduct = new Map(rows.map((r) => [r.productId, r]));
  return products.map((p) => {
    const summary = byProduct.get(p.id);
    return { ...p, rating: summary ? Number(summary.rating) : null, reviewCount: summary ? summary.reviewCount : 0 };
  });
}

async function getProductReviews(productId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at AS "createdAt",
            c.first_name || ' ' || left(c.last_name, 1) || '.' AS "customerName"
     FROM product_reviews r
     JOIN customers c ON c.id = r.customer_id
     WHERE r.product_id = $1
     ORDER BY r.created_at DESC`,
    [productId]
  );
  return rows;
}

async function getAllReviews() {
  const { rows } = await pool.query(
    `SELECT r.id, r.product_id AS "productId", p.name AS "productName", r.rating, r.comment,
            r.created_at AS "createdAt", c.first_name || ' ' || c.last_name AS "customerName"
     FROM product_reviews r
     JOIN customers c ON c.id = r.customer_id
     JOIN products p ON p.id = r.product_id
     ORDER BY r.created_at DESC
     LIMIT 300`
  );
  return rows;
}

async function getProductVariants(productId) {
  const { rows } = await pool.query(
    'SELECT id, size, color, sku, stock, position, measurements FROM product_variants WHERE product_id = $1 ORDER BY position ASC',
    [productId]
  );
  return rows;
}

// galeria adicional de um produto — a capa (products.img) é sempre a 1ª imagem, as extras vêm
// depois na ordem de upload; ver processProductImage() para o pipeline de processamento.
async function attachImages(products) {
  if (!products.length) return products;
  const { rows: images } = await pool.query(
    'SELECT id, product_id AS "productId", url FROM product_images ORDER BY position ASC'
  );
  const byProduct = new Map();
  images.forEach((img) => {
    if (!byProduct.has(img.productId)) byProduct.set(img.productId, []);
    byProduct.get(img.productId).push(img.url);
  });
  return products.map((p) => ({ ...p, images: [p.img, ...(byProduct.get(p.id) || [])] }));
}

async function getProductGallery(productId) {
  const { rows } = await pool.query(
    'SELECT id, url FROM product_images WHERE product_id = $1 ORDER BY position ASC',
    [productId]
  );
  return rows;
}

const defaultSizesForCategory = (category) =>
  String(category || '').toLocaleLowerCase('pt-BR').includes('calçado')
    ? ['34', '35', '36', '37', '38', '39']
    : ['P', 'M', 'G', 'GG'];

async function createDefaultVariants(client, productId, category) {
  const sizes = defaultSizesForCategory(category);
  for (let position = 0; position < sizes.length; position += 1) {
    const size = sizes[position];
    const id = `variant-${productId}-${size.toLowerCase()}`;
    const sku = `${productId}-${size}`.toUpperCase();
    await client.query(
      `INSERT INTO product_variants (id, product_id, size, sku, stock, position)
       VALUES ($1,$2,$3,$4,0,$5) ON CONFLICT DO NOTHING`,
      [id, productId, size, sku, position]
    );
  }
}

function normalizeVariantPayload(input) {
  if (!Array.isArray(input)) return null;
  const variants = input.map((variant) => {
    const size = String(variant.size || '').trim();
    const color = String(variant.color || '').trim();
    const sku = String(variant.sku || '').trim() || null;
    const stock = Math.max(0, Number.parseInt(variant.stock, 10) || 0);
    const measurements = String(variant.measurements || '').trim() || null;
    if (!size) throw new Error('Todas as variações precisam de um tamanho');
    return { id: String(variant.id || '').trim(), size, color, sku, stock, measurements };
  });
  if (!variants.length) throw new Error('Adicione ao menos um tamanho à grade');
  const combinations = new Set(variants.map((variant) =>
    `${variant.size.toLocaleLowerCase('pt-BR')}|${variant.color.toLocaleLowerCase('pt-BR')}`));
  if (combinations.size !== variants.length) throw new Error('Existem tamanhos e cores repetidos na grade');
  const skus = variants.filter((variant) => variant.sku).map((variant) => variant.sku.toLocaleLowerCase('pt-BR'));
  if (new Set(skus).size !== skus.length) throw new Error('Existem SKUs repetidos na grade');
  return variants;
}

async function syncProductVariants(client, productId, variants, adminUserId) {
  const { rows: current } = await client.query(
    'SELECT id, stock FROM product_variants WHERE product_id=$1 FOR UPDATE',
    [productId]
  );
  const currentById = new Map(current.map((variant) => [variant.id, variant]));
  const retainedIds = new Set();

  for (let position = 0; position < variants.length; position += 1) {
    const variant = variants[position];
    if (variant.id && currentById.has(variant.id)) {
      const previous = currentById.get(variant.id);
      retainedIds.add(variant.id);
      await client.query(
        'UPDATE product_variants SET size=$1, color=$2, sku=$3, stock=$4, position=$5, measurements=$6 WHERE id=$7',
        [variant.size, variant.color, variant.sku, variant.stock, position, variant.measurements, variant.id]
      );
      await recordInventoryMovement(client, {
        variantId: variant.id,
        type: 'adjustment',
        quantity: variant.stock - previous.stock,
        stockAfter: variant.stock,
        adminUserId,
        note: 'Edição completa do produto',
      });
      continue;
    }

    const id = `variant-${Date.now().toString(36)}-${position}-${Math.random().toString(36).slice(2, 7)}`;
    await client.query(
      'INSERT INTO product_variants (id, product_id, size, color, sku, stock, position, measurements) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, productId, variant.size, variant.color, variant.sku, variant.stock, position, variant.measurements]
    );
    await recordInventoryMovement(client, {
      variantId: id,
      type: 'initial',
      quantity: variant.stock,
      stockAfter: variant.stock,
      adminUserId,
      note: 'Cadastro pelo editor de produto',
    });
  }

  const removed = current.filter((variant) => !retainedIds.has(variant.id));
  if (removed.length) {
    const removedIds = removed.map((variant) => variant.id);
    const { rows: history } = await client.query(
      'SELECT variant_id AS "variantId", COUNT(*)::int AS count FROM inventory_movements WHERE variant_id = ANY($1) GROUP BY variant_id',
      [removedIds]
    );
    if (history.some((row) => row.count > 0)) {
      throw new Error('Uma variação removida possui histórico. Mantenha-a na grade com estoque zero');
    }
    await client.query('DELETE FROM product_variants WHERE id = ANY($1)', [removedIds]);
  }
}

async function recordInventoryMovement(client, { variantId, type, quantity, stockAfter, orderId = null, adminUserId = null, note = null }) {
  if (!quantity) return;
  await client.query(
    `INSERT INTO inventory_movements
       (variant_id, movement_type, quantity, stock_after, order_id, admin_user_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [variantId, type, quantity, stockAfter, orderId, adminUserId, note]
  );
}

async function getInventoryMovements(productId, limit = 40) {
  const { rows } = await pool.query(
    `SELECT m.id, m.variant_id AS "variantId", v.size, v.color, m.movement_type AS "type",
            m.quantity, m.stock_after AS "stockAfter", m.order_id AS "orderId",
            m.note, m.created_at AS "createdAt"
       FROM inventory_movements m
       JOIN product_variants v ON v.id = m.variant_id
      WHERE v.product_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [productId, limit]
  );
  return rows;
}

const ORDER_STATUS_LABELS = {
  novo: 'Recebido',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
};

const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function buildOrderConfirmationHtml({ id, customerName, items, total, deliveryMethod }) {
  const rows = items
    .map((item) => `<li>${escapeHtml(item.qty)}x ${escapeHtml(item.name)}${item.variantLabel ? ` (${escapeHtml(item.variantLabel)})` : ''}</li>`)
    .join('');
  return `
    <p>Olá, ${escapeHtml(customerName)}!</p>
    <p>Recebemos seu pedido <strong>${escapeHtml(id)}</strong> na By NaNa. Aqui está o resumo:</p>
    <ul>${rows}</ul>
    <p><strong>Total: ${money(total)}</strong></p>
    <p>Forma de entrega: ${escapeHtml(deliveryMethod)}</p>
    <p>Assim que o status do pedido mudar, avisamos por aqui.</p>
  `;
}

function buildOrderStatusHtml({ id, customerName, status }) {
  const label = ORDER_STATUS_LABELS[status] || status;
  return `
    <p>Olá, ${escapeHtml(customerName)}!</p>
    <p>O status do seu pedido <strong>${escapeHtml(id)}</strong> na By NaNa foi atualizado para: <strong>${escapeHtml(label)}</strong>.</p>
  `;
}

function buildPaymentApprovedHtml({ id, customerName }) {
  return `
    <p>Olá, ${escapeHtml(customerName)}!</p>
    <p>Recebemos a confirmação: o pagamento do seu pedido <strong>${escapeHtml(id)}</strong> foi aprovado. ✅</p>
    <p>Já vamos preparar tudo — avisamos por aqui quando o status mudar.</p>
  `;
}

function buildBackInStockHtml({ productName, variantLabel, url }) {
  return `
    <p>Boa notícia! 💛</p>
    <p><strong>${escapeHtml(productName)}${variantLabel ? ` (${escapeHtml(variantLabel)})` : ''}</strong> voltou ao estoque na By NaNa.</p>
    <p><a href="${escapeHtml(url)}">Ver a peça no site</a></p>
    <p>Como o estoque é limitado, corre lá antes que esgote de novo!</p>
  `;
}

function buildAbandonedCartHtml({ customerName, items, subtotal, origin }) {
  const rows = items.map((item) => `<li>${escapeHtml(item.qty)}x ${escapeHtml(item.name)}</li>`).join('');
  return `
    <p>Oi${customerName ? `, ${escapeHtml(customerName)}` : ''}!</p>
    <p>Você deixou algumas peças na sacola da By NaNa:</p>
    <ul>${rows}</ul>
    <p><strong>Subtotal: ${money(subtotal)}</strong></p>
    <p><a href="${escapeHtml(origin)}/">Voltar pra sacola</a></p>
  `;
}

// Chamado depois que uma variação sai de esgotada (stock 0) para disponível (stock > 0).
// Só o canal 'email' é avisado automaticamente aqui; pedidos por WhatsApp ficam pendentes
// (ver /api/admin/stock-notifications/list) pra loja chamar manualmente.
async function notifyBackInStock(variantId, origin) {
  try {
    const { rows } = await pool.query(
      `SELECT sn.id, sn.contact, p.id AS "productId", p.name AS "productName", pv.size, pv.color
       FROM stock_notifications sn
       JOIN product_variants pv ON pv.id = sn.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE sn.variant_id = $1 AND sn.channel = 'email' AND sn.notified_at IS NULL`,
      [variantId]
    );
    if (!rows.length) return;
    const label = [rows[0].size, rows[0].color].filter(Boolean).join(' / ');
    const url = `${origin}/produto/${rows[0].productId}`;
    for (const row of rows) {
      await sendEmail({
        to: row.contact,
        subject: `${row.productName} voltou ao estoque — By NaNa`,
        html: buildBackInStockHtml({ productName: row.productName, variantLabel: label, url }),
      });
      await pool.query('UPDATE stock_notifications SET notified_at = now() WHERE id = $1', [row.id]);
    }
  } catch (err) {
    // aviso de reposição nunca deve derrubar a atualização de estoque em si.
    console.error('[stock-notify] falha ao notificar reposição:', err.message);
  }
}

async function getProducts() {
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.brand, c.name AS category, COALESCE(col.name, '') AS collection,
           p.tag, p.price, p.img, p.description AS desc, p.composition,
           p.is_featured AS "isFeatured", p.featured_position AS "featuredPosition",
           p.is_upsell AS "isUpsell", p.upsell_position AS "upsellPosition"
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN collections col ON col.id = p.collection_id
    ORDER BY p.created_at DESC
  `);
  if (!rows.length) return rows;
  // attachVariants/attachImages/attachReviewSummary só dependem das linhas originais (por id),
  // não umas das outras — rodar em série (como antes) soma 3 round-trips ao Neon à toa.
  const [withVariants, withImages, withReviews] = await Promise.all([
    attachVariants(rows),
    attachImages(rows),
    attachReviewSummary(rows),
  ]);
  const variantsById = new Map(withVariants.map((p) => [p.id, { variants: p.variants, hasVariants: p.hasVariants, totalStock: p.totalStock }]));
  const imagesById = new Map(withImages.map((p) => [p.id, { images: p.images }]));
  const reviewsById = new Map(withReviews.map((p) => [p.id, { rating: p.rating, reviewCount: p.reviewCount }]));
  return rows.map((p) => ({ ...p, ...variantsById.get(p.id), ...imagesById.get(p.id), ...reviewsById.get(p.id) }));
}

// Só o necessário pra montar o <head> da página de produto (título/meta/OG/JSON-LD) no
// servidor — não passa por attachVariants/attachImages completos (caros demais pra uma
// checagem de rota), só a soma de estoque e o resumo de avaliação que o JSON-LD precisa.
async function getProductMeta(id) {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.price, p.img, p.description AS desc,
            COALESCE(v.variant_count, 0) > 0 AS "hasVariants",
            COALESCE(v.total_stock, 0) AS "totalStock",
            r.rating, r.review_count AS "reviewCount"
       FROM products p
       LEFT JOIN (
         SELECT product_id, COUNT(*) AS variant_count, SUM(stock) AS total_stock
         FROM product_variants GROUP BY product_id
       ) v ON v.product_id = p.id
       LEFT JOIN (
         SELECT product_id, ROUND(AVG(rating)::numeric, 1) AS rating, COUNT(*)::int AS review_count
         FROM product_reviews GROUP BY product_id
       ) r ON r.product_id = p.id
      WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// schema.org Product/Offer/AggregateRating — permite rich snippet (preço, disponibilidade,
// estrelas) direto no resultado de busca do Google, sem depender de nenhuma lib externa.
function buildProductJsonLd(product, { origin, canonical }) {
  const soldOut = product.hasVariants && Number(product.totalStock) <= 0;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: (product.desc || '').slice(0, 5000) || undefined,
    image: [`${origin}/${product.img}`],
    brand: { '@type': 'Brand', name: 'By NaNa' },
  };
  // "Sob consulta" (preço combinado no WhatsApp, sem valor cadastrado) não tem preço real pra
  // declarar — omitir o Offer é mais correto pro Google do que anunciar price:"0.00", que o
  // rich snippet mostraria como "grátis".
  if (product.price != null) {
    data.offers = {
      '@type': 'Offer',
      url: canonical,
      priceCurrency: 'BRL',
      price: Number(product.price).toFixed(2),
      availability: soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
    };
  }
  if (product.rating && product.reviewCount) {
    data.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(product.rating),
      reviewCount: Number(product.reviewCount),
    };
  }
  return JSON.stringify(data);
}

// "Novidades" da home: curadoria manual (is_featured) se existir alguma; senão, cai automaticamente
// nos últimos produtos cadastrados — a seção nunca fica vazia por falta de curadoria.
async function getNovidades() {
  const featured = await pool.query(`
    SELECT p.id, p.name, p.brand, c.name AS category, COALESCE(col.name, '') AS collection,
           p.tag, p.price, p.img, p.description AS desc
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN collections col ON col.id = p.collection_id
    WHERE p.is_featured = true
    ORDER BY p.featured_position ASC
  `);
  if (featured.rowCount) return attachReviewSummary(await attachVariants(featured.rows));

  const fallback = await pool.query(`
    SELECT p.id, p.name, p.brand, c.name AS category, COALESCE(col.name, '') AS collection,
           p.tag, p.price, p.img, p.description AS desc
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN collections col ON col.id = p.collection_id
    ORDER BY p.created_at DESC
    LIMIT 8
  `);
  return attachReviewSummary(await attachVariants(fallback.rows));
}

// "Leve também" na sacola: curadoria manual (is_upsell) se existir alguma; senão, cai
// automaticamente nas peças de menor preço — a faixa nunca fica vazia por falta de curadoria.
// A curadoria manual não filtra esgotados aqui (mesmo padrão de getNovidades — o cliente
// esconde na hora de renderizar, junto com o que já está na sacola); já o fallback automático
// só considera peças compráveis agora, senão o "menor preço" pode cair inteiro em itens sem
// estoque e a faixa fica vazia à toa mesmo tendo opções mais caras disponíveis.
async function getUpsellSuggestions() {
  const curated = await pool.query(`
    SELECT p.id, p.name, p.brand, c.name AS category, COALESCE(col.name, '') AS collection,
           p.tag, p.price, p.img, p.description AS desc
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN collections col ON col.id = p.collection_id
    WHERE p.is_upsell = true
    ORDER BY p.upsell_position ASC
  `);
  if (curated.rowCount) return attachReviewSummary(await attachVariants(curated.rows));

  const fallback = await pool.query(`
    SELECT p.id, p.name, p.brand, c.name AS category, COALESCE(col.name, '') AS collection,
           p.tag, p.price, p.img, p.description AS desc
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN collections col ON col.id = p.collection_id
    WHERE NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)
       OR EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.stock > 0)
    ORDER BY p.price ASC NULLS LAST
    LIMIT 8
  `);
  return attachReviewSummary(await attachVariants(fallback.rows));
}

async function getPromotions() {
  const { rows } = await pool.query(`
    SELECT pr.id, pr.scope,
           COALESCE(pr.target_product_id, cat.name, col.name, '') AS target,
           pr.discount_type AS type, pr.discount_value AS value, pr.label,
           pr.start_date AS "startDate", pr.end_date AS "endDate", pr.active
    FROM promotions pr
    LEFT JOIN categories cat ON cat.id = pr.target_category_id
    LEFT JOIN collections col ON col.id = pr.target_collection_id
    ORDER BY pr.created_at DESC
  `);
  return rows;
}

// ---------- mais vendidos (prova social na vitrine pública) ----------
// Só product_id + quantidade vendida nos últimos 90 dias — nunca receita, que é dado sensível
// de negócio e já tem seu próprio endpoint autenticado (/api/admin/reports/products). Pedidos
// cancelados não contam, e a janela de 90 dias evita que um produto antigo fique "mais vendido"
// pra sempre por causa de um pico isolado.
async function getBestSellers(limit = 8) {
  const { rows } = await pool.query(
    `SELECT item->>'id' AS "productId", SUM((item->>'qty')::int)::int AS qty
       FROM orders, jsonb_array_elements(items) AS item
      WHERE status != 'cancelado' AND created_at >= now() - interval '90 days'
      GROUP BY item->>'id'
      ORDER BY qty DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getCoupons() {
  const { rows } = await pool.query(`
    SELECT code, discount_type AS type, discount_value AS value,
           start_date AS "startDate", end_date AS "endDate", active,
           first_purchase_only AS "firstPurchaseOnly"
    FROM coupons
    ORDER BY created_at DESC
  `);
  return rows;
}

async function getShippingRules() {
  const { rows } = await pool.query(`
    SELECT id, uf, label, price, free_above AS "freeAbove", active
    FROM shipping_rules
    ORDER BY (uf = '*'), uf
  `);
  return rows;
}

// grupos usados só pelo mega-menu da vitrine; não altera o formato de getCategories().
async function getCategoryGroups() {
  const { rows } = await pool.query('SELECT name, group_name AS "groupName" FROM categories ORDER BY id');
  return rows;
}

// texto de SEO + FAQ exibidos ao final da vitrine quando a categoria está filtrada;
// só devolve categorias com algum conteúdo cadastrado, pra o front não precisar filtrar vazio.
async function getCategoryContent() {
  const { rows } = await pool.query(
    `SELECT name, seo_text AS "seoText", faq_json AS "faq" FROM categories
      WHERE COALESCE(seo_text, '') <> '' OR faq_json <> '[]'::jsonb
      ORDER BY id`
  );
  return rows;
}

function maskCpf(cpf) {
  const digits = (cpf || '').replace(/\D/g, '');
  if (digits.length < 2) return '***.***.**-**';
  return `***.***.**-${digits.slice(-2)}`;
}

async function getCustomerById(id) {
  const { rows } = await pool.query(
    `SELECT id, first_name AS "firstName", last_name AS "lastName", email, phone,
            marketing_opt_in AS "marketingOptIn"
     FROM customers WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function getCustomersForAdmin() {
  const { rows } = await pool.query(`
    SELECT id, first_name AS "firstName", last_name AS "lastName", email, phone,
           birth_date AS "birthDate", cpf, gender, marketing_opt_in AS "marketingOptIn",
           created_at AS "createdAt"
    FROM customers
    ORDER BY created_at DESC
  `);
  return rows.map((c) => ({ ...c, cpf: maskCpf(c.cpf) }));
}

async function getOrders() {
  const { rows } = await pool.query(`
    SELECT id, customer_name AS "customerName", customer_phone AS "customerPhone",
           items, subtotal, discount, shipping, total, coupon_code AS "couponCode",
           payment_method AS "paymentMethod", delivery_method AS "deliveryMethod",
           address, status, payment_status AS "paymentStatus", created_at AS "createdAt"
    FROM orders
    ORDER BY created_at DESC
    LIMIT 300
  `);
  return rows;
}

async function getCustomerOrders(customerId) {
  const { rows } = await pool.query(
    `SELECT id, items, subtotal, discount, shipping, total, coupon_code AS "couponCode",
            payment_method AS "paymentMethod", delivery_method AS "deliveryMethod",
            status, created_at AS "createdAt"
     FROM orders
     WHERE customer_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [customerId]
  );
  return rows;
}

async function getCustomerAddresses(customerId) {
  const { rows } = await pool.query(
    `SELECT id, label, cep, rua, numero, complemento, bairro, cidade, estado,
            is_default AS "isDefault"
     FROM customer_addresses
     WHERE customer_id = $1
     ORDER BY is_default DESC, created_at ASC`,
    [customerId]
  );
  return rows;
}

async function getCustomerFavorites(customerId) {
  const { rows } = await pool.query(
    'SELECT product_id AS "productId" FROM customer_favorites WHERE customer_id = $1 ORDER BY created_at DESC',
    [customerId]
  );
  return rows.map((r) => r.productId);
}

// Resolve a identidade do cliente sempre a partir do token assinado — nunca de um id
// enviado no corpo da requisição, para que ninguém possa ler/alterar dados de outra conta.
function resolveCustomerId(body) {
  const payload = verifySessionToken(body.token);
  return payload ? payload.id : null;
}

async function getStories(onlyActive) {
  const { rows } = await pool.query(`
    SELECT id, title, video, cover, link_url AS "linkUrl", link_label AS "linkLabel",
           product_id AS "productId", active, position
    FROM stories
    ${onlyActive ? 'WHERE active = true' : ''}
    ORDER BY position ASC, created_at ASC
  `);
  return rows;
}

// ---------- request helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSONBody(req, maxBytes = 15 * 1024 * 1024) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// ---------- login rate limiting (memória local — reinicia com o processo, suficiente pra
// coibir tentativa automatizada de senha sem precisar de infra extra) ----------
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_MAX = 10;
const loginAttempts = new Map();

// Mesmo raciocínio do requestOrigin() (abaixo): atrás de proxy/CDN, req.socket.remoteAddress
// é sempre o IP do proxy — sem olhar X-Forwarded-For, o rate limit vira "por e-mail" (todo
// mundo cai no mesmo balde) e uma pessoa consegue bloquear o login de outra.
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function loginRateLimited(req, email) {
  const key = `${clientIp(req)}:${email}`;
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: now });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_ATTEMPT_MAX;
}

function resetLoginAttempts(req, email) {
  loginAttempts.delete(`${clientIp(req)}:${email}`);
}

// ---------- admin auth (login multiusuário: e-mail+senha, token assinado, papéis) ----------
function signAdminSessionToken(adminUser) {
  const payload = { id: adminUser.id, role: adminUser.role, scope: 'admin', exp: Date.now() + ADMIN_SESSION_MAX_AGE_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyAdminSessionToken(token) {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(body).digest('base64url');
  const expBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.scope !== 'admin' || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

// Confere o token E consulta o banco (diferente do token de cliente, que só confere assinatura/validade):
// desativar um admin precisa derrubar o acesso dele na hora, não só quando o token expirar.
async function requireAdmin(body) {
  const payload = verifyAdminSessionToken(body.adminToken);
  if (!payload) return null;
  const { rows } = await pool.query(
    'SELECT id, name, email, role, active, notifications_seen_at AS "notificationsSeenAt" FROM admin_users WHERE id = $1',
    [payload.id]
  );
  const user = rows[0];
  if (!user || !user.active) return null;
  return user;
}

function requireOwner(admin) {
  return !!admin && admin.role === 'owner';
}

// Registra "quem fez o quê" nas ações mais relevantes — nunca derruba a requisição real se falhar.
async function logActivity(admin, action, entityType, entityId, details) {
  try {
    await pool.query(
      'INSERT INTO admin_activity_log (admin_user_id, admin_name, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [admin.id, admin.name, action, entityType || null, entityId || null, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('Falha ao registrar atividade:', err);
  }
}

async function getAdminUsers() {
  const { rows } = await pool.query(
    'SELECT id, name, email, role, active, created_at AS "createdAt" FROM admin_users ORDER BY created_at ASC'
  );
  return rows;
}

async function getActivityLog(limit = 200) {
  const { rows } = await pool.query(
    'SELECT id, admin_name AS "adminName", action, entity_type AS "entityType", entity_id AS "entityId", details, created_at AS "createdAt" FROM admin_activity_log ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}

// ---------- relatórios / dashboard (Dashboard e Relatórios compartilham estas mesmas funções) ----------
function normalizeDateRange(body) {
  const to = (body.to || '').trim() || new Date().toISOString().slice(0, 10);
  const from = (body.from || '').trim() || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from, to };
}

async function getSalesSummary(from, to) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS "orderCount", COALESCE(SUM(total), 0) AS revenue
     FROM orders
     WHERE status != 'cancelado' AND created_at >= ($1::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
       AND created_at < (($2::date + interval '1 day'))::timestamp AT TIME ZONE 'America/Sao_Paulo'`,
    [from, to]
  );
  const { orderCount, revenue } = rows[0];
  return { orderCount, revenue, avgTicket: orderCount > 0 ? revenue / orderCount : 0 };
}

async function getSalesByDay(from, to) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS date,
            COUNT(*)::int AS orders, COALESCE(SUM(total), 0) AS revenue
     FROM orders
     WHERE status != 'cancelado' AND created_at >= ($1::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND created_at < (($2::date + interval '1 day'))::timestamp AT TIME ZONE 'America/Sao_Paulo'
     GROUP BY 1 ORDER BY 1 ASC`,
    [from, to]
  );
  return rows;
}

async function getTopProducts(from, to, limit = 10) {
  const { rows } = await pool.query(
    `SELECT item->>'id' AS "productId", item->>'name' AS name,
            SUM((item->>'qty')::int)::int AS qty,
            SUM((item->>'qty')::int * (item->>'price')::numeric) AS revenue
     FROM orders, jsonb_array_elements(items) AS item
     WHERE status != 'cancelado' AND created_at >= ($1::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND created_at < (($2::date + interval '1 day'))::timestamp AT TIME ZONE 'America/Sao_Paulo'
     GROUP BY item->>'id', item->>'name'
     ORDER BY qty DESC
     LIMIT $3`,
    [from, to, limit]
  );
  return rows;
}

async function getSalesByCategory(from, to) {
  const { rows } = await pool.query(
    `SELECT COALESCE(cat.name, 'Sem categoria') AS category,
            SUM((item->>'qty')::int)::int AS qty,
            SUM((item->>'qty')::int * (item->>'price')::numeric) AS revenue
     FROM orders
     CROSS JOIN LATERAL jsonb_array_elements(items) AS item
     LEFT JOIN products p ON p.id = item->>'id'
     LEFT JOIN categories cat ON cat.id = p.category_id
     WHERE orders.status != 'cancelado' AND orders.created_at >= ($1::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND orders.created_at < (($2::date + interval '1 day'))::timestamp AT TIME ZONE 'America/Sao_Paulo'
     GROUP BY 1
     ORDER BY revenue DESC`,
    [from, to]
  );
  return rows;
}

async function getCouponUsage(from, to) {
  const { rows } = await pool.query(
    `SELECT coupon_code AS code, COUNT(*)::int AS uses, COALESCE(SUM(discount), 0) AS "totalDiscount"
     FROM orders
     WHERE coupon_code IS NOT NULL AND status != 'cancelado'
       AND created_at >= ($1::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND created_at < (($2::date + interval '1 day'))::timestamp AT TIME ZONE 'America/Sao_Paulo'
     GROUP BY coupon_code
     ORDER BY uses DESC`,
    [from, to]
  );
  return rows;
}

// item->>'promoId' só existe em pedidos feitos depois que o checkout passou a gravar essa
// atribuição — pedidos antigos simplesmente não entram nesta soma.
async function getPromotionUsage(from, to) {
  const { rows } = await pool.query(
    `SELECT o.promo_id AS "promoId", o.uses, o.qty, o.total_discount AS "totalDiscount", p.label, p.scope
     FROM (
       SELECT item->>'promoId' AS promo_id, COUNT(*)::int AS uses, SUM((item->>'qty')::int)::int AS qty,
              SUM(((item->>'listPrice')::numeric - (item->>'price')::numeric) * (item->>'qty')::int) AS total_discount
       FROM orders, jsonb_array_elements(items) AS item
       WHERE item->>'promoId' IS NOT NULL AND status != 'cancelado'
         AND created_at >= ($1::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND created_at < (($2::date + interval '1 day'))::timestamp AT TIME ZONE 'America/Sao_Paulo'
       GROUP BY item->>'promoId'
     ) o
     LEFT JOIN promotions p ON p.id = o.promo_id
     ORDER BY o.total_discount DESC`,
    [from, to]
  );
  return rows;
}

async function getNewCustomers(from, to) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS "newCustomers", COUNT(*) FILTER (WHERE marketing_opt_in)::int AS "optInCount"
     FROM customers
     WHERE created_at >= ($1::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND created_at < (($2::date + interval '1 day'))::timestamp AT TIME ZONE 'America/Sao_Paulo'`,
    [from, to]
  );
  return rows[0];
}

// ---------- customer auth (hash + sessão assinada, sem dependências novas) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function signSessionToken(customerId) {
  const payload = { id: customerId, exp: Date.now() + SESSION_MAX_AGE_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const expBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function validateDiscount(body) {
  const type = body.type === 'fixed' ? 'fixed' : 'percent';
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0) return { error: 'Informe um valor de desconto válido' };
  if (type === 'percent' && value >= 100) return { error: 'O desconto percentual deve ser menor que 100%' };
  return { type, value };
}

// ---------- API ----------
async function handleApi(req, res, pathname) {
  try {
    // Readiness check usado pela hospedagem: confirma que processo e banco estão disponíveis,
    // sem expor versão, credenciais ou detalhes internos em caso de falha.
    if (pathname === '/api/health' && req.method === 'GET') {
      try {
        await pool.query('SELECT 1');
        return sendJSON(res, 200, { status: 'ok' });
      } catch (err) {
        console.error('[health] banco indisponível:', err.message);
        return sendJSON(res, 503, { status: 'unavailable' });
      }
    }

    // config pública lida pelo front (analytics.js) — nunca inclui segredo, só os IDs de
    // rastreamento (públicos por natureza: aparecem no HTML de qualquer site que os usa).
    // Sem as env vars configuradas (cliente ainda não tem conta no Google/Meta), volta string
    // vazia e o front simplesmente não carrega nenhum script de tracking.
    if (pathname === '/api/public-config' && req.method === 'GET') {
      return sendJSON(res, 200, {
        ga4MeasurementId: process.env.GA4_MEASUREMENT_ID || '',
        metaPixelId: process.env.META_PIXEL_ID || '',
      });
    }

    // ------ newsletter (captura de contato fora de uma compra, pra campanha de e-mail/WhatsApp) ------
    if (pathname === '/api/newsletter' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const contact = String(body.contact || '').trim();
      const channel = body.channel === 'whatsapp' ? 'whatsapp' : body.channel === 'email' ? 'email' : null;
      if (!channel) return sendJSON(res, 400, { error: 'Canal inválido' });
      if (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
        return sendJSON(res, 400, { error: 'Informe um e-mail válido' });
      }
      if (channel === 'whatsapp' && contact.replace(/\D/g, '').length < 10) {
        return sendJSON(res, 400, { error: 'Informe um WhatsApp válido' });
      }
      await pool.query(
        `INSERT INTO newsletter_subscribers (id, contact, channel) VALUES ($1,$2,$3)
         ON CONFLICT (lower(contact)) DO NOTHING`,
        [crypto.randomUUID(), contact, channel]
      );
      return sendJSON(res, 201, { ok: true });
    }

    if (pathname === '/api/newsletter/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const { rows } = await pool.query(
        'SELECT id, contact, channel, source, created_at AS "createdAt" FROM newsletter_subscribers ORDER BY created_at DESC'
      );
      return sendJSON(res, 200, { subscribers: rows });
    }

    // ------ "avise-me quando chegar" (pedido de aviso de reposição por variação esgotada) ------
    if (pathname === '/api/stock-notify' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const variantId = String(body.variantId || '').trim();
      const contact = String(body.contact || '').trim();
      const channel = body.channel === 'whatsapp' ? 'whatsapp' : body.channel === 'email' ? 'email' : null;
      if (!variantId) return sendJSON(res, 400, { error: 'Variação inválida' });
      if (!channel) return sendJSON(res, 400, { error: 'Canal inválido' });
      if (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
        return sendJSON(res, 400, { error: 'Informe um e-mail válido' });
      }
      if (channel === 'whatsapp' && contact.replace(/\D/g, '').length < 10) {
        return sendJSON(res, 400, { error: 'Informe um WhatsApp válido' });
      }
      const { rows: variantRows } = await pool.query('SELECT id, stock FROM product_variants WHERE id = $1', [variantId]);
      if (!variantRows.length) return sendJSON(res, 404, { error: 'Variação não encontrada' });
      if (variantRows[0].stock > 0) return sendJSON(res, 400, { error: 'Essa variação já está disponível' });
      await pool.query(
        `INSERT INTO stock_notifications (id, variant_id, contact, channel) VALUES ($1,$2,$3,$4)
         ON CONFLICT (variant_id, lower(contact)) WHERE notified_at IS NULL DO NOTHING`,
        [crypto.randomUUID(), variantId, contact, channel]
      );
      return sendJSON(res, 201, { ok: true });
    }

    if (pathname === '/api/admin/stock-notifications/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const { rows } = await pool.query(
        `SELECT sn.id, sn.contact, sn.channel, sn.created_at AS "createdAt", p.id AS "productId", p.name AS "productName",
                pv.size, pv.color, pv.stock
         FROM stock_notifications sn
         JOIN product_variants pv ON pv.id = sn.variant_id
         JOIN products p ON p.id = pv.product_id
         WHERE sn.notified_at IS NULL
         ORDER BY sn.created_at ASC`
      );
      return sendJSON(res, 200, { stockNotifications: rows });
    }

    // Pra pedidos por WhatsApp (sem envio automático — ver notifyBackInStock em serve.js), a
    // loja chama a cliente manualmente e marca aqui como contatada pra sumir da lista.
    if (pathname === '/api/admin/stock-notifications/mark-contacted' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });
      await pool.query('UPDATE stock_notifications SET notified_at = now() WHERE id = $1', [body.id]);
      return sendJSON(res, 200, { ok: true });
    }

    // ------ carrinho abandonado (captura silenciosa pro lembrete por e-mail — ver sweepAbandonedCarts) ------
    if (pathname === '/api/cart-activity' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
      const subtotal = Number(body.subtotal);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !items.length || !Number.isFinite(subtotal)) {
        return sendJSON(res, 400, { error: 'Dados inválidos' });
      }
      const name = String(body.name || '').trim().slice(0, 120) || null;
      await pool.query(
        `INSERT INTO abandoned_carts (id, contact_email, customer_name, items, subtotal)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (lower(contact_email)) WHERE reminded_at IS NULL AND converted_at IS NULL
         DO UPDATE SET customer_name = $3, items = $4, subtotal = $5, updated_at = now()`,
        [crypto.randomUUID(), email, name, JSON.stringify(items), subtotal]
      );
      return sendJSON(res, 201, { ok: true });
    }

    // ------ catalog ------
    if (pathname === '/api/data' && req.method === 'GET') {
      const [products, categories, collections, promotions, coupons, shippingRules, categoryGroups, categoryContent, stories, novidades, upsell, bestSellers] = await Promise.all([
        getProducts(),
        getCategories(),
        getCollections(),
        getPromotions(),
        getCoupons(),
        getShippingRules(),
        getCategoryGroups(),
        getCategoryContent(),
        getStories(true),
        getNovidades(),
        getUpsellSuggestions(),
        getBestSellers(),
      ]);
      return sendJSON(res, 200, {
        products, categories, collections, promotions, coupons, shippingRules, categoryGroups,
        categoryContent, stories, novidades, upsell, bestSellers,
        whatsappNumber: (process.env.WHATSAPP_NUMBER || '5531973053380').replace(/\D/g, ''),
        onlinePaymentEnabled: !!getActiveProvider(),
      });
    }

    // ------ admin auth (login multiusuário, papéis, log de atividade) ------
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      if (!email || !password) return sendJSON(res, 400, { error: 'Informe e-mail e senha' });
      if (loginRateLimited(req, email)) {
        return sendJSON(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente' });
      }

      const { rows } = await pool.query(
        'SELECT id, name, email, password_hash AS "passwordHash", role, active FROM admin_users WHERE lower(email) = $1',
        [email]
      );
      const row = rows[0];
      if (!row || !row.active || !verifyPassword(password, row.passwordHash)) {
        return sendJSON(res, 401, { error: 'E-mail ou senha inválidos' });
      }
      resetLoginAttempts(req, email);
      const adminUser = { id: row.id, name: row.name, email: row.email, role: row.role };
      return sendJSON(res, 200, { adminUser, token: signAdminSessionToken(adminUser) });
    }

    if (pathname === '/api/admin/session' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      return sendJSON(res, 200, { adminUser: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
    }

    if (pathname === '/api/admin/users/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      return sendJSON(res, 200, { adminUsers: await getAdminUsers() });
    }

    if (pathname === '/api/admin/users' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!requireOwner(admin)) return sendJSON(res, 403, { error: 'Só o owner pode criar usuários admin' });

      const name = (body.name || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      const role = body.role === 'owner' ? 'owner' : 'staff';
      if (!name || !email || !password) return sendJSON(res, 400, { error: 'Nome, e-mail e senha são obrigatórios' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return sendJSON(res, 400, { error: 'E-mail inválido' });
      if (password.length < 8) return sendJSON(res, 400, { error: 'A senha deve ter ao menos 8 caracteres' });

      const dup = await pool.query('SELECT 1 FROM admin_users WHERE lower(email) = $1', [email]);
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Já existe um usuário admin com esse e-mail' });

      const id = crypto.randomUUID();
      await pool.query(
        'INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
        [id, name, email, hashPassword(password), role]
      );
      logActivity(admin, 'admin_user.create', 'admin_user', id, { name, email, role });
      return sendJSON(res, 201, { adminUsers: await getAdminUsers() });
    }

    if (pathname === '/api/admin/users/update' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!requireOwner(admin)) return sendJSON(res, 403, { error: 'Só o owner pode gerenciar usuários admin' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });
      if (body.id === admin.id && body.active === false) {
        return sendJSON(res, 400, { error: 'Você não pode desativar a própria conta' });
      }

      const name = (body.name || '').trim();
      const role = body.role === 'owner' ? 'owner' : 'staff';
      const active = body.active !== false;
      await pool.query(
        "UPDATE admin_users SET name = COALESCE(NULLIF($1,''), name), role = $2, active = $3 WHERE id = $4",
        [name, role, active, body.id]
      );
      logActivity(admin, 'admin_user.update', 'admin_user', body.id, { role, active });
      return sendJSON(res, 200, { adminUsers: await getAdminUsers() });
    }

    if (pathname === '/api/admin/users/password' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const currentPassword = body.currentPassword || '';
      const newPassword = body.newPassword || '';
      if (newPassword.length < 8) return sendJSON(res, 400, { error: 'A nova senha deve ter ao menos 8 caracteres' });

      const { rows } = await pool.query('SELECT password_hash AS "passwordHash" FROM admin_users WHERE id = $1', [admin.id]);
      if (!rows[0] || !verifyPassword(currentPassword, rows[0].passwordHash)) {
        return sendJSON(res, 401, { error: 'Senha atual incorreta' });
      }
      await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), admin.id]);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/activity/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      return sendJSON(res, 200, { activity: await getActivityLog() });
    }

    // ------ dashboard / relatórios ------
    if (pathname === '/api/admin/dashboard' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });

      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const prevTo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const prevFrom = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const [summary, summaryPrev, byDay, topProducts, byCategory, newCustomers, newCustomersPrev, allOrders] = await Promise.all([
        getSalesSummary(from, to),
        getSalesSummary(prevFrom, prevTo),
        getSalesByDay(from, to),
        getTopProducts(from, to, 5),
        getSalesByCategory(from, to),
        getNewCustomers(from, to),
        getNewCustomers(prevFrom, prevTo),
        getOrders(),
      ]);
      return sendJSON(res, 200, {
        summary, summaryPrev, byDay, topProducts, byCategory, newCustomers, newCustomersPrev,
        recentOrders: allOrders.slice(0, 5), from, to,
      });
    }

    if (pathname === '/api/admin/reports/sales' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const { from, to } = normalizeDateRange(body);
      const [summary, byDay] = await Promise.all([getSalesSummary(from, to), getSalesByDay(from, to)]);
      return sendJSON(res, 200, { summary, byDay, from, to });
    }

    if (pathname === '/api/admin/reports/products' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const { from, to } = normalizeDateRange(body);
      const products = await getTopProducts(from, to, 50);
      return sendJSON(res, 200, { products, from, to });
    }

    if (pathname === '/api/admin/reports/promotions' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const { from, to } = normalizeDateRange(body);
      const [coupons, promotions] = await Promise.all([getCouponUsage(from, to), getPromotionUsage(from, to)]);
      return sendJSON(res, 200, { coupons, promotions, from, to });
    }

    if (pathname === '/api/admin/reports/customers' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const { from, to } = normalizeDateRange(body);
      return sendJSON(res, 200, { summary: await getNewCustomers(from, to), from, to });
    }

    // ------ notificações internas (pedidos/clientes novos desde a última visita) ------
    if (pathname === '/api/admin/notifications' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });

      const [{ rows: orderRows }, { rows: customerRows }] = await Promise.all([
        pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE created_at > $1", [admin.notificationsSeenAt]),
        pool.query('SELECT COUNT(*)::int AS count FROM customers WHERE created_at > $1', [admin.notificationsSeenAt]),
      ]);
      return sendJSON(res, 200, { newOrders: orderRows[0].count, newCustomers: customerRows[0].count });
    }

    if (pathname === '/api/admin/notifications/seen' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      await pool.query('UPDATE admin_users SET notifications_seen_at = now() WHERE id = $1', [admin.id]);
      return sendJSON(res, 200, { ok: true });
    }

    // ------ products ------
    if (pathname === '/api/products' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });

      const name = (body.name || '').trim();
      const category = (body.category || '').trim();
      const desc = (body.desc || '').trim();
      if (!name || !category || !desc) {
        return sendJSON(res, 400, { error: 'Nome, categoria e descrição são obrigatórios' });
      }
      if (!body.image || typeof body.image !== 'string' || !body.image.startsWith('data:image/')) {
        return sendJSON(res, 400, { error: 'Envie uma foto do produto' });
      }

      const buffer = decodeImageDataUrl(body.image);
      if (!buffer) return sendJSON(res, 400, { error: 'Imagem inválida' });

      const slug = slugify(name);
      const fileName = `${slug}-${Date.now().toString(36)}.jpg`;
      const outPath = path.join(uploadDir, fileName);
      await processProductImage(buffer, outPath);

      const composition = (body.composition || '').trim() || null;
      let price = null;
      if (body.price !== null && body.price !== undefined && body.price !== '') {
        const n = Number(body.price);
        if (!Number.isNaN(n)) price = n;
      }

      const collection = (body.collection || '').trim();
      const brand = (body.brand || 'By NaNa').trim();
      const tag = (body.tag || '').trim() || 'Novidade';
      const img = `assets/img/processed/${fileName}`;
      const id = `${slug}-${Date.now().toString(36)}`;
      let variants;
      try {
        variants = normalizeVariantPayload(body.variants);
      } catch (err) {
        return sendJSON(res, 400, { error: err.message });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [category]);
        if (collection) {
          await client.query('INSERT INTO collections(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [collection]);
        }
        await client.query(
          `INSERT INTO products (id, name, brand, category_id, collection_id, tag, price, img, description, composition)
           VALUES ($1, $2, $3, (SELECT id FROM categories WHERE lower(name) = lower($4)), (SELECT id FROM collections WHERE lower(name) = lower($5)), $6, $7, $8, $9, $10)`,
          [id, name, brand, category, collection || null, tag, price, img, desc, composition]
        );
        if (variants) await syncProductVariants(client, id, variants, admin.id);
        else await createDefaultVariants(client, id, category);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return sendJSON(res, 409, { error: 'Já existe uma variação com esse tamanho/cor ou SKU' });
        return sendJSON(res, 400, { error: err.message || 'Não foi possível cadastrar o produto' });
      } finally {
        client.release();
      }

      const product = (await getProducts()).find((p) => p.id === id);
      const [categories, collections] = await Promise.all([getCategories(), getCollections()]);
      logActivity(admin, 'product.create', 'product', id, { name });
      return sendJSON(res, 201, { product, categories, collections });
    }

    if (pathname === '/api/products/update' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      const name = (body.name || '').trim();
      const category = (body.category || '').trim();
      const desc = (body.desc || '').trim();
      if (!name || !category || !desc) {
        return sendJSON(res, 400, { error: 'Nome, categoria e descrição são obrigatórios' });
      }

      let price = null;
      if (body.price !== null && body.price !== undefined && body.price !== '') {
        const n = Number(body.price);
        if (!Number.isNaN(n)) price = n;
      }
      const collection = (body.collection || '').trim();
      const brand = (body.brand || 'By NaNa').trim();
      const tag = (body.tag || '').trim() || 'Novidade';
      const composition = (body.composition || '').trim() || null;
      let variants;
      try {
        variants = normalizeVariantPayload(body.variants);
      } catch (err) {
        return sendJSON(res, 400, { error: err.message });
      }

      let img = null;
      if (body.image && typeof body.image === 'string' && body.image.startsWith('data:image/')) {
        const buffer = decodeImageDataUrl(body.image);
        if (!buffer) return sendJSON(res, 400, { error: 'Imagem inválida' });
        const slug = slugify(name);
        const fileName = `${slug}-${Date.now().toString(36)}.jpg`;
        const outPath = path.join(uploadDir, fileName);
        await processProductImage(buffer, outPath);
        img = `assets/img/processed/${fileName}`;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [category]);
        if (collection) {
          await client.query('INSERT INTO collections(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [collection]);
        }
        const { rowCount } = await client.query(
          `UPDATE products SET name=$1, brand=$2,
             category_id=(SELECT id FROM categories WHERE lower(name)=lower($3)),
             collection_id=(SELECT id FROM collections WHERE lower(name)=lower($4)),
             tag=$5, price=$6, description=$7, img=COALESCE($8, img), composition=$9
           WHERE id=$10`,
          [name, brand, category, collection || null, tag, price, desc, img, composition, body.id]
        );
        if (!rowCount) {
          await client.query('ROLLBACK');
          return sendJSON(res, 404, { error: 'Produto não encontrado' });
        }
        if (variants) await syncProductVariants(client, body.id, variants, admin.id);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return sendJSON(res, 409, { error: 'Já existe uma variação com esse tamanho/cor ou SKU' });
        return sendJSON(res, 400, { error: err.message || 'Não foi possível atualizar o produto' });
      } finally {
        client.release();
      }
      logActivity(admin, 'product.update', 'product', body.id, { name });
      return sendJSON(res, 200, { products: await getProducts() });
    }

    // ------ galeria de fotos adicionais do produto (a capa/products.img não muda aqui) ------
    const PRODUCT_GALLERY_MAX_EXTRA = 7; // 8 fotos no total, contando a capa

    if (pathname === '/api/products/images' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.productId) return sendJSON(res, 400, { error: 'productId é obrigatório' });

      const buffer = decodeImageDataUrl(body.image);
      if (!buffer) return sendJSON(res, 400, { error: 'Imagem inválida' });

      const productExists = await pool.query('SELECT 1 FROM products WHERE id = $1', [body.productId]);
      if (!productExists.rowCount) return sendJSON(res, 404, { error: 'Produto não encontrado' });

      const existing = await getProductGallery(body.productId);
      if (existing.length >= PRODUCT_GALLERY_MAX_EXTRA) {
        return sendJSON(res, 400, { error: `A galeria já tem o máximo de ${PRODUCT_GALLERY_MAX_EXTRA} fotos extras` });
      }

      const fileName = `${body.productId}-gallery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.jpg`;
      const outPath = path.join(uploadDir, fileName);
      await processProductImage(buffer, outPath);
      const url = `assets/img/processed/${fileName}`;

      const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const nextPosition = existing.length;
      try {
        await pool.query(
          'INSERT INTO product_images (id, product_id, url, position) VALUES ($1,$2,$3,$4)',
          [id, body.productId, url, nextPosition]
        );
      } catch (err) {
        if (err.code === '23503') return sendJSON(res, 404, { error: 'Produto não encontrado' });
        throw err;
      }
      logActivity(admin, 'product.images.add', 'product', body.productId, null);
      return sendJSON(res, 201, { gallery: await getProductGallery(body.productId) });
    }

    if (pathname === '/api/products/images' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      const { rows } = await pool.query('DELETE FROM product_images WHERE id = $1 RETURNING product_id AS "productId"', [body.id]);
      if (!rows.length) return sendJSON(res, 404, { error: 'Imagem não encontrada' });
      logActivity(admin, 'product.images.remove', 'product', rows[0].productId, null);
      return sendJSON(res, 200, { gallery: await getProductGallery(rows[0].productId) });
    }

    if (pathname === '/api/products/featured' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      let updated;
      if (body.featured) {
        const { rows } = await pool.query('SELECT COALESCE(MAX(featured_position), -1) AS max FROM products WHERE is_featured = true');
        updated = await pool.query('UPDATE products SET is_featured = true, featured_position = $1 WHERE id = $2', [rows[0].max + 1, body.id]);
      } else {
        updated = await pool.query('UPDATE products SET is_featured = false, featured_position = NULL WHERE id = $1', [body.id]);
      }
      if (!updated.rowCount) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      return sendJSON(res, 200, { products: await getProducts(), novidades: await getNovidades() });
    }

    if (pathname === '/api/products/featured/reorder' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const direction = body.direction === 'up' ? 'up' : body.direction === 'down' ? 'down' : null;
      if (!body.id || !direction) return sendJSON(res, 400, { error: 'id e direção são obrigatórios' });

      const { rows: featured } = await pool.query(
        'SELECT id, featured_position AS "featuredPosition" FROM products WHERE is_featured = true ORDER BY featured_position ASC'
      );
      const idx = featured.findIndex((p) => p.id === body.id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Produto não está em Novidades' });
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= featured.length) {
        return sendJSON(res, 200, { products: await getProducts(), novidades: await getNovidades() });
      }

      const a = featured[idx];
      const b = featured[swapIdx];
      await pool.query('UPDATE products SET featured_position = $1 WHERE id = $2', [b.featuredPosition, a.id]);
      await pool.query('UPDATE products SET featured_position = $1 WHERE id = $2', [a.featuredPosition, b.id]);
      return sendJSON(res, 200, { products: await getProducts(), novidades: await getNovidades() });
    }

    if (pathname === '/api/products/upsell' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      let updated;
      if (body.upsell) {
        const { rows } = await pool.query('SELECT COALESCE(MAX(upsell_position), -1) AS max FROM products WHERE is_upsell = true');
        updated = await pool.query('UPDATE products SET is_upsell = true, upsell_position = $1 WHERE id = $2', [rows[0].max + 1, body.id]);
      } else {
        updated = await pool.query('UPDATE products SET is_upsell = false, upsell_position = NULL WHERE id = $1', [body.id]);
      }
      if (!updated.rowCount) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      return sendJSON(res, 200, { products: await getProducts(), upsell: await getUpsellSuggestions() });
    }

    if (pathname === '/api/products/upsell/reorder' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const direction = body.direction === 'up' ? 'up' : body.direction === 'down' ? 'down' : null;
      if (!body.id || !direction) return sendJSON(res, 400, { error: 'id e direção são obrigatórios' });

      const { rows: upsell } = await pool.query(
        'SELECT id, upsell_position AS "upsellPosition" FROM products WHERE is_upsell = true ORDER BY upsell_position ASC'
      );
      const idx = upsell.findIndex((p) => p.id === body.id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Produto não está em Leve também' });
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= upsell.length) {
        return sendJSON(res, 200, { products: await getProducts(), upsell: await getUpsellSuggestions() });
      }

      const a = upsell[idx];
      const b = upsell[swapIdx];
      await pool.query('UPDATE products SET upsell_position = $1 WHERE id = $2', [b.upsellPosition, a.id]);
      await pool.query('UPDATE products SET upsell_position = $1 WHERE id = $2', [a.upsellPosition, b.id]);
      return sendJSON(res, 200, { products: await getProducts(), upsell: await getUpsellSuggestions() });
    }

    // ------ estoque/variação (tamanho, cor) — isolado do contrato de /api/products ------
    if (pathname === '/api/products/variants/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.productId) return sendJSON(res, 400, { error: 'productId é obrigatório' });
      return sendJSON(res, 200, {
        variants: await getProductVariants(body.productId),
        movements: await getInventoryMovements(body.productId),
        gallery: await getProductGallery(body.productId),
      });
    }

    if (pathname === '/api/products/variants' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const productId = body.productId;
      if (!productId) return sendJSON(res, 400, { error: 'productId é obrigatório' });

      const size = (body.size || '').trim() || null;
      const color = (body.color || '').trim() || null;
      const sku = (body.sku || '').trim() || null;
      const stockNum = Number(body.stock);
      const stock = Number.isFinite(stockNum) ? Math.max(0, Math.floor(stockNum)) : 0;
      if (!size) return sendJSON(res, 400, { error: 'O tamanho é obrigatório' });

      const { rows: maxRows } = await pool.query(
        'SELECT COALESCE(MAX(position), -1) AS max FROM product_variants WHERE product_id = $1',
        [productId]
      );
      const id = `variant-${Date.now().toString(36)}`;
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            'INSERT INTO product_variants (id, product_id, size, color, sku, stock, position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, productId, size, color, sku, stock, maxRows[0].max + 1]
          );
          await recordInventoryMovement(client, {
            variantId: id, type: 'initial', quantity: stock, stockAfter: stock,
            adminUserId: admin.id, note: 'Saldo inicial da variação',
          });
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        if (err.code === '23505') return sendJSON(res, 409, { error: 'Já existe uma variação com esse tamanho/cor ou SKU' });
        throw err;
      }
      logActivity(admin, 'variant.create', 'product_variant', id, { productId, size, color });
      return sendJSON(res, 201, {
        variants: await getProductVariants(productId),
        movements: await getInventoryMovements(productId),
        products: await getProducts(),
      });
    }

    if (pathname === '/api/products/variants/update' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      const size = (body.size || '').trim() || null;
      const color = (body.color || '').trim() || null;
      const sku = (body.sku || '').trim() || null;
      const stockNum = Number(body.stock);
      const stock = Number.isFinite(stockNum) ? Math.max(0, Math.floor(stockNum)) : 0;
      if (!size) return sendJSON(res, 400, { error: 'O tamanho é obrigatório' });

      try {
        const client = await pool.connect();
        let result;
        let wasOutOfStock = false;
        try {
          await client.query('BEGIN');
          const current = await client.query('SELECT stock FROM product_variants WHERE id=$1 FOR UPDATE', [body.id]);
          if (!current.rowCount) {
            await client.query('ROLLBACK');
            return sendJSON(res, 404, { error: 'Variação não encontrada' });
          }
          wasOutOfStock = current.rows[0].stock <= 0;
          result = await client.query(
            'UPDATE product_variants SET size=$1, color=$2, sku=$3, stock=$4 WHERE id=$5 RETURNING product_id AS "productId"',
            [size, color, sku, stock, body.id]
          );
          await recordInventoryMovement(client, {
            variantId: body.id, type: 'adjustment', quantity: stock - current.rows[0].stock, stockAfter: stock,
            adminUserId: admin.id, note: (body.note || '').trim() || 'Ajuste manual pelo painel',
          });
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
        logActivity(admin, 'variant.update', 'product_variant', body.id, { size, color, stock });
        if (wasOutOfStock && stock > 0) notifyBackInStock(body.id, requestOrigin(req));
        return sendJSON(res, 200, {
          variants: await getProductVariants(result.rows[0].productId),
          movements: await getInventoryMovements(result.rows[0].productId),
          products: await getProducts(),
        });
      } catch (err) {
        if (err.code === '23505') return sendJSON(res, 409, { error: 'Já existe uma variação com esse tamanho/cor ou SKU' });
        throw err;
      }
    }

    if (pathname === '/api/products/variants' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      const lookup = await pool.query('SELECT product_id AS "productId" FROM product_variants WHERE id=$1', [body.id]);
      if (!lookup.rowCount) return sendJSON(res, 404, { error: 'Variação não encontrada' });
      const productId = lookup.rows[0].productId;
      const [{ rows: countRows }, { rows: movementRows }] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS count FROM product_variants WHERE product_id=$1', [productId]),
        pool.query('SELECT COUNT(*)::int AS count FROM inventory_movements WHERE variant_id=$1', [body.id]),
      ]);
      if (countRows[0].count <= 1) {
        return sendJSON(res, 409, { error: 'O produto precisa manter ao menos um tamanho' });
      }
      if (movementRows[0].count > 0) {
        return sendJSON(res, 409, { error: 'Este tamanho possui histórico. Zere o estoque em vez de removê-lo' });
      }
      await pool.query('DELETE FROM product_variants WHERE id = $1', [body.id]);
      logActivity(admin, 'variant.delete', 'product_variant', body.id, null);
      return sendJSON(res, 200, {
        variants: await getProductVariants(productId),
        movements: await getInventoryMovements(productId),
        products: await getProducts(),
      });
    }

    if (pathname === '/api/products' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [body.id]);
      if (!rowCount) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      logActivity(admin, 'product.delete', 'product', body.id, null);
      return sendJSON(res, 200, { products: await getProducts() });
    }

    // ------ categories ------
    if (pathname === '/api/categories' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const name = (body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'Informe um nome' });

      const dup = await pool.query('SELECT 1 FROM categories WHERE lower(name) = lower($1)', [name]);
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Essa categoria já existe' });
      await pool.query('INSERT INTO categories(name) VALUES ($1)', [name]);
      return sendJSON(res, 201, { categories: await getCategories() });
    }

    if (pathname === '/api/categories' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const name = (body.name || '').trim();
      try {
        await pool.query('DELETE FROM categories WHERE lower(name) = lower($1)', [name]);
      } catch (err) {
        if (err.code === '23001' || err.code === '23503') {
          return sendJSON(res, 409, { error: 'Existem produtos cadastrados nessa categoria. Mova ou remova esses produtos antes.' });
        }
        throw err;
      }
      return sendJSON(res, 200, { categories: await getCategories() });
    }

    if (pathname === '/api/categories/group' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const name = (body.name || '').trim();
      const groupName = (body.groupName || '').trim() || null;
      if (!name) return sendJSON(res, 400, { error: 'Informe a categoria' });
      await pool.query('UPDATE categories SET group_name = $1 WHERE lower(name) = lower($2)', [groupName, name]);
      return sendJSON(res, 200, { categoryGroups: await getCategoryGroups() });
    }

    if (pathname === '/api/categories/seo' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const name = (body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'Informe a categoria' });
      const seoText = (body.seoText || '').trim();
      const faq = Array.isArray(body.faq)
        ? body.faq
            .map((f) => ({ question: (f.question || '').trim(), answer: (f.answer || '').trim() }))
            .filter((f) => f.question && f.answer)
        : [];
      await pool.query('UPDATE categories SET seo_text = $1, faq_json = $2 WHERE lower(name) = lower($3)', [
        seoText || null,
        JSON.stringify(faq),
        name,
      ]);
      return sendJSON(res, 200, { categoryContent: await getCategoryContent() });
    }

    // ------ collections ------
    if (pathname === '/api/collections' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const name = (body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'Informe um nome' });

      const dup = await pool.query('SELECT 1 FROM collections WHERE lower(name) = lower($1)', [name]);
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Essa coleção já existe' });
      await pool.query('INSERT INTO collections(name) VALUES ($1)', [name]);
      return sendJSON(res, 201, { collections: await getCollections() });
    }

    if (pathname === '/api/collections' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const name = (body.name || '').trim();
      // products in this collection just lose the tag (collection_id -> NULL), same as before
      await pool.query('DELETE FROM collections WHERE lower(name) = lower($1)', [name]);
      return sendJSON(res, 200, { collections: await getCollections() });
    }

    // ------ promotions ------
    if (pathname === '/api/promotions' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });

      const scope = body.scope;
      if (!['product', 'category', 'collection', 'site'].includes(scope)) {
        return sendJSON(res, 400, { error: 'Escopo inválido' });
      }
      const target = scope === 'site' ? '' : (body.target || '').trim();
      if (scope !== 'site' && !target) {
        return sendJSON(res, 400, { error: 'Selecione o alvo da promoção' });
      }
      const discount = validateDiscount(body);
      if (discount.error) return sendJSON(res, 400, { error: discount.error });

      const startDate = (body.startDate || '').trim() || null;
      const endDate = (body.endDate || '').trim() || null;
      if (startDate && endDate && endDate < startDate) {
        return sendJSON(res, 400, { error: 'A data final não pode ser antes da data inicial' });
      }

      let productId = null;
      let categoryId = null;
      let collectionId = null;
      if (scope === 'product') {
        const r = await pool.query('SELECT id FROM products WHERE id = $1', [target]);
        if (!r.rowCount) return sendJSON(res, 400, { error: 'Produto não encontrado' });
        productId = target;
      } else if (scope === 'category') {
        const r = await pool.query('SELECT id FROM categories WHERE lower(name) = lower($1)', [target]);
        if (!r.rowCount) return sendJSON(res, 400, { error: 'Categoria não encontrada' });
        categoryId = r.rows[0].id;
      } else if (scope === 'collection') {
        const r = await pool.query('SELECT id FROM collections WHERE lower(name) = lower($1)', [target]);
        if (!r.rowCount) return sendJSON(res, 400, { error: 'Coleção não encontrada' });
        collectionId = r.rows[0].id;
      }

      const id = `promo-${Date.now().toString(36)}`;
      await pool.query(
        `INSERT INTO promotions (id, scope, target_product_id, target_category_id, target_collection_id, discount_type, discount_value, label, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, scope, productId, categoryId, collectionId, discount.type, discount.value, (body.label || '').trim(), startDate, endDate]
      );
      logActivity(admin, 'promotion.create', 'promotion', id, { scope, target });
      return sendJSON(res, 201, { promotions: await getPromotions() });
    }

    if (pathname === '/api/promotions/update' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      const scope = body.scope;
      if (!['product', 'category', 'collection', 'site'].includes(scope)) {
        return sendJSON(res, 400, { error: 'Escopo inválido' });
      }
      const target = scope === 'site' ? '' : (body.target || '').trim();
      if (scope !== 'site' && !target) {
        return sendJSON(res, 400, { error: 'Selecione o alvo da promoção' });
      }
      const discount = validateDiscount(body);
      if (discount.error) return sendJSON(res, 400, { error: discount.error });

      const startDate = (body.startDate || '').trim() || null;
      const endDate = (body.endDate || '').trim() || null;
      if (startDate && endDate && endDate < startDate) {
        return sendJSON(res, 400, { error: 'A data final não pode ser antes da data inicial' });
      }

      let productId = null;
      let categoryId = null;
      let collectionId = null;
      if (scope === 'product') {
        const r = await pool.query('SELECT id FROM products WHERE id = $1', [target]);
        if (!r.rowCount) return sendJSON(res, 400, { error: 'Produto não encontrado' });
        productId = target;
      } else if (scope === 'category') {
        const r = await pool.query('SELECT id FROM categories WHERE lower(name) = lower($1)', [target]);
        if (!r.rowCount) return sendJSON(res, 400, { error: 'Categoria não encontrada' });
        categoryId = r.rows[0].id;
      } else if (scope === 'collection') {
        const r = await pool.query('SELECT id FROM collections WHERE lower(name) = lower($1)', [target]);
        if (!r.rowCount) return sendJSON(res, 400, { error: 'Coleção não encontrada' });
        collectionId = r.rows[0].id;
      }

      const { rowCount } = await pool.query(
        `UPDATE promotions SET scope=$1, target_product_id=$2, target_category_id=$3, target_collection_id=$4,
           discount_type=$5, discount_value=$6, label=$7, start_date=$8, end_date=$9
         WHERE id=$10`,
        [scope, productId, categoryId, collectionId, discount.type, discount.value, (body.label || '').trim(), startDate, endDate, body.id]
      );
      if (!rowCount) return sendJSON(res, 404, { error: 'Promoção não encontrada' });
      logActivity(admin, 'promotion.update', 'promotion', body.id, { scope, target });
      return sendJSON(res, 200, { promotions: await getPromotions() });
    }

    if (pathname === '/api/promotions' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });
      await pool.query('DELETE FROM promotions WHERE id = $1', [body.id]);
      logActivity(admin, 'promotion.delete', 'promotion', body.id, null);
      return sendJSON(res, 200, { promotions: await getPromotions() });
    }

    // ------ coupons ------
    if (pathname === '/api/coupons' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });

      const code = (body.code || '').trim().toUpperCase();
      if (!code) return sendJSON(res, 400, { error: 'Informe um código para o cupom' });
      // Restringe o charset (defesa em profundidade além do escapeHtml no front): o código do
      // cupom é exibido sem contexto de "produto"/"admin" em vários lugares (sacola do
      // cliente, lista no painel) — travar aqui elimina de vez a classe de bug, não só sintoma.
      if (!/^[A-Z0-9_-]{1,30}$/.test(code)) {
        return sendJSON(res, 400, { error: 'O código do cupom deve conter só letras, números, "-" ou "_" (até 30 caracteres)' });
      }
      const discount = validateDiscount(body);
      if (discount.error) return sendJSON(res, 400, { error: discount.error });
      const endDate = (body.endDate || '').trim() || null;
      const firstPurchaseOnly = !!body.firstPurchaseOnly;

      const dup = await pool.query('SELECT 1 FROM coupons WHERE code = $1', [code]);
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Já existe um cupom com esse código' });

      await pool.query(
        'INSERT INTO coupons (code, discount_type, discount_value, end_date, first_purchase_only) VALUES ($1,$2,$3,$4,$5)',
        [code, discount.type, discount.value, endDate, firstPurchaseOnly]
      );
      logActivity(admin, 'coupon.create', 'coupon', code, null);
      return sendJSON(res, 201, { coupons: await getCoupons() });
    }

    if (pathname === '/api/coupons/update' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const code = (body.code || '').trim().toUpperCase();
      if (!code) return sendJSON(res, 400, { error: 'Cupom não encontrado' });
      if (!/^[A-Z0-9_-]{1,30}$/.test(code)) {
        return sendJSON(res, 400, { error: 'Cupom não encontrado' });
      }
      const discount = validateDiscount(body);
      if (discount.error) return sendJSON(res, 400, { error: discount.error });
      const endDate = (body.endDate || '').trim() || null;
      const firstPurchaseOnly = !!body.firstPurchaseOnly;

      const { rowCount } = await pool.query(
        'UPDATE coupons SET discount_type=$1, discount_value=$2, end_date=$3, first_purchase_only=$4 WHERE code=$5',
        [discount.type, discount.value, endDate, firstPurchaseOnly, code]
      );
      if (!rowCount) return sendJSON(res, 404, { error: 'Cupom não encontrado' });
      logActivity(admin, 'coupon.update', 'coupon', code, null);
      return sendJSON(res, 200, { coupons: await getCoupons() });
    }

    if (pathname === '/api/coupons' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const code = (body.code || '').trim().toUpperCase();
      if (!code) return sendJSON(res, 400, { error: 'code é obrigatório' });
      await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
      logActivity(admin, 'coupon.delete', 'coupon', code, null);
      return sendJSON(res, 200, { coupons: await getCoupons() });
    }

    // ------ shipping rules (frete por UF, usado no checkout do site) ------
    if (pathname === '/api/shipping-rules' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });

      const uf = (body.uf || '').trim().toUpperCase();
      if (uf !== '*' && !/^[A-Z]{2}$/.test(uf)) {
        return sendJSON(res, 400, { error: 'Informe uma UF válida (2 letras) ou "*" para a regra padrão' });
      }
      const price = Number(body.price);
      if (!Number.isFinite(price) || price < 0) return sendJSON(res, 400, { error: 'Informe um valor de frete válido' });
      const freeAboveRaw = body.freeAbove === '' || body.freeAbove == null ? null : Number(body.freeAbove);
      if (freeAboveRaw != null && (!Number.isFinite(freeAboveRaw) || freeAboveRaw < 0)) {
        return sendJSON(res, 400, { error: 'Informe um valor válido para frete grátis acima de' });
      }
      const label = (body.label || '').trim();

      const dup = await pool.query('SELECT 1 FROM shipping_rules WHERE upper(uf) = $1', [uf]);
      if (dup.rowCount) return sendJSON(res, 409, { error: uf === '*' ? 'Já existe uma regra padrão' : `Já existe uma regra para ${uf}` });

      await pool.query(
        'INSERT INTO shipping_rules (uf, label, price, free_above) VALUES ($1,$2,$3,$4)',
        [uf, label, price, freeAboveRaw]
      );
      logActivity(admin, 'shipping_rule.create', 'shipping_rule', uf, null);
      return sendJSON(res, 201, { shippingRules: await getShippingRules() });
    }

    if (pathname === '/api/shipping-rules/update' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const id = Number(body.id);
      if (!id) return sendJSON(res, 400, { error: 'Regra não encontrada' });

      const price = Number(body.price);
      if (!Number.isFinite(price) || price < 0) return sendJSON(res, 400, { error: 'Informe um valor de frete válido' });
      const freeAboveRaw = body.freeAbove === '' || body.freeAbove == null ? null : Number(body.freeAbove);
      if (freeAboveRaw != null && (!Number.isFinite(freeAboveRaw) || freeAboveRaw < 0)) {
        return sendJSON(res, 400, { error: 'Informe um valor válido para frete grátis acima de' });
      }
      const label = (body.label || '').trim();
      const active = body.active !== false;

      const { rowCount } = await pool.query(
        'UPDATE shipping_rules SET label=$1, price=$2, free_above=$3, active=$4 WHERE id=$5',
        [label, price, freeAboveRaw, active, id]
      );
      if (!rowCount) return sendJSON(res, 404, { error: 'Regra não encontrada' });
      logActivity(admin, 'shipping_rule.update', 'shipping_rule', String(id), null);
      return sendJSON(res, 200, { shippingRules: await getShippingRules() });
    }

    if (pathname === '/api/shipping-rules' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const id = Number(body.id);
      if (!Number.isFinite(id)) return sendJSON(res, 400, { error: 'id é obrigatório' });
      await pool.query('DELETE FROM shipping_rules WHERE id = $1', [id]);
      logActivity(admin, 'shipping_rule.delete', 'shipping_rule', String(id), null);
      return sendJSON(res, 200, { shippingRules: await getShippingRules() });
    }

    // ------ orders (pedidos fechados no checkout do site, antes de abrir o WhatsApp) ------
    if (pathname === '/api/orders' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerName = (body.customerName || '').trim();
      const customerPhone = (body.customerPhone || '').trim();
      const customerEmailRaw = (body.customerEmail || '').trim();
      const customerEmail = /^\S+@\S+\.\S+$/.test(customerEmailRaw) ? customerEmailRaw : null;
      const paymentMethod = (body.paymentMethod || '').trim();
      const deliveryMethod = (body.deliveryMethod || '').trim();
      const rawItems = Array.isArray(body.items) ? body.items : [];
      if (!customerName || !customerPhone || !paymentMethod || !deliveryMethod || !rawItems.length) {
        return sendJSON(res, 400, { error: 'Dados do pedido incompletos' });
      }
      if (!['Entrega', 'Retirada em loja'].includes(deliveryMethod)) {
        return sendJSON(res, 400, { error: 'Forma de entrega inválida' });
      }
      const couponCodeInput = (body.couponCode || '').trim().toUpperCase() || null;
      const address = body.address && typeof body.address === 'object' ? body.address : null;

      let customerId = null;
      if (body.customerToken) {
        const payload = verifySessionToken(body.customerToken);
        if (payload) customerId = payload.id;
      }

      // Preço, cupom, frete e total nunca são aceitos do navegador — sempre recalculados aqui a
      // partir do preço/promoção vigentes no banco, com a mesma regra de negócio do front
      // (assets/js/promo.js), pra um pedido não poder ser fechado com desconto/total desatualizado
      // ou manipulado no cliente.
      const [promotions, coupons, shippingRules] = await Promise.all([getPromotions(), getCoupons(), getShippingRules()]);
      let coupon = PromoEngine.findCoupon(coupons, couponCodeInput);

      // cupom "só 1ª compra": vale pra quem nunca teve um pedido não-cancelado — por
      // customer_id quando logada, senão pelo telefone informado (visitante). Em vez de
      // rejeitar o pedido inteiro, só descarta o cupom (mesmo tratamento de "cupom expirou"
      // que o carrinho já faz) pra não travar o fechamento por causa de um desconto extra.
      if (coupon && coupon.firstPurchaseOnly) {
        const priorOrder = customerId
          ? await pool.query("SELECT 1 FROM orders WHERE customer_id = $1 AND status != 'cancelado' LIMIT 1", [customerId])
          : await pool.query("SELECT 1 FROM orders WHERE customer_phone = $1 AND status != 'cancelado' LIMIT 1", [customerPhone]);
        if (priorOrder.rowCount) coupon = null;
      }

      const id = `pedido-${Date.now().toString(36)}`;
      const client = await pool.connect();
      let items;
      let subtotal;
      let discountAmount;
      let shippingCost;
      let total;
      let isOnlinePayment;
      try {
        await client.query('BEGIN');
        items = [];
        for (const item of rawItems) {
          const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
          if (!item.variantId || !qty) {
            await client.query('ROLLBACK');
            return sendJSON(res, 400, { error: `Escolha um tamanho válido para ${item.name || 'o produto'}` });
          }
          const locked = await client.query(
            `SELECT v.id, v.stock, v.size, p.id AS "productId", p.name, p.price,
                    c.name AS category, COALESCE(col.name, '') AS collection
               FROM product_variants v
               JOIN products p ON p.id = v.product_id
               JOIN categories c ON c.id = p.category_id
               LEFT JOIN collections col ON col.id = p.collection_id
              WHERE v.id = $1 FOR UPDATE OF v`,
            [item.variantId]
          );
          const variant = locked.rows[0];
          if (!variant || variant.productId !== item.id) {
            await client.query('ROLLBACK');
            return sendJSON(res, 400, { error: `Tamanho inválido para ${item.name || 'o produto'}` });
          }
          if (variant.stock < qty) {
            await client.query('ROLLBACK');
            return sendJSON(res, 409, {
              error: `${variant.name} — tamanho ${variant.size}: somente ${variant.stock} unidade(s) disponível(is)`,
            });
          }
          const stockAfter = variant.stock - qty;
          await client.query('UPDATE product_variants SET stock=$1 WHERE id=$2', [stockAfter, variant.id]);
          await recordInventoryMovement(client, {
            variantId: variant.id, type: 'sale', quantity: -qty, stockAfter, orderId: id,
            note: `Reserva do pedido ${id}`,
          });

          const best = variant.price != null && promotions.length
            ? PromoEngine.bestPromoForProduct({ id: variant.productId, price: variant.price, category: variant.category, collection: variant.collection }, promotions)
            : null;
          items.push({
            id: variant.productId,
            name: variant.name,
            qty,
            price: variant.price == null ? null : (best ? best.price : variant.price),
            listPrice: variant.price,
            promoId: best ? best.promo.id : null,
            variantId: variant.id,
            variantLabel: typeof item.variantLabel === 'string' ? item.variantLabel : null,
          });
        }

        const itemCount = items.reduce((sum, it) => sum + (it.price != null ? it.qty : 0), 0);
        subtotal = items.reduce((sum, it) => sum + (it.price != null ? it.price * it.qty : 0), 0);
        const discountInfo = PromoEngine.bestDiscount(subtotal, { coupon, itemCount, payment: paymentMethod });
        discountAmount = discountInfo ? discountInfo.amount : 0;

        shippingCost = 0;
        if (deliveryMethod === 'Entrega') {
          const activeRules = shippingRules.filter((r) => r.active);
          const uf = ((address && address.estado) || '').trim().toUpperCase();
          const rule = activeRules.find((r) => r.uf.toUpperCase() === uf) || activeRules.find((r) => r.uf === '*');
          if (rule) {
            const free = rule.freeAbove != null && subtotal >= Number(rule.freeAbove);
            shippingCost = free ? 0 : Number(rule.price);
          }
        }
        total = Math.max(0, subtotal - discountAmount) + shippingCost;

        // Sem provedor configurado, ou quando a cliente escolheu uma forma de pagamento manual
        // (Pix combinado, dinheiro etc.), o pedido nasce 'manual' e o pagamento segue combinado
        // no WhatsApp, como sempre foi. Só nasce 'pending' quando há gateway ativo E a cliente
        // pediu pagamento online — nesse caso a preferência de checkout é criada depois do
        // COMMIT (ver isOnlinePayment abaixo), sem segurar a reserva de estoque por causa de
        // uma chamada de rede pro Mercado Pago.
        const paymentProvider = getActiveProvider();
        isOnlinePayment = !!paymentProvider && paymentMethod === ONLINE_PAYMENT_METHOD;
        const paymentStatus = isOnlinePayment ? 'pending' : 'manual';

        await client.query(
          `INSERT INTO orders (id, customer_id, customer_name, customer_phone, email, items, subtotal, discount, shipping, total, coupon_code, payment_method, delivery_method, address, payment_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [id, customerId, customerName, customerPhone, customerEmail, JSON.stringify(items), subtotal, discountAmount, shippingCost, total, coupon ? coupon.code : null, paymentMethod, deliveryMethod, address ? JSON.stringify(address) : null, paymentStatus]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      if (customerEmail) {
        await sendEmail({
          to: customerEmail,
          subject: `Pedido ${id} confirmado — By NaNa`,
          html: buildOrderConfirmationHtml({ id, customerName, items, total, deliveryMethod }),
        });
        // pedido concluído com esse e-mail: encerra a linha de carrinho abandonado (se houver)
        // pra não mandar lembrete de uma compra que já aconteceu.
        pool.query(
          "UPDATE abandoned_carts SET converted_at = now() WHERE lower(contact_email) = lower($1) AND converted_at IS NULL",
          [customerEmail]
        ).catch((err) => console.error('[abandoned-carts] falha ao marcar conversão:', err.message));
      }

      // Preferência de checkout criada depois do COMMIT (estoque já reservado, pedido já
      // existe) — se a chamada pro Mercado Pago falhar (rede, credencial errada...), a compra
      // não trava: cai pro fluxo manual de sempre (sem checkoutUrl, o front abre o WhatsApp).
      let checkoutUrl;
      if (isOnlinePayment) {
        try {
          const session = await getActiveProvider().createCheckoutSession({ orderId: id, total, customerName, customerEmail, items });
          checkoutUrl = session.checkoutUrl;
          if (session.providerReference) {
            await pool.query('UPDATE orders SET payment_reference = $1 WHERE id = $2', [session.providerReference, id]);
          }
        } catch (err) {
          console.error('[mercadopago] falha ao criar checkout, caindo para o fluxo manual:', err.message);
          // O pedido nasceu 'pending' (ver isOnlinePayment acima) esperando essa preferência dar
          // certo; sem checkoutUrl a compra segue pelo WhatsApp, então o registro tem que voltar
          // a refletir isso — senão fica "pendente" pra sempre sem nenhum jeito de ser pago.
          await pool.query("UPDATE orders SET payment_status = 'manual' WHERE id = $1", [id]);
        }
      }

      return sendJSON(res, 201, { orderId: id, checkoutUrl });
    }

    // ------ webhook do gateway de pagamento (confirma pagamento assíncrono do checkout online) ------
    // Rota genérica /api/webhooks/<chave> — só processa quando <chave> bate com o
    // PAYMENT_PROVIDER ativo no momento; qualquer outra coisa (gateway trocado/desligado depois
    // que a notificação foi enfileirada, provedor desconhecido) só recebe 200 e é ignorada, que
    // é a resposta esperada pelo provedor pra não ficar re-tentando a notificação para sempre.
    if (pathname.startsWith('/api/webhooks/') && req.method === 'POST') {
      const providerKey = pathname.slice('/api/webhooks/'.length);
      const provider = getActiveProvider();
      if (!provider || providerKey !== (process.env.PAYMENT_PROVIDER || '').trim()) {
        return sendJSON(res, 200, { ok: true });
      }

      // O corpo não é usado (a notificação só carrega type/data.id, tratados via query string —
      // ver mercadopago.js), mas precisa ser drenado mesmo assim pra não travar a keep-alive
      // connection numa requisição HTTP1 seguinte.
      await readBody(req, 1024 * 1024).catch(() => {});

      let result;
      try {
        result = await provider.handleWebhook(req);
      } catch (err) {
        // Erro nosso ou instabilidade do provedor: loga e ainda assim reconhece com 200 — um
        // 5xx aqui só faria o provedor re-enviar a mesma notificação, sem chance de dar certo
        // numa próxima tentativa se o bug for nosso.
        console.error(`[webhook ${providerKey}] falha ao processar notificação:`, err.message);
        return sendJSON(res, 200, { ok: true });
      }
      if (result === null) return sendJSON(res, 401, { error: 'assinatura inválida' });
      if (!result || result.ignored || !result.orderId || !result.status) {
        return sendJSON(res, 200, { ok: true });
      }

      const { orderId, status, providerReference } = result;
      const client = await pool.connect();
      let order;
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT payment_status AS "paymentStatus", email, customer_name AS "customerName"
             FROM orders WHERE id = $1 FOR UPDATE`,
          [orderId]
        );
        if (!rows.length) {
          await client.query('ROLLBACK');
          return sendJSON(res, 200, { ok: true });
        }
        order = rows[0];
        await client.query(
          `UPDATE orders SET payment_status = $1, payment_reference = COALESCE($2, payment_reference),
                  paid_at = CASE WHEN $1 = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END
            WHERE id = $3`,
          [status, providerReference || null, orderId]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      if (status === 'paid' && order.paymentStatus !== 'paid' && order.email) {
        await sendEmail({
          to: order.email,
          subject: `Pagamento aprovado — pedido ${orderId} — By NaNa`,
          html: buildPaymentApprovedHtml({ id: orderId, customerName: order.customerName }),
        });
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/orders/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      return sendJSON(res, 200, { orders: await getOrders() });
    }

    if (pathname === '/api/orders/status' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const status = body.status;
      if (!['novo', 'em_andamento', 'concluido', 'cancelado'].includes(status)) {
        return sendJSON(res, 400, { error: 'Status inválido' });
      }
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });
      const client = await pool.connect();
      let order;
      let statusChanged;
      try {
        await client.query('BEGIN');
        const orderResult = await client.query(
          'SELECT status, items, email, customer_name AS "customerName" FROM orders WHERE id=$1 FOR UPDATE',
          [body.id]
        );
        if (!orderResult.rowCount) {
          await client.query('ROLLBACK');
          return sendJSON(res, 404, { error: 'Pedido não encontrado' });
        }
        order = orderResult.rows[0];
        statusChanged = order.status !== status;
        const items = Array.isArray(order.items) ? order.items : [];
        if (order.status !== 'cancelado' && status === 'cancelado') {
          for (const item of items) {
            if (!item.variantId) continue;
            const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
            const updated = await client.query(
              'UPDATE product_variants SET stock=stock+$1 WHERE id=$2 RETURNING stock',
              [qty, item.variantId]
            );
            if (updated.rowCount) {
              await recordInventoryMovement(client, {
                variantId: item.variantId, type: 'cancellation', quantity: qty,
                stockAfter: updated.rows[0].stock, orderId: body.id, adminUserId: admin.id,
                note: `Cancelamento do pedido ${body.id}`,
              });
            }
          }
        } else if (order.status === 'cancelado' && status !== 'cancelado') {
          for (const item of items) {
            if (!item.variantId) continue;
            const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
            const locked = await client.query('SELECT stock FROM product_variants WHERE id=$1 FOR UPDATE', [item.variantId]);
            if (!locked.rowCount || locked.rows[0].stock < qty) {
              await client.query('ROLLBACK');
              return sendJSON(res, 409, { error: `Estoque insuficiente para reativar ${item.name}` });
            }
            const stockAfter = locked.rows[0].stock - qty;
            await client.query('UPDATE product_variants SET stock=$1 WHERE id=$2', [stockAfter, item.variantId]);
            await recordInventoryMovement(client, {
              variantId: item.variantId, type: 'sale', quantity: -qty, stockAfter,
              orderId: body.id, adminUserId: admin.id, note: `Reativação do pedido ${body.id}`,
            });
          }
        }
        await client.query('UPDATE orders SET status = $1 WHERE id = $2', [status, body.id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      logActivity(admin, 'order.status_update', 'order', body.id, { status });
      if (statusChanged && order.email) {
        await sendEmail({
          to: order.email,
          subject: `Pedido ${body.id} atualizado — By NaNa`,
          html: buildOrderStatusHtml({ id: body.id, customerName: order.customerName, status }),
        });
      }
      return sendJSON(res, 200, { orders: await getOrders() });
    }

    // ------ customers (cadastro/login público + CRM no admin) ------
    if (pathname === '/api/customers' && req.method === 'POST') {
      // Sem isso, a checagem de duplicidade abaixo (que confirma se um e-mail/CPF já é
      // cliente) vira um oráculo de força bruta: um atacante testa CPFs em lote sem limite
      // de tentativas para descobrir quem já comprou na loja.
      if (loginRateLimited(req, 'signup')) {
        return sendJSON(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente' });
      }
      const body = await readJSONBody(req);

      const firstName = (body.firstName || '').trim();
      const lastName = (body.lastName || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      const phone = (body.phone || '').trim();
      const birthDate = (body.birthDate || '').trim();
      const cpf = (body.cpf || '').replace(/\D/g, '');
      const password = body.password || '';
      const gender = ['feminino', 'masculino'].includes(body.gender) ? body.gender : 'nao_informado';
      const marketingOptIn = body.marketingOptIn === true;

      if (!firstName || !lastName || !email || !phone || !birthDate || !cpf || !password) {
        return sendJSON(res, 400, { error: 'Preencha todos os campos obrigatórios' });
      }
      if (!/^\S+@\S+\.\S+$/.test(email)) return sendJSON(res, 400, { error: 'E-mail inválido' });
      if (!isValidCPF(cpf)) return sendJSON(res, 400, { error: 'CPF inválido' });
      if (password.length < 8) return sendJSON(res, 400, { error: 'A senha deve ter ao menos 8 caracteres' });
      if (body.privacyAccepted !== true) {
        return sendJSON(res, 400, { error: 'É preciso aceitar a política de privacidade' });
      }

      const dup = await pool.query(
        'SELECT 1 FROM customers WHERE lower(email) = $1 OR cpf = $2',
        [email, cpf]
      );
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Já existe uma conta com esse e-mail ou CPF' });

      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO customers (id, first_name, last_name, email, phone, birth_date, cpf, gender, password_hash, marketing_opt_in)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, firstName, lastName, email, phone, birthDate, cpf, gender, hashPassword(password), marketingOptIn]
      );

      const customer = { id, firstName, lastName, email, phone, marketingOptIn };
      return sendJSON(res, 201, { customer, token: signSessionToken(id) });
    }

    if (pathname === '/api/customers' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });
      await pool.query('DELETE FROM customers WHERE id = $1', [body.id]);
      logActivity(admin, 'customer.delete', 'customer', body.id, null);
      return sendJSON(res, 200, { customers: await getCustomersForAdmin() });
    }

    if (pathname === '/api/customers/login' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      if (!email || !password) return sendJSON(res, 400, { error: 'Informe e-mail e senha' });
      if (loginRateLimited(req, email)) {
        return sendJSON(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente' });
      }

      const { rows } = await pool.query(
        'SELECT id, first_name AS "firstName", last_name AS "lastName", email, phone, marketing_opt_in AS "marketingOptIn", password_hash AS "passwordHash" FROM customers WHERE lower(email) = $1',
        [email]
      );
      const row = rows[0];
      if (!row || !verifyPassword(password, row.passwordHash)) {
        return sendJSON(res, 401, { error: 'E-mail ou senha inválidos' });
      }
      resetLoginAttempts(req, email);
      // eslint-disable-next-line no-unused-vars -- descarta passwordHash de propósito, pra nunca ir na resposta ao cliente.
      const { passwordHash, ...customer } = row;
      return sendJSON(res, 200, { customer, token: signSessionToken(customer.id) });
    }

    if (pathname === '/api/customers/session' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const payload = verifySessionToken(body.token);
      if (!payload) return sendJSON(res, 401, { error: 'Sessão inválida' });
      const customer = await getCustomerById(payload.id);
      if (!customer) return sendJSON(res, 401, { error: 'Sessão inválida' });
      return sendJSON(res, 200, { customer });
    }

    if (pathname === '/api/customers/update' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });

      const firstName = (body.firstName || '').trim();
      const lastName = (body.lastName || '').trim();
      const phone = (body.phone || '').trim();
      if (!firstName || !lastName || !phone) {
        return sendJSON(res, 400, { error: 'Nome, sobrenome e telefone são obrigatórios' });
      }
      const marketingOptIn = body.marketingOptIn === true;

      await pool.query(
        'UPDATE customers SET first_name = $1, last_name = $2, phone = $3, marketing_opt_in = $4 WHERE id = $5',
        [firstName, lastName, phone, marketingOptIn, customerId]
      );
      return sendJSON(res, 200, { customer: await getCustomerById(customerId) });
    }

    if (pathname === '/api/customers/password' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });

      const currentPassword = body.currentPassword || '';
      const newPassword = body.newPassword || '';
      if (newPassword.length < 8) return sendJSON(res, 400, { error: 'A nova senha deve ter ao menos 8 caracteres' });

      const { rows } = await pool.query('SELECT password_hash AS "passwordHash" FROM customers WHERE id = $1', [customerId]);
      if (!rows[0] || !verifyPassword(currentPassword, rows[0].passwordHash)) {
        return sendJSON(res, 401, { error: 'Senha atual incorreta' });
      }
      await pool.query('UPDATE customers SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), customerId]);
      return sendJSON(res, 200, { ok: true });
    }

    // "Esqueci minha senha": resposta sempre genérica (não revela se o e-mail existe), token
    // aleatório com validade curta gravado no próprio cliente — sem tabela extra.
    if (pathname === '/api/customers/forgot-password' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const email = (body.email || '').trim().toLowerCase();
      if (email && loginRateLimited(req, `forgot:${email}`)) {
        return sendJSON(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente' });
      }
      if (email) {
        const { rows } = await pool.query(
          'SELECT id, first_name AS "firstName" FROM customers WHERE lower(email) = $1',
          [email]
        );
        const customer = rows[0];
        if (customer) {
          const token = crypto.randomBytes(32).toString('hex');
          await pool.query(
            `UPDATE customers SET reset_token = $1, reset_token_expires = now() + interval '1 hour' WHERE id = $2`,
            [token, customer.id]
          );
          const link = `${requestOrigin(req)}/redefinir-senha.html?token=${token}`;
          await sendEmail({
            to: email,
            subject: 'Redefinição de senha — By NaNa',
            html: `<p>Olá, ${escapeHtml(customer.firstName)}!</p><p>Clique no link abaixo para definir uma nova senha. Ele expira em 1 hora.</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>Se você não pediu isso, ignore este e-mail.</p>`,
          });
        }
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/customers/reset-password' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const token = (body.token || '').trim();
      const newPassword = body.newPassword || '';
      if (!token) return sendJSON(res, 400, { error: 'Token inválido' });
      if (newPassword.length < 8) return sendJSON(res, 400, { error: 'A nova senha deve ter ao menos 8 caracteres' });

      const { rows } = await pool.query(
        `SELECT id FROM customers WHERE reset_token = $1 AND reset_token_expires > now()`,
        [token]
      );
      if (!rows[0]) return sendJSON(res, 400, { error: 'Link inválido ou expirado. Solicite a redefinição novamente.' });

      await pool.query(
        'UPDATE customers SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
        [hashPassword(newPassword), rows[0].id]
      );
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/customers/orders' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      return sendJSON(res, 200, { orders: await getCustomerOrders(customerId) });
    }

    // ------ avaliações de produto (só quem comprou; visível na hora, sem moderação prévia) ------
    if (pathname === '/api/reviews/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const productId = (body.productId || '').trim();
      if (!productId) return sendJSON(res, 400, { error: 'productId é obrigatório' });
      return sendJSON(res, 200, { reviews: await getProductReviews(productId) });
    }

    if (pathname === '/api/reviews' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Entre na sua conta para avaliar esse produto' });

      const productId = (body.productId || '').trim();
      const rating = Math.round(Number(body.rating));
      const comment = (body.comment || '').trim().slice(0, 1000);
      if (!productId) return sendJSON(res, 400, { error: 'Produto inválido' });
      if (!Number.isFinite(rating) || rating < 1 || rating > 5) return sendJSON(res, 400, { error: 'Escolha de 1 a 5 estrelas' });

      const purchase = await pool.query(
        `SELECT id FROM orders WHERE customer_id = $1 AND status <> 'cancelado' AND items @> $2::jsonb LIMIT 1`,
        [customerId, JSON.stringify([{ id: productId }])]
      );
      if (!purchase.rowCount) return sendJSON(res, 403, { error: 'Você só pode avaliar produtos que já comprou' });

      const dup = await pool.query('SELECT 1 FROM product_reviews WHERE product_id = $1 AND customer_id = $2', [productId, customerId]);
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Você já avaliou esse produto' });

      await pool.query(
        'INSERT INTO product_reviews (id, product_id, customer_id, order_id, rating, comment) VALUES ($1,$2,$3,$4,$5,$6)',
        [crypto.randomUUID(), productId, customerId, purchase.rows[0].id, rating, comment]
      );
      return sendJSON(res, 201, { reviews: await getProductReviews(productId) });
    }

    if (pathname === '/api/admin/reviews/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      return sendJSON(res, 200, { reviews: await getAllReviews() });
    }

    if (pathname === '/api/reviews' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      await pool.query('DELETE FROM product_reviews WHERE id = $1', [body.id]);
      logActivity(admin, 'review.delete', 'review', body.id, null);
      return sendJSON(res, 200, { reviews: await getAllReviews() });
    }

    // ------ endereços salvos do cliente ------
    if (pathname === '/api/customers/addresses/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      return sendJSON(res, 200, { addresses: await getCustomerAddresses(customerId) });
    }

    if (pathname === '/api/customers/addresses' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });

      const label = (body.label || '').trim();
      const cep = (body.cep || '').trim();
      const rua = (body.rua || '').trim();
      const numero = (body.numero || '').trim();
      const complemento = (body.complemento || '').trim() || null;
      const bairro = (body.bairro || '').trim();
      const cidade = (body.cidade || '').trim();
      const estado = (body.estado || '').trim();
      if (!cep || !rua || !numero || !bairro || !cidade || !estado) {
        return sendJSON(res, 400, { error: 'Preencha CEP, rua, número, bairro, cidade e UF' });
      }

      const id = crypto.randomUUID();
      if (body.isDefault) {
        await pool.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1', [customerId]);
      }
      await pool.query(
        `INSERT INTO customer_addresses (id, customer_id, label, cep, rua, numero, complemento, bairro, cidade, estado, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, customerId, label, cep, rua, numero, complemento, bairro, cidade, estado, !!body.isDefault]
      );
      return sendJSON(res, 201, { addresses: await getCustomerAddresses(customerId) });
    }

    if (pathname === '/api/customers/addresses/update' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      const label = (body.label || '').trim();
      const cep = (body.cep || '').trim();
      const rua = (body.rua || '').trim();
      const numero = (body.numero || '').trim();
      const complemento = (body.complemento || '').trim() || null;
      const bairro = (body.bairro || '').trim();
      const cidade = (body.cidade || '').trim();
      const estado = (body.estado || '').trim();
      if (!cep || !rua || !numero || !bairro || !cidade || !estado) {
        return sendJSON(res, 400, { error: 'Preencha CEP, rua, número, bairro, cidade e UF' });
      }

      const { rowCount } = await pool.query(
        `UPDATE customer_addresses SET label=$1, cep=$2, rua=$3, numero=$4, complemento=$5, bairro=$6, cidade=$7, estado=$8
         WHERE id=$9 AND customer_id=$10`,
        [label, cep, rua, numero, complemento, bairro, cidade, estado, body.id, customerId]
      );
      if (!rowCount) return sendJSON(res, 404, { error: 'Endereço não encontrado' });
      return sendJSON(res, 200, { addresses: await getCustomerAddresses(customerId) });
    }

    if (pathname === '/api/customers/addresses/default' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      await pool.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1', [customerId]);
      const { rowCount } = await pool.query(
        'UPDATE customer_addresses SET is_default = true WHERE id = $1 AND customer_id = $2',
        [body.id, customerId]
      );
      if (!rowCount) return sendJSON(res, 404, { error: 'Endereço não encontrado' });
      return sendJSON(res, 200, { addresses: await getCustomerAddresses(customerId) });
    }

    if (pathname === '/api/customers/addresses' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      await pool.query('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2', [body.id, customerId]);
      return sendJSON(res, 200, { addresses: await getCustomerAddresses(customerId) });
    }

    // ------ favoritos do cliente (sincroniza a lista de desejos entre dispositivos) ------
    if (pathname === '/api/customers/favorites/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      return sendJSON(res, 200, { favorites: await getCustomerFavorites(customerId) });
    }

    if (pathname === '/api/customers/favorites' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      if (!body.productId) return sendJSON(res, 400, { error: 'productId é obrigatório' });

      await pool.query(
        'INSERT INTO customer_favorites (customer_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [customerId, body.productId]
      );
      return sendJSON(res, 201, { favorites: await getCustomerFavorites(customerId) });
    }

    if (pathname === '/api/customers/favorites' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      if (!body.productId) return sendJSON(res, 400, { error: 'productId é obrigatório' });

      await pool.query('DELETE FROM customer_favorites WHERE customer_id = $1 AND product_id = $2', [customerId, body.productId]);
      return sendJSON(res, 200, { favorites: await getCustomerFavorites(customerId) });
    }

    // Mescla o que já estava no localStorage do dispositivo com o servidor — nunca remove
    // favoritos que o servidor já tinha e o dispositivo atual não conhecia (merge aditivo).
    if (pathname === '/api/customers/favorites/sync' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      const productIds = Array.isArray(body.productIds) ? body.productIds.filter((id) => typeof id === 'string' && id) : [];

      if (productIds.length) {
        await pool.query(
          `INSERT INTO customer_favorites (customer_id, product_id)
           SELECT $1, unnest($2::text[])
           ON CONFLICT DO NOTHING`,
          [customerId, productIds]
        );
      }
      return sendJSON(res, 200, { favorites: await getCustomerFavorites(customerId) });
    }

    if (pathname === '/api/customers/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      return sendJSON(res, 200, { customers: await getCustomersForAdmin() });
    }

    // ------ stories (carrossel de vídeo estilo Instagram) ------
    if (pathname === '/api/stories' && req.method === 'POST') {
      const body = await readJSONBody(req, 40 * 1024 * 1024);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });

      if (!body.video || typeof body.video !== 'string' || !body.video.startsWith('data:video/')) {
        return sendJSON(res, 400, { error: 'Envie um vídeo' });
      }
      const videoMatch = body.video.match(/^data:video\/([a-zA-Z0-9.+-]+);base64,(.+)$/s);
      if (!videoMatch) return sendJSON(res, 400, { error: 'Vídeo inválido' });
      const videoExt = videoMatch[1] === 'webm' ? '.webm' : '.mp4';
      const videoBuffer = Buffer.from(videoMatch[2], 'base64');
      if (videoBuffer.length > MAX_STORY_VIDEO_BYTES) {
        return sendJSON(res, 413, { error: 'Arquivo muito grande' });
      }

      const id = `story-${Date.now().toString(36)}`;
      const videoFileName = `${id}${videoExt}`;
      await fs.promises.writeFile(path.join(videosDir, videoFileName), videoBuffer);
      const video = `assets/videos/${videoFileName}`;

      let cover = null;
      if (body.cover && typeof body.cover === 'string' && body.cover.startsWith('data:image/')) {
        const coverMatch = body.cover.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
        if (coverMatch) {
          const coverBuffer = Buffer.from(coverMatch[1], 'base64');
          const coverFileName = `${id}-cover.jpg`;
          await sharp(coverBuffer)
            .rotate()
            .resize({ width: 500, height: 900, fit: 'cover' })
            .jpeg({ quality: 88, mozjpeg: true })
            .toFile(path.join(uploadDir, coverFileName));
          cover = `assets/img/processed/${coverFileName}`;
        }
      }

      const title = (body.title || '').trim();
      const linkUrl = (body.linkUrl || '').trim() || null;
      const linkLabel = (body.linkLabel || '').trim() || 'Ver mais';

      let productId = null;
      if (body.productId) {
        const p = await pool.query('SELECT id FROM products WHERE id = $1', [body.productId]);
        if (!p.rowCount) return sendJSON(res, 400, { error: 'Produto não encontrado' });
        productId = body.productId;
      }

      const { rows } = await pool.query('SELECT COALESCE(MAX(position), -1) AS max FROM stories');
      const position = rows[0].max + 1;

      await pool.query(
        `INSERT INTO stories (id, title, video, cover, link_url, link_label, product_id, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, title, video, cover, linkUrl, linkLabel, productId, position]
      );
      return sendJSON(res, 201, { stories: await getStories(false) });
    }

    if (pathname === '/api/stories/product' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      let productId = null;
      if (body.productId) {
        const p = await pool.query('SELECT id FROM products WHERE id = $1', [body.productId]);
        if (!p.rowCount) return sendJSON(res, 400, { error: 'Produto não encontrado' });
        productId = body.productId;
      }
      await pool.query('UPDATE stories SET product_id = $1 WHERE id = $2', [productId, body.id]);
      return sendJSON(res, 200, { stories: await getStories(false) });
    }

    if (pathname === '/api/stories' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      const { rows } = await pool.query('SELECT video, cover FROM stories WHERE id = $1', [body.id]);
      await pool.query('DELETE FROM stories WHERE id = $1', [body.id]);
      if (rows[0]) {
        for (const rel of [rows[0].video, rows[0].cover]) {
          if (!rel) continue;
          fs.promises.unlink(path.join(root, rel)).catch(() => {});
        }
      }
      return sendJSON(res, 200, { stories: await getStories(false) });
    }

    if (pathname === '/api/stories/reorder' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      const direction = body.direction === 'up' ? 'up' : body.direction === 'down' ? 'down' : null;
      if (!body.id || !direction) return sendJSON(res, 400, { error: 'id e direção são obrigatórios' });

      const all = await getStories(false);
      const idx = all.findIndex((s) => s.id === body.id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Story não encontrado' });
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= all.length) return sendJSON(res, 200, { stories: all });

      const a = all[idx];
      const b = all[swapIdx];
      await pool.query('UPDATE stories SET position = $1 WHERE id = $2', [b.position, a.id]);
      await pool.query('UPDATE stories SET position = $1 WHERE id = $2', [a.position, b.id]);
      return sendJSON(res, 200, { stories: await getStories(false) });
    }

    if (pathname === '/api/stories/active' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });
      await pool.query('UPDATE stories SET active = $1 WHERE id = $2', [body.active === true, body.id]);
      return sendJSON(res, 200, { stories: await getStories(false) });
    }

    if (pathname === '/api/stories/list' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      return sendJSON(res, 200, { stories: await getStories(false) });
    }

    // ------ site images (fixed-location landing page photos) ------
    if (pathname === '/api/site-images' && req.method === 'GET') {
      const images = Object.entries(SITE_IMAGE_SLOTS).map(([slot, cfg]) => ({
        slot,
        label: cfg.label,
        path: cfg.path,
      }));
      return sendJSON(res, 200, { images });
    }

    if (pathname === '/api/site-images' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });

      const cfg = SITE_IMAGE_SLOTS[body.slot];
      if (!cfg) return sendJSON(res, 400, { error: 'Local de imagem inválido' });
      if (!body.image || typeof body.image !== 'string' || !body.image.startsWith('data:image/')) {
        return sendJSON(res, 400, { error: 'Envie uma imagem' });
      }
      const match = body.image.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
      if (!match) return sendJSON(res, 400, { error: 'Imagem inválida' });
      const buffer = Buffer.from(match[1], 'base64');

      const destPath = path.join(root, cfg.path);
      await processSiteImage(buffer, destPath);
      logActivity(admin, 'site_image.update', 'site_image', body.slot, null);
      return sendJSON(res, 200, { ok: true, slot: body.slot, path: cfg.path });
    }

    return sendJSON(res, 404, { error: 'Rota não encontrada' });
  } catch (err) {
    console.error(err);
    const msg = err && err.message === 'payload too large' ? 'Arquivo muito grande' : 'Erro no servidor';
    return sendJSON(res, err && err.message === 'payload too large' ? 413 : 500, { error: msg });
  }
}

// Comprime a resposta com gzip quando o cliente aceita — sem isso, main.js (127KB) e
// style.css (73KB) trafegam inteiros em toda navegação, o que pesa bastante pra quem acessa
// pelo celular fora do wifi (a maior parte do público desta loja). Não mexe em Cache-Control:
// continua igual, isso aqui só reduz bytes na rede, não muda o que já foi decidido sobre cache.
const COMPRESSIBLE_EXT = new Set(['.html', '.css', '.js', '.json', '.svg', '.xml', '.txt']);
function sendBody(req, res, status, headers, body, { compressible = false } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (compressible && acceptsGzip && buffer.length > 256) {
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(zlib.gzipSync(buffer));
    return;
  }
  res.writeHead(status, headers);
  res.end(buffer);
}

// Nomes de arquivo fixos (sobrescritos no lugar pelo admin) não podem ter cache longo,
// senão o navegador ignora a foto nova depois de trocada em "Imagens do site".
const FIXED_IMAGE_FILES = new Set(Object.values(SITE_IMAGE_SLOTS).map((cfg) => path.basename(cfg.path)));

function cacheControlFor(filePath, ext) {
  if (ext === '.html') return 'no-cache';
  const base = path.basename(filePath);
  if (filePath.startsWith(`${path.sep}assets${path.sep}img${path.sep}processed${path.sep}`) || filePath.startsWith('/assets/img/processed/')) {
    if (FIXED_IMAGE_FILES.has(base)) return 'no-cache';
    return 'public, max-age=31536000, immutable'; // fotos de produto/story têm nome único (timestamp), nunca mudam de conteúdo
  }
  if (filePath.includes(`${path.sep}assets${path.sep}videos${path.sep}`) || filePath.includes('/assets/videos/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (ext === '.css' || ext === '.js') return 'no-cache'; // sem hash no nome do arquivo, então revalida a cada load em vez de arriscar servir versão antiga
  return 'no-cache';
}

// ---------- static file serving ----------
function serveNotFound(res) {
  fs.readFile(path.join(root, '404.html'), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Página não encontrada');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    if (err instanceof URIError) return null;
    throw err;
  }
}

function serveBadRequest(res) {
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end('URL inválida');
}

// Só o que o front realmente precisa buscar por HTTP: as páginas HTML públicas e tudo
// dentro de assets/. Tudo mais no repo (serve.js, .env, db/, node_modules/, package.json...)
// nunca deve ser servido como arquivo estático — allowlist em vez de bloquear só ".."
// porque um arquivo sensível (ex.: .env) pode estar dentro do root sem nenhum ".." envolvido.
const PUBLIC_STATIC_FILES = new Set(['/index.html', '/admin.html', '/produto.html', '/404.html', '/redefinir-senha.html', '/politica-privacidade.html']);

function isPublicStaticPath(filePath) {
  return PUBLIC_STATIC_FILES.has(filePath) || filePath.startsWith('/assets/');
}

function serveStatic(req, res, pathname) {
  let filePath = decodePath(pathname);
  if (filePath === null) {
    serveBadRequest(res);
    return;
  }

  // formas canônicas: uma única URL "de verdade" por página, sem duplicar / vs /index.html
  if (filePath === '/index.html') {
    res.writeHead(301, { Location: '/' });
    res.end();
    return;
  }
  if (filePath === '/admin.html') {
    res.writeHead(301, { Location: '/admin' });
    res.end();
    return;
  }

  if (filePath === '/') filePath = '/index.html';
  if (filePath === '/admin') filePath = '/admin.html';
  if (!isPublicStaticPath(filePath)) {
    serveNotFound(res);
    return;
  }
  const full = path.join(root, filePath);
  if (full !== root && !full.startsWith(root + path.sep)) {
    serveNotFound(res);
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      serveNotFound(res);
      return;
    }
    const ext = path.extname(full);
    if (filePath === '/index.html') {
      // og:image/canonical precisam ser URL absoluta (esquema+host) — link relativo não é
      // resolvido de forma confiável por crawlers de preview (WhatsApp/Facebook/Instagram).
      const origin = requestOrigin(req);
      const html = data
        .toString('utf8')
        .replace(/<!--HOME_OG_IMAGE-->/g, escapeHtml(`${origin}/assets/img/processed/site-hero-1.jpg`))
        .replace(/<!--HOME_CANONICAL-->/g, escapeHtml(`${origin}/`));
      sendBody(req, res, 200, { 'Content-Type': types_[ext] || 'application/octet-stream', 'Cache-Control': cacheControlFor(filePath, ext) }, html, { compressible: true });
      return;
    }
    sendBody(req, res, 200, { 'Content-Type': types_[ext] || 'application/octet-stream', 'Cache-Control': cacheControlFor(filePath, ext) }, data, { compressible: COMPRESSIBLE_EXT.has(ext) });
  });
}

const robotsTxt = (origin) => `User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`;

// O protocolo de sitemap exige <loc> absoluta (com esquema+host) — sem isso, alguns
// crawlers rejeitam o arquivo inteiro. Deriva o host do próprio request em vez de fixar um
// domínio, então funciona igual em localhost e em produção atrás de proxy/CDN.
function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

// dinâmico porque precisa listar /produto/:id de cada produto — antes era uma string fixa
// com só a home.
async function buildSitemap(origin) {
  const { rows } = await pool.query('SELECT id FROM products ORDER BY created_at DESC');
  const urls = ['/', '/politica-privacidade.html', ...rows.map((r) => `/produto/${r.id}`)];
  const items = urls.map((u) => `  <url><loc>${origin}${u}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`;
}

// Valida os dois dígitos verificadores do CPF (módulo 11) — a checagem de tamanho sozinha
// deixa passar sequências óbvias como "111.111.111-11" ou "000.000.000-00".
function isValidCPF(cpf) {
  if (!/^\d{11}$/.test(cpf)) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  const digits = cpf.split('').map(Number);
  for (const pos of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < pos; i++) sum += digits[i] * (pos + 1 - i);
    const check = (sum * 10) % 11 % 10;
    if (check !== digits[pos]) return false;
  }
  return true;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Sem template engine no projeto — monta o <head> por substituição de string simples nos
// placeholders de produto.html. O corpo da página continua renderizado no client (main.js),
// igual ao resto do site; só o título/meta/OG precisam vir prontos na resposta do servidor,
// pra link compartilhado no WhatsApp e crawler mostrarem a prévia certa.
async function serveProductPage(req, res, id) {
  const product = await getProductMeta(id);
  if (!product) {
    serveNotFound(res);
    return;
  }
  fs.readFile(path.join(root, 'produto.html'), 'utf8', (err, template) => {
    if (err) {
      serveNotFound(res);
      return;
    }
    const origin = requestOrigin(req);
    const title = `${product.name} — By NaNa`;
    const description = (product.desc || `Confira ${product.name} na By NaNa.`).slice(0, 160);
    const canonical = `${origin}/produto/${product.id}`;
    const jsonLd = buildProductJsonLd(product, { origin, canonical });
    const html = template
      .replace(/<!--PRODUCT_TITLE-->/g, escapeHtml(title))
      .replace(/<!--PRODUCT_DESCRIPTION-->/g, escapeHtml(description))
      .replace(/<!--PRODUCT_OG_IMAGE-->/g, escapeHtml(`${origin}/${product.img}`))
      .replace(/<!--PRODUCT_CANONICAL-->/g, escapeHtml(canonical))
      // JSON-LD não passa por escapeHtml (quebraria a sintaxe JSON); JSON.stringify já escapa
      // aspas, e "<" vira "<" abaixo pra um valor de produto nunca poder fechar a tag <script>.
      .replace('<!--PRODUCT_JSONLD-->', jsonLd.replace(/</g, '\\u003c'));
    sendBody(req, res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, html, { compressible: true });
  });
}

// CSP restrita a 'self' + só os domínios de terceiro que o site realmente usa (Google Fonts,
// GA4, Meta Pixel — os dois últimos só são efetivamente chamados quando configurados, ver
// /api/public-config, mas ficam liberados aqui desde já pra não exigir mexer nisso de novo
// quando a cliente criar as contas). script-src sem 'unsafe-inline': todo <script> do site é
// arquivo externo (ver redefinir-senha.js) — só style-src precisa de 'unsafe-inline', porque
// o layout usa atributos style="" inline em alguns pontos (posições de callout, JS que anima
// elementos). frame-ancestors 'none' bloqueia o site inteiro (inclusive /admin) de ser
// carregado dentro de um <iframe> de outro site — a defesa moderna contra clickjacking.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.googletagmanager.com https://connect.facebook.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://www.facebook.com https://www.google-analytics.com",
  "media-src 'self' data:",
  "connect-src 'self' https://viacep.com.br https://www.google-analytics.com https://*.google-analytics.com https://www.facebook.com https://connect.facebook.net",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  // Browsers só levam HSTS a sério quando a resposta veio por HTTPS — inofensivo em dev/HTTP local.
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

// Rede de segurança contra promises rejeitadas sem .catch() em algum ponto do código — sem
// isso, uma unhandled rejection derruba o processo inteiro (comportamento padrão do Node
// desde a v15), tirando o site do ar para todo mundo por causa de uma única requisição.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

const httpServer = http
  .createServer((req, res) => {
    applySecurityHeaders(res);
    const pathname = req.url.split('?')[0];
    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname);
      return;
    }
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(robotsTxt(requestOrigin(req)));
      return;
    }
    if (pathname === '/sitemap.xml') {
      buildSitemap(requestOrigin(req))
        .then((xml) => {
          res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(xml);
        })
        .catch((err) => {
          console.error('[sitemap] falha ao gerar sitemap:', err.message);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Erro ao gerar sitemap');
        });
      return;
    }
    if (pathname.startsWith('/produto/')) {
      const id = decodePath(pathname.slice('/produto/'.length));
      if (id === null) {
        serveBadRequest(res);
        return;
      }
      serveProductPage(req, res, id);
      return;
    }
    serveStatic(req, res, pathname);
  })
  .listen(port, host, () => console.log(`Serving on http://${host}:${port}`));

// Encerramento gracioso: plataformas de deploy (Render, Railway, Fly.io, Docker) mandam SIGTERM
// antes de matar o container. Sem isso, requisições em voo são cortadas e o pool do Neon fica
// aberto, gerando 502s desnecessários a cada deploy.
function gracefulShutdown(signal) {
  console.log(`[shutdown] ${signal} recebido, encerrando...`);
  httpServer.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------- lembrete de carrinho abandonado (varredura periódica, sem cupom) ----------
// Processo único e sempre ativo (sem worker/cron externo) — um setInterval aqui já cobre o
// caso de uso. SITE_URL precisa estar configurada em produção pro link do e-mail apontar pro
// domínio certo (sem ela, cai num link relativo que só funciona clicado dentro do próprio site).
const ABANDONED_CART_DELAY_MS = 2 * 60 * 60 * 1000; // 2h sem atividade
const ABANDONED_CART_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

async function sweepAbandonedCarts() {
  try {
    const { rows } = await pool.query(
      `SELECT id, contact_email, customer_name, items, subtotal FROM abandoned_carts
       WHERE reminded_at IS NULL AND converted_at IS NULL AND updated_at < now() - make_interval(secs => $1)
       ORDER BY updated_at ASC LIMIT 50`,
      [ABANDONED_CART_DELAY_MS / 1000]
    );
    if (!rows.length) return;
    const origin = (process.env.SITE_URL || '').replace(/\/$/, '');
    for (const row of rows) {
      await sendEmail({
        to: row.contact_email,
        subject: 'Você esqueceu itens na sua sacola — By NaNa',
        html: buildAbandonedCartHtml({ customerName: row.customer_name, items: row.items, subtotal: row.subtotal, origin }),
      });
      await pool.query('UPDATE abandoned_carts SET reminded_at = now() WHERE id = $1', [row.id]);
    }
  } catch (err) {
    console.error('[abandoned-carts] falha na varredura:', err.message);
  }
}

setInterval(sweepAbandonedCarts, ABANDONED_CART_SWEEP_INTERVAL_MS);
