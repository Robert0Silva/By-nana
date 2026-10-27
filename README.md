# By NaNa

Loja virtual em Node.js, PostgreSQL e JavaScript sem framework. O servidor entrega a loja, o painel administrativo e a API; o checkout funciona manualmente por WhatsApp e pode integrar o checkout hospedado do PagBank.

## Desenvolvimento seguro

1. Crie um banco PostgreSQL exclusivo para desenvolvimento/QA. Não use o banco de produção.
2. Copie `.env.example` para `.env` e preencha `DATABASE_URL`, `SESSION_SECRET` e `ADMIN_SESSION_SECRET`.
3. Execute `npm install` e `node db/migrate.js`.
4. Inicie com `npm start` e abra `http://localhost:8787`.

## Qualidade

- `npm run lint`: análise estática.
- `npm test`: testes de unidade (descontos, webhook do PagBank) e de integração da API. Os de integração criam e apagam pedidos e mexem em estoque, então só rodam com `DATABASE_URL` apontando para `localhost`/`127.0.0.1` (como no CI); para outro banco descartável é preciso definir `ALLOW_REMOTE_TEST_DB=true` conscientemente. Nunca rode contra o banco da loja.
- `npm run test:e2e`: testes de interface no Chromium, incluindo uma compra real de ponta a ponta (`test/purchase-flow.spec.js`) e o painel (`test/admin-flow.spec.js`), ambos conferidos no banco de teste.
- `npm run test:e2e:firefox` / `npm run test:e2e:webkit`: testa um motor específico.
- `npm run test:e2e:all`: executa a suíte nos três navegadores.
- `npm run test:ci`: gate completo usado pelo GitHub Actions.

O workflow em `.github/workflows/ci.yml` cria um PostgreSQL efêmero e só então executa lint e todos os testes, sem tocar dados reais.

## PagBank

Mantenha `PAYMENT_PROVIDER` vazio para o checkout manual. Antes de ativar pagamentos reais, use `PAYMENT_PROVIDER=pagseguro`, `PAGSEGURO_SANDBOX=true` e um token sandbox. Valide ao menos pagamento aprovado, recusado, pendente/expirado, webhook duplicado e cancelamento. Só depois replique a configuração em produção com o token real e `PAGSEGURO_SANDBOX=false`.

## Produção

O `render.yaml` descreve o serviço. Segredos e a URL do banco de produção devem existir apenas nas variáveis protegidas do Render. O deploy da branch `main` deve permanecer condicionado ao status obrigatório do workflow **CI** nas regras de proteção da branch.

Site, banco (Render Postgres `by-nana-db`) e fotos (disco persistente em `/var/data`) ficam todos no Render. A mudança a partir do Neon, com o resgate das fotos que só existem no servidor e a conferência da cópia do banco, está em [docs/migracao-render.md](docs/migracao-render.md).

## Monitoramento

O Render reinicia o serviço quando `/api/health` falha (confere o processo e o banco). Para saber que o site caiu, cadastre essa URL num monitor externo gratuito (UptimeRobot, Better Stack ou similar) com aviso por e-mail ou WhatsApp a cada 5 minutos.

Erros 500 e falhas do banco geram um e-mail de alerta para `ALERT_EMAIL` (ou `STORE_NOTIFY_EMAIL`, se o primeiro estiver vazio), no máximo um a cada 30 minutos, com a contagem dos erros do período. Exige o Resend configurado. O detalhe completo fica no log do Render.

## Backup e recuperação

O Render Postgres pago permite restaurar o banco para um ponto no tempo (`by-nana-db` → Recovery); confira no painel por quantos dias o plano guarda esse histórico. Enquanto o banco ainda estiver no Neon, o equivalente é Branches → Restore.

Além disso, faça uma cópia própria semanal, fora do provedor, com o `pg_dump` (vem com o PostgreSQL 17, a mesma versão do banco):

    pg_dump "<URL do banco de produção>" --format=custom --no-owner --file=bynana-AAAA-MM-DD.dump

Guarde o arquivo num lugar privado (ele contém dados de clientes). Um backup só vale se a restauração funcionar, então teste ao menos uma vez por mês num banco vazio de desenvolvimento, nunca no de produção:

    pg_restore --no-owner --dbname="<URL de um banco vazio de teste>" bynana-AAAA-MM-DD.dump
    psql "<URL de um banco vazio de teste>" -c "SELECT (SELECT count(*) FROM orders) AS pedidos, (SELECT count(*) FROM products) AS produtos, (SELECT count(*) FROM customers) AS clientes"

Os números precisam bater com os do painel. As fotos enviadas pelo painel não estão no banco: ficam no disco persistente do Render (`UPLOAD_DIR`), que tem snapshots próprios (`by-nana` → Disks). Para uma cópia fora do Render, `node db/rescue-uploads.js --write --out <pasta>` baixa do site todas as fotos que o banco referencia (ver docs/migracao-render.md).
