// Configuração operacional confirmada pela loja. É idempotente e pode ser repetida em outro
// banco/ambiente sem duplicar a regra padrão de frete.
const { Pool } = require('pg');
require('dotenv').config({ quiet: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não configurada.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `INSERT INTO shipping_rules (uf, label, price, free_above, active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT ((upper(uf))) DO UPDATE SET
       label = EXCLUDED.label,
       price = EXCLUDED.price,
       free_above = EXCLUDED.free_above,
       active = EXCLUDED.active
     RETURNING uf, label, price, free_above AS "freeAbove", active`,
    ['*', 'Frete padrão', 15, 499]
  );
  console.log('Configuração aplicada:', rows[0]);
}

main()
  .catch((err) => {
    console.error('Falha ao aplicar configuração:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
