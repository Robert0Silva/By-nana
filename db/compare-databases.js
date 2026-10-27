// Confere a cópia do banco na mudança de provedor (ver docs/migracao-render.md): para cada tabela,
// compara a quantidade de linhas e um hash do conteúdo entre a origem e o destino.
// Só lê os dois bancos (uma transação READ ONLY em cada) e nunca imprime as URLs.
// Uso: SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... node db/compare-databases.js
const { Client } = require('pg');

// Tudo numa transação só: funciona também pelo pooler do Neon (que não guarda SET de sessão), e
// fuso/formato de data fixos fazem o texto das linhas sair igual nos dois servidores.
async function tableSummary(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL TimeZone = 'UTC'");
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await client.query('SET LOCAL extra_float_digits = 1');
    const { rows: tables } = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename COLLATE \"C\""
    );
    const summary = new Map();
    for (const { tablename } of tables) {
      const ident = `"${tablename.replace(/"/g, '""')}"`;
      // ordena pelo texto da linha inteira: o hash não depende da ordem física no disco
      const { rows: [row] } = await client.query(
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) AS hash FROM ${ident} t`
      );
      summary.set(tablename, row);
    }
    return summary;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

async function main() {
  const { SOURCE_DATABASE_URL, TARGET_DATABASE_URL } = process.env;
  if (!SOURCE_DATABASE_URL || !TARGET_DATABASE_URL) {
    console.error('Defina SOURCE_DATABASE_URL (banco atual) e TARGET_DATABASE_URL (banco novo).');
    process.exit(2);
  }
  if (SOURCE_DATABASE_URL === TARGET_DATABASE_URL) {
    console.error('Origem e destino são o mesmo banco.');
    process.exit(2);
  }
  const [a, b] = await Promise.all([tableSummary(SOURCE_DATABASE_URL), tableSummary(TARGET_DATABASE_URL)]);
  let problems = 0;
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const from = a.get(name);
    const to = b.get(name);
    let status = 'ok';
    if (!from) status = 'só no destino';
    else if (!to) status = 'FALTA NO DESTINO';
    else if (from.n !== to.n) status = 'QUANTIDADE DIFERENTE';
    else if (from.hash !== to.hash) status = 'CONTEÚDO DIFERENTE';
    if (status !== 'ok' && status !== 'só no destino') problems += 1;
    console.log(`${name.padEnd(28)} origem ${String(from ? from.n : '-').padStart(7)}  destino ${String(to ? to.n : '-').padStart(7)}  ${status}`);
  }
  console.log(problems ? `\n${problems} tabela(s) com diferença — NÃO troque o DATABASE_URL.` : '\nTodas as tabelas iguais.');
  process.exitCode = problems ? 1 : 0;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
