// One-off: garante o schema em dia e cria o primeiro usuário admin "owner", a partir de
// SEED_ADMIN_NAME / SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (ou ADMIN_PASSWORD como fallback
// de senha, para quem já tinha a senha única antiga). Não faz nada se o e-mail já existir.
// Run with: node db/seed-admin.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Schema ok.');

  const name = process.env.SEED_ADMIN_NAME || 'Administrador';
  const email = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('Defina SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD (ou ADMIN_PASSWORD) no .env antes de rodar este script.');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const existing = await pool.query('SELECT id FROM admin_users WHERE lower(email) = $1', [email]);
  if (existing.rowCount) {
    console.log(`Usuário admin "${email}" já existe — nada a fazer.`);
    await pool.end();
    return;
  }

  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
    [id, name, email, hashPassword(password), 'owner']
  );
  console.log(`Usuário admin "owner" criado: ${email}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
