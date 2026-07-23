require('dotenv').config({ quiet: true });
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { Pool, types } = require('pg');

// numeric -> number, date -> plain 'YYYY-MM-DD' string (avoids timezone drift from Date objects)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const root = __dirname;
const port = 8787;
const uploadDir = path.join(root, 'assets/img/processed');
const videosDir = path.join(root, 'assets/videos');
fs.mkdirSync(videosDir, { recursive: true });

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

async function getProducts() {
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.brand, c.name AS category, COALESCE(col.name, '') AS collection,
           p.tag, p.price, p.img, p.description AS desc,
           p.is_featured AS "isFeatured", p.featured_position AS "featuredPosition"
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN collections col ON col.id = p.collection_id
    ORDER BY p.created_at DESC
  `);
  return rows;
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
  if (featured.rowCount) return featured.rows;

  const fallback = await pool.query(`
    SELECT p.id, p.name, p.brand, c.name AS category, COALESCE(col.name, '') AS collection,
           p.tag, p.price, p.img, p.description AS desc
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN collections col ON col.id = p.collection_id
    ORDER BY p.created_at DESC
    LIMIT 8
  `);
  return fallback.rows;
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

// grupos usados só pelo mega-menu da vitrine; não altera o formato de getCategories().
async function getCategoryGroups() {
  const { rows } = await pool.query('SELECT name, group_name AS "groupName" FROM categories ORDER BY id');
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
           items, subtotal, discount, total, coupon_code AS "couponCode",
           payment_method AS "paymentMethod", delivery_method AS "deliveryMethod",
           address, status, created_at AS "createdAt"
    FROM orders
    ORDER BY created_at DESC
    LIMIT 300
  `);
  return rows;
}

