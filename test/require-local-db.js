// Os testes de integração criam e apagam pedidos, clientes e cupons e alteram estoque. Rodando
// contra o banco da loja, a "restauração" do estoque no fim de cada teste apagaria uma venda real
// feita no meio. Só banco local (como o do CI) passa sem a confirmação explícita abaixo.
require('dotenv').config({ quiet: true });

const testDbHost = (() => {
  try { return new URL(process.env.DATABASE_URL).hostname; } catch { return ''; }
})();
if (!['localhost', '127.0.0.1', '::1'].includes(testDbHost) && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
  console.error(`[test] DATABASE_URL aponta para "${testDbHost || '?'}", que não é um banco local. Use um PostgreSQL de teste local ou, se tiver certeza de que esse banco é descartável, defina ALLOW_REMOTE_TEST_DB=true.`);
  process.exit(1);
}
