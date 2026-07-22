require('dotenv').config({ quiet: true });
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool, types } = require('pg');

// numeric -> number, date -> plain 'YYYY-MM-DD' string (avoids timezone drift from Date objects)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const root = __dirname;
const port = 8787;
const uploadDir = path.join(root, 'assets/img/processed');

// Change this to control who can use the admin panel (/admin.html).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

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

const types_ = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
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

async function getProducts() {
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.brand, c.name AS category, COALESCE(col.name, '') AS collection,
           p.tag, p.price, p.img, p.description AS desc
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN collections col ON col.id = p.collection_id
    ORDER BY p.created_at DESC
  `);
  return rows;
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

async function getCoupons() {
  const { rows } = await pool.query(`
    SELECT code, discount_type AS type, discount_value AS value,
           start_date AS "startDate", end_date AS "endDate", active
    FROM coupons
    ORDER BY created_at DESC
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

function checkAuth(body) {
  return typeof body.password === 'string' && body.password === ADMIN_PASSWORD;
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
    // ------ catalog ------
    if (pathname === '/api/data' && req.method === 'GET') {
      const [products, categories, collections, promotions, coupons] = await Promise.all([
        getProducts(),
        getCategories(),
        getCollections(),
        getPromotions(),
        getCoupons(),
      ]);
      return sendJSON(res, 200, { products, categories, collections, promotions, coupons });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJSONBody(req);
      return sendJSON(res, 200, { ok: checkAuth(body) });
    }

    // ------ products ------
    if (pathname === '/api/products' && req.method === 'POST') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });

      const name = (body.name || '').trim();
      const category = (body.category || '').trim();
      const desc = (body.desc || '').trim();
      if (!name || !category || !desc) {
        return sendJSON(res, 400, { error: 'Nome, categoria e descrição são obrigatórios' });
      }
      if (!body.image || typeof body.image !== 'string' || !body.image.startsWith('data:image/')) {
        return sendJSON(res, 400, { error: 'Envie uma foto do produto' });
      }

      const match = body.image.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
      if (!match) return sendJSON(res, 400, { error: 'Imagem inválida' });
      const buffer = Buffer.from(match[1], 'base64');

      const slug = slugify(name);
      const fileName = `${slug}-${Date.now().toString(36)}.jpg`;
      const outPath = path.join(uploadDir, fileName);

      await sharp(buffer)
        .rotate()
        .normalize({ lower: 1, upper: 99 })
        .modulate({ brightness: 1.03, saturation: 1.05 })
        .sharpen({ sigma: 0.5 })
        .resize({ width: 1000, withoutEnlargement: true })
        .jpeg({ quality: 90, mozjpeg: true })
        .toFile(outPath);

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

      // keep categories/collections in sync so filters pick up brand-new ones
      await pool.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [category]);
      if (collection) {
        await pool.query('INSERT INTO collections(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [collection]);
      }

      await pool.query(
        `INSERT INTO products (id, name, brand, category_id, collection_id, tag, price, img, description)
         VALUES ($1, $2, $3, (SELECT id FROM categories WHERE lower(name) = lower($4)), (SELECT id FROM collections WHERE lower(name) = lower($5)), $6, $7, $8, $9)`,
        [id, name, brand, category, collection || null, tag, price, img, desc]
      );

      const product = { id, name, brand, category, collection, tag, price, img, desc };
      const [categories, collections] = await Promise.all([getCategories(), getCollections()]);
      return sendJSON(res, 201, { product, categories, collections });
    }

    if (pathname === '/api/products' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [body.id]);
      if (!rowCount) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      return sendJSON(res, 200, { products: await getProducts() });
    }

    // ------ categories ------
    if (pathname === '/api/categories' && req.method === 'POST') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });
      const name = (body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'Informe um nome' });

      const dup = await pool.query('SELECT 1 FROM categories WHERE lower(name) = lower($1)', [name]);
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Essa categoria já existe' });
      await pool.query('INSERT INTO categories(name) VALUES ($1)', [name]);
      return sendJSON(res, 201, { categories: await getCategories() });
    }

    if (pathname === '/api/categories' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });
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

    // ------ collections ------
    if (pathname === '/api/collections' && req.method === 'POST') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });
      const name = (body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'Informe um nome' });

      const dup = await pool.query('SELECT 1 FROM collections WHERE lower(name) = lower($1)', [name]);
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Essa coleção já existe' });
      await pool.query('INSERT INTO collections(name) VALUES ($1)', [name]);
      return sendJSON(res, 201, { collections: await getCollections() });
    }

    if (pathname === '/api/collections' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });
      const name = (body.name || '').trim();
      // products in this collection just lose the tag (collection_id -> NULL), same as before
      await pool.query('DELETE FROM collections WHERE lower(name) = lower($1)', [name]);
      return sendJSON(res, 200, { collections: await getCollections() });
    }

    // ------ promotions ------
    if (pathname === '/api/promotions' && req.method === 'POST') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });

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
      return sendJSON(res, 201, { promotions: await getPromotions() });
    }

    if (pathname === '/api/promotions' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });
      await pool.query('DELETE FROM promotions WHERE id = $1', [body.id]);
      return sendJSON(res, 200, { promotions: await getPromotions() });
    }

    // ------ coupons ------
    if (pathname === '/api/coupons' && req.method === 'POST') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });

      const code = (body.code || '').trim().toUpperCase();
      if (!code) return sendJSON(res, 400, { error: 'Informe um código para o cupom' });
      const discount = validateDiscount(body);
      if (discount.error) return sendJSON(res, 400, { error: discount.error });
      const endDate = (body.endDate || '').trim() || null;

      const dup = await pool.query('SELECT 1 FROM coupons WHERE code = $1', [code]);
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Já existe um cupom com esse código' });

      await pool.query(
        'INSERT INTO coupons (code, discount_type, discount_value, end_date) VALUES ($1,$2,$3,$4)',
        [code, discount.type, discount.value, endDate]
      );
      return sendJSON(res, 201, { coupons: await getCoupons() });
    }

    if (pathname === '/api/coupons' && req.method === 'DELETE') {
      const body = await readJSONBody(req);
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });
      const code = (body.code || '').trim().toUpperCase();
      await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
      return sendJSON(res, 200, { coupons: await getCoupons() });
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
      if (!checkAuth(body)) return sendJSON(res, 401, { error: 'Senha inválida' });

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
      return sendJSON(res, 200, { ok: true, slot: body.slot, path: cfg.path });
    }

    return sendJSON(res, 404, { error: 'Rota não encontrada' });
  } catch (err) {
    console.error(err);
    const msg = err && err.message === 'payload too large' ? 'Arquivo muito grande' : 'Erro no servidor';
    return sendJSON(res, err && err.message === 'payload too large' ? 413 : 500, { error: msg });
  }
}

// ---------- static file serving ----------
function serveStatic(req, res, pathname) {
  let filePath = decodeURIComponent(pathname);
  if (filePath === '/') filePath = '/index.html';
  if (filePath === '/admin') filePath = '/admin.html';
  const full = path.join(root, filePath);
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': types_[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  })
  .listen(port, () => console.log(`Serving on http://localhost:${port}`));
