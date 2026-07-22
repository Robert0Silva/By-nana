// One-off migration: creates the schema (if missing) and imports data/*.json into Neon.
// Run with: node db/migrate.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const dataDir = path.join(__dirname, '..', 'data');
const readJSON = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
  } catch {
    return fallback;
  }
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Schema ok.');

  const categories = readJSON('categories.json', []);
  const collections = readJSON('collections.json', []);
  const products = readJSON('products.json', []);
  const promotions = readJSON('promotions.json', []);
  const coupons = readJSON('coupons.json', []);

  for (const name of categories) {
    await pool.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [name]);
  }
  for (const name of collections) {
    await pool.query('INSERT INTO collections(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [name]);
  }
  console.log(`Categories: ${categories.length}, Collections: ${collections.length}`);

  // products may reference a category/collection not present in categories.json/collections.json — create it too.
  for (const p of products) {
    await pool.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [p.category]);
    if (p.collection) {
      await pool.query('INSERT INTO collections(name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING', [p.collection]);
    }
    await pool.query(
      `INSERT INTO products (id, name, brand, category_id, collection_id, tag, price, img, description)
       VALUES ($1, $2, $3, (SELECT id FROM categories WHERE name = $4), (SELECT id FROM collections WHERE name = $5), $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.name, p.brand, p.category, p.collection || null, p.tag, p.price, p.img, p.desc]
    );
  }
  console.log(`Products: ${products.length}`);

  for (const promo of promotions) {
    await pool.query(
      `INSERT INTO promotions (id, scope, target_product_id, target_category_id, target_collection_id, discount_type, discount_value, label, start_date, end_date, active)
       VALUES ($1, $2, $3, (SELECT id FROM categories WHERE name = $4), (SELECT id FROM collections WHERE name = $5), $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        promo.id,
        promo.scope,
        promo.scope === 'product' ? promo.target : null,
        promo.scope === 'category' ? promo.target : null,
        promo.scope === 'collection' ? promo.target : null,
        promo.type,
        promo.value,
        promo.label || '',
        promo.startDate,
        promo.endDate,
        promo.active !== false,
      ]
    );
  }
  console.log(`Promotions: ${promotions.length}`);

  for (const c of coupons) {
    await pool.query(
      `INSERT INTO coupons (code, discount_type, discount_value, start_date, end_date, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO NOTHING`,
      [c.code, c.type, c.value, c.startDate, c.endDate, c.active !== false]
    );
  }
  console.log(`Coupons: ${coupons.length}`);

  console.log('Migration done.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