async function getCustomerOrders(customerId) {
  const { rows } = await pool.query(
    `SELECT id, items, subtotal, discount, total, coupon_code AS "couponCode",
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

// Resolve a identidade do cliente sempre a partir do token assinado — nunca de um id
// enviado no corpo da requisição, para que ninguém possa ler/alterar dados de outra conta.
function resolveCustomerId(body) {
  const payload = verifySessionToken(body.token);
  return payload ? payload.id : null;
}

async function getStories(onlyActive) {
  const { rows } = await pool.query(`
    SELECT id, title, video, cover, link_url AS "linkUrl", link_label AS "linkLabel",
           product_id AS "productId", active
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
  const { rows } = await pool.query('SELECT id, name, email, role, active FROM admin_users WHERE id = $1', [payload.id]);
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
    // ------ catalog ------
    if (pathname === '/api/data' && req.method === 'GET') {
      const [products, categories, collections, promotions, coupons, categoryGroups, stories, novidades] = await Promise.all([
        getProducts(),
        getCategories(),
        getCollections(),
        getPromotions(),
        getCoupons(),
        getCategoryGroups(),
        getStories(true),
        getNovidades(),
      ]);
      return sendJSON(res, 200, { products, categories, collections, promotions, coupons, categoryGroups, stories, novidades });
    }

    // ------ admin auth (login multiusuário, papéis, log de atividade) ------
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      if (!email || !password) return sendJSON(res, 400, { error: 'Informe e-mail e senha' });

      const { rows } = await pool.query(
        'SELECT id, name, email, password_hash AS "passwordHash", role, active FROM admin_users WHERE lower(email) = $1',
        [email]
      );
      const row = rows[0];
      if (!row || !row.active || !verifyPassword(password, row.passwordHash)) {
        return sendJSON(res, 401, { error: 'E-mail ou senha inválidos' });
      }
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
      if (password.length < 6) return sendJSON(res, 400, { error: 'A senha deve ter ao menos 6 caracteres' });

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
      if (newPassword.length < 6) return sendJSON(res, 400, { error: 'A nova senha deve ter ao menos 6 caracteres' });

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

      await pool.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [category]);
      if (collection) {
        await pool.query('INSERT INTO collections(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [collection]);
      }

      let img = null;
      if (body.image && typeof body.image === 'string' && body.image.startsWith('data:image/')) {
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
        img = `assets/img/processed/${fileName}`;
      }

      const { rowCount } = await pool.query(
        `UPDATE products SET name=$1, brand=$2,
           category_id=(SELECT id FROM categories WHERE lower(name)=lower($3)),
           collection_id=(SELECT id FROM collections WHERE lower(name)=lower($4)),
           tag=$5, price=$6, description=$7, img=COALESCE($8, img)
         WHERE id=$9`,
        [name, brand, category, collection || null, tag, price, desc, img, body.id]
      );
      if (!rowCount) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      logActivity(admin, 'product.update', 'product', body.id, { name });
      return sendJSON(res, 200, { products: await getProducts() });
    }

    if (pathname === '/api/products/featured' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const admin = await requireAdmin(body);
      if (!admin) return sendJSON(res, 401, { error: 'Sessão inválida ou expirada' });
      if (!body.id) return sendJSON(res, 400, { error: 'id é obrigatório' });

      if (body.featured) {
        const { rows } = await pool.query('SELECT COALESCE(MAX(featured_position), -1) AS max FROM products WHERE is_featured = true');
        await pool.query('UPDATE products SET is_featured = true, featured_position = $1 WHERE id = $2', [rows[0].max + 1, body.id]);
      } else {
        await pool.query('UPDATE products SET is_featured = false, featured_position = NULL WHERE id = $1', [body.id]);
      }
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
      const discount = validateDiscount(body);
      if (discount.error) return sendJSON(res, 400, { error: discount.error });
      const endDate = (body.endDate || '').trim() || null;

      const dup = await pool.query('SELECT 1 FROM coupons WHERE code = $1', [code]);
      if (dup.rowCount) return sendJSON(res, 409, { error: 'Já existe um cupom com esse código' });

      await pool.query(
        'INSERT INTO coupons (code, discount_type, discount_value, end_date) VALUES ($1,$2,$3,$4)',
        [code, discount.type, discount.value, endDate]
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
      const discount = validateDiscount(body);
      if (discount.error) return sendJSON(res, 400, { error: discount.error });
      const endDate = (body.endDate || '').trim() || null;

      const { rowCount } = await pool.query(
        'UPDATE coupons SET discount_type=$1, discount_value=$2, end_date=$3 WHERE code=$4',
        [discount.type, discount.value, endDate, code]
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
      await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
      logActivity(admin, 'coupon.delete', 'coupon', code, null);
      return sendJSON(res, 200, { coupons: await getCoupons() });
    }

    // ------ orders (pedidos fechados no checkout do site, antes de abrir o WhatsApp) ------
    if (pathname === '/api/orders' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerName = (body.customerName || '').trim();
      const customerPhone = (body.customerPhone || '').trim();
      const paymentMethod = (body.paymentMethod || '').trim();
      const deliveryMethod = (body.deliveryMethod || '').trim();
      const items = Array.isArray(body.items) ? body.items : [];
      if (!customerName || !customerPhone || !paymentMethod || !deliveryMethod || !items.length) {
        return sendJSON(res, 400, { error: 'Dados do pedido incompletos' });
      }
      const subtotal = Number(body.subtotal) || 0;
      const discount = Number(body.discount) || 0;
      const total = Number(body.total) || 0;
      const couponCode = (body.couponCode || '').trim().toUpperCase() || null;
      const address = body.address && typeof body.address === 'object' ? body.address : null;

      let customerId = null;
      if (body.customerToken) {
        const payload = verifySessionToken(body.customerToken);
        if (payload) customerId = payload.id;
      }

      const id = `pedido-${Date.now().toString(36)}`;
      await pool.query(
        `INSERT INTO orders (id, customer_id, customer_name, customer_phone, items, subtotal, discount, total, coupon_code, payment_method, delivery_method, address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, customerId, customerName, customerPhone, JSON.stringify(items), subtotal, discount, total, couponCode, paymentMethod, deliveryMethod, address ? JSON.stringify(address) : null]
      );
      return sendJSON(res, 201, { orderId: id });
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
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, body.id]);
      logActivity(admin, 'order.status_update', 'order', body.id, { status });
      return sendJSON(res, 200, { orders: await getOrders() });
    }

    // ------ customers (cadastro/login público + CRM no admin) ------
    if (pathname === '/api/customers' && req.method === 'POST') {
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
      if (cpf.length !== 11) return sendJSON(res, 400, { error: 'CPF inválido' });
      if (password.length < 6) return sendJSON(res, 400, { error: 'A senha deve ter ao menos 6 caracteres' });
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

      const { rows } = await pool.query(
        'SELECT id, first_name AS "firstName", last_name AS "lastName", email, phone, marketing_opt_in AS "marketingOptIn", password_hash AS "passwordHash" FROM customers WHERE lower(email) = $1',
        [email]
      );
      const row = rows[0];
      if (!row || !verifyPassword(password, row.passwordHash)) {
        return sendJSON(res, 401, { error: 'E-mail ou senha inválidos' });
      }
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
      if (newPassword.length < 6) return sendJSON(res, 400, { error: 'A nova senha deve ter ao menos 6 caracteres' });

      const { rows } = await pool.query('SELECT password_hash AS "passwordHash" FROM customers WHERE id = $1', [customerId]);
      if (!rows[0] || !verifyPassword(currentPassword, rows[0].passwordHash)) {
        return sendJSON(res, 401, { error: 'Senha atual incorreta' });
      }
      await pool.query('UPDATE customers SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), customerId]);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/customers/orders' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const customerId = resolveCustomerId(body);
      if (!customerId) return sendJSON(res, 401, { error: 'Sessão inválida' });
      return sendJSON(res, 200, { orders: await getCustomerOrders(customerId) });
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
      const [{ position: posA }, { position: posB }] = await Promise.all([
        pool.query('SELECT position FROM stories WHERE id = $1', [a.id]).then((r) => r.rows[0]),
        pool.query('SELECT position FROM stories WHERE id = $1', [b.id]).then((r) => r.rows[0]),
      ]);
      await pool.query('UPDATE stories SET position = $1 WHERE id = $2', [posB, a.id]);
      await pool.query('UPDATE stories SET position = $1 WHERE id = $2', [posA, b.id]);
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

function serveStatic(req, res, pathname) {
  let filePath = decodeURIComponent(pathname);

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
  const full = path.join(root, filePath);
  fs.readFile(full, (err, data) => {
    if (err) {
      serveNotFound(res);
      return;
    }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': types_[ext] || 'application/octet-stream', 'Cache-Control': cacheControlFor(filePath, ext) });
    res.end(data);
  });
}

const ROBOTS_TXT = `User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: /sitemap.xml\n`;
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>/</loc></url>\n</urlset>\n`;

http
  .createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname);
      return;
    }
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(ROBOTS_TXT);
      return;
    }
    if (pathname === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(SITEMAP_XML);
      return;
    }
    serveStatic(req, res, pathname);
  })
  .listen(port, () => console.log(`Serving on http://localhost:${port}`));
