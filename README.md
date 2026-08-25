# By NaNa

Loja virtual em Node.js, PostgreSQL e JavaScript sem framework. O servidor entrega a loja, o painel administrativo e a API; o checkout funciona manualmente por WhatsApp e pode integrar o checkout hospedado do PagBank.

## Desenvolvimento seguro

1. Crie um banco PostgreSQL exclusivo para desenvolvimento/QA. Não use o banco de produção.
2. Copie `.env.example` para `.env` e preencha `DATABASE_URL`, `SESSION_SECRET` e `ADMIN_SESSION_SECRET`.
3. Execute `npm install` e `node db/migrate.js`.
4. Inicie com `npm start` e abra `http://localhost:8787`.

## Qualidade

- `npm run lint`: análise estática.
- `npm test`: testes de integração da API (escrevem no banco configurado).
- `npm run test:e2e`: testes de interface no Chromium.
- `npm run test:e2e:firefox` / `npm run test:e2e:webkit`: testa um motor específico.
- `npm run test:e2e:all`: executa a suíte nos três navegadores.
- `npm run test:ci`: gate completo usado pelo GitHub Actions.

O workflow em `.github/workflows/ci.yml` cria um PostgreSQL efêmero e só então executa lint e todos os testes, sem tocar dados reais.

## PagBank

Mantenha `PAYMENT_PROVIDER` vazio para o checkout manual. Antes de ativar pagamentos reais, use `PAYMENT_PROVIDER=pagseguro`, `PAGSEGURO_SANDBOX=true` e um token sandbox. Valide ao menos pagamento aprovado, recusado, pendente/expirado, webhook duplicado e cancelamento. Só depois replique a configuração em produção com o token real e `PAGSEGURO_SANDBOX=false`.

## Produção

O `render.yaml` descreve o serviço. Segredos e a URL do banco de produção devem existir apenas nas variáveis protegidas do Render. O deploy da branch `main` deve permanecer condicionado ao status obrigatório do workflow **CI** nas regras de proteção da branch.
