# Relatório de Implementação — By NaNa

Complementa `RELATORIO_AUDITORIA_ECOMMERCE.md` (mantido sem alterações). Cada fase acrescenta uma seção a este arquivo.

---

## Fase 0 — Análise inicial e plano (10/11/2026)

**Situação:** concluída. Nenhum código alterado. Fase 1 autorizada em 10/11/2026, com DC-4 e DC-5 aprovadas (ver seção "Fase 1").

### 0.1 Estado do repositório

| Verificação | Resultado |
|---|---|
| Branch | `melhorias-ux-admin` |
| Commit | `1eea3d2` (o mesmo da auditoria) |
| Arquivos rastreados modificados | nenhum |
| Arquivos não rastreados | `RELATORIO_AUDITORIA_ECOMMERCE.md`, `test/regras-negocio.test.js` (criados na auditoria), este relatório |
| Stash | vazio |
| Arquivos citados na auditoria | todos existem e estão iguais aos analisados |
| Remoto | `git fetch` falhou: *repository not found* (`softdevconsultoria/ByNana-V2`). Não dá para saber se há commits de outras pessoas no remoto. A branch local está 23 commits à frente da última `origin/main` conhecida. |

**Risco de conflito:** baixo localmente. Como não há como confirmar o remoto, se outra pessoa estiver mexendo em `serve.js` (arquivo central, ~4.100 linhas), o merge das fases tende a conflitar. Recomendo confirmar o acesso ao repositório antes da Fase 1.

### 0.2 Isolamento dos testes

| Item | Situação |
|---|---|
| `.env` aponta para | Neon (produção). Não acessado. |
| Banco de teste | PostgreSQL 18.4 embutido, instalado só na pasta temporária da sessão, porta 54329, descartável |
| Variáveis de teste | `DATABASE_URL`, segredos de sessão, `RESEND_API_KEY`, `EMAIL_FROM`, `STORE_NOTIFY_EMAIL` e `PAYMENT_PROVIDER` sobrescritos no ambiente do processo (o `dotenv` não sobrescreve variável já definida) |
| Trava `test/require-local-db.js` | presente em `audit`, `routes`, `regras-negocio`, `admin-flow.spec`, `purchase-flow.spec` |
| **Lacuna encontrada** | `test/checkout-guard.spec.js` **não** usa a trava. O servidor que ele sobe lê o `.env`, então, rodado sem sobrescrever `DATABASE_URL`, conecta no Neon. Ele só lê o catálogo e intercepta `/api/orders`, mas todo `serve.js` iniciado roda as varreduras automáticas (`sweepAbandonedCarts` com envio de e-mail, `sweepExpiredOnlineOrders` cancelando pedidos) contra o banco a que estiver ligado. Correção prevista na Fase 4 e, até lá, nunca rodar Playwright sem o ambiente de teste. |

### 0.3 PagBank

| Item | Situação |
|---|---|
| Variáveis no `.env` local | **não existem** `PAYMENT_PROVIDER`, `PAGSEGURO_TOKEN` nem `PAGSEGURO_SANDBOX` (verificados só os nomes) |
| Produção (Render) | as três estão declaradas com `sync: false`; os valores não são visíveis daqui. Não foram consultados. |
| Consequência | A Fase 1 será validada com **servidor PagBank simulado (mock)**. A homologação real em sandbox fica **pendente** até existir um token de sandbox no `.env` local e uma URL pública para receber webhooks do sandbox (túnel, ex. ngrok/cloudflared). Nenhuma evidência de sandbox será declarada sem execução real. |
| Ponto a confirmar na documentação | Endpoints de consulta (`GET /checkouts/{id}`, `GET /orders/{id}`), de estorno (`POST /charges/{id}/cancel`, com valor parcial) e o formato do evento de checkout expirado. Serão conferidos na documentação oficial do PagBank antes de codificar e registrados no relatório da Fase 1. |

### 0.4 Divergências entre auditoria e código atual

Nenhuma no código. Uma observação sobre o ambiente: a migração (`db/migrate.js`) roda **a cada deploy** no Render (`startCommand`). Qualquer alteração de schema destas fases vai para o Neon automaticamente no próximo deploy. Por isso todas as migrações serão aditivas (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, ampliação de `CHECK`), testadas no banco local partindo de um banco já populado, e cada uma terá um script de reversão testado localmente.

### 0.5 Plano técnico

#### Fase 1 — Segurança financeira e PagBank

| Item | Implementação | Arquivos |
|---|---|---|
| Base | Tabela `order_events` (criada já aqui e reaproveitada na Fase 2 para o histórico completo): pedido, tipo, status anterior/novo de pedido e de pagamento, origem (`system`/`webhook`/`admin`/`customer`), admin responsável, justificativa, metadados JSONB, data. Gravada na mesma transação da mudança. | `db/schema.sql`, `serve.js` |
| Base | `payment_status` ganha `refund_pending`, `partially_refunded` e `refund_failed`. Colunas `refunded_amount`, `payment_charge_id` e `payment_checked_at`. | `db/schema.sql` |
| Base | O contrato do provedor ganha `getPaymentStatus(reference)` e `refund({ chargeId, amount, idempotencyKey })`. URL da API configurável **apenas em ambiente de teste** para apontar ao mock local. | `payment-provider.js`, `payment-providers/pagseguro.js` |
| B-01 | `DECLINED` vira evento "tentativa recusada" e o pedido continua `pending` com o estoque reservado. Só `EXPIRED` confirmado ou a varredura com consulta cancelam. Pagamento aprovado em pedido cancelado: o pedido não é reativado sozinho, fica marcado `paid` + alerta "decisão necessária" no painel (reativar com estoque ou estornar). | `pagseguro.js`, `serve.js` (webhook) |
| B-02 | Estorno integral **antes do envio** cancela e repõe estoque. **Depois do envio** só registra o financeiro, sem mexer no status logístico nem no estoque. Estorno parcial vira `partially_refunded`, sem cancelar. A reposição física fica para o fluxo de devolução (Fase 3). Reposição idempotente pelo histórico do pedido. | `pagseguro.js`, `serve.js` |
| B-03 | Cancelar pedido `paid`: `refund_pending` + chamada de estorno com chave idempotente. Confirmado vira `refunded`; falhou vira `refund_failed`, visível no painel com "tentar de novo". A cliente só recebe "valor devolvido" depois da confirmação. | `serve.js`, `admin.js` |
| B-04 | A varredura consulta `getPaymentStatus` antes de cancelar. Se a API falhar, não cancela, registra e tenta na próxima rodada (com teto e alerta). Botão "Atualizar pagamento" no painel. | `serve.js`, `admin.js` |
| B-06 (financeiro) | Eventos: checkout criado, tentativa recusada, aprovado, expirado, estorno solicitado/confirmado/falhou, consulta feita. Linha do tempo financeira no detalhe do pedido. | `serve.js`, `admin.js` |
| Testes | Novo `test/pagamentos.test.js` com mock HTTP do PagBank: aprovado, recusado, recusado→aprovado, expirado, duplicado, atrasado/fora de ordem, assinatura inválida, estorno parcial/integral, antes do envio/depois da entrega, falha de comunicação, consulta indisponível, cancelamento de pago, duas notificações simultâneas. Os testes da auditoria que hoje falham (regras #10, #13, #14) devem passar **sem mudar a expectativa**. | `test/` |

#### Fase 2 — Integridade operacional e compra

| Item | Implementação |
|---|---|
| B-05 | Tabela de transições no servidor: `novo→em_andamento→enviado→concluido`; cancelar só de `novo`/`em_andamento`. Reabertura (`cancelado→novo`, `concluido→enviado` etc.) por rota própria, com justificativa obrigatória e permissão (Fase 3; até lá só owner). |
| B-06 | `order_events` passa a registrar criação, todas as mudanças de status, envio, entrega, reabertura. Linha do tempo completa no painel. |
| B-07 | Reconciliação da sacola a cada carregamento do catálogo: itens indisponíveis, ocultos ou acima do estoque ficam marcados e fora do total, com ação "remover". Nada é apagado sem ação da cliente. |
| B-08 | `/api/coupons/validate` recebe token da cliente ou telefone e aplica a mesma regra de 1ª compra. O pedido devolve `couponRejected: { code, reason }` e a sacola mostra o motivo. |
| B-09 | `/api/orders/list` paginado (cursor por data), busca por código, nome, telefone, e-mail, filtro por status e período; índices para isso. |
| B-10 a B-15 | Lista branca de pagamento; `23001` + `23503`; quantidade inteira; 27 UFs; avise-me em toda reposição (com deduplicação pelo `notified_at` já existente); `/api/data` só com promoções vigentes. |
| RC-1/RC-2 | Tabela `store_settings` para descontos automáticos (liga/desliga, faixas, %, acumula com promoção) e coluna `stackable_with_promotions` em `coupons`. **Valores iniciais iguais aos atuais**, sem mudar preço nenhum até você decidir. |
| RC-3 | Só depois da sua escolha. |

#### Fase 3 — Pós-venda e permissões

| Item | Implementação |
|---|---|
| T02-T04, S07 | Tabelas `return_requests`, `return_request_items`, eventos próprios. Tipos troca/devolução/arrependimento, estados da solicitação conforme o plano. Prazo de 7 dias contado da entrega (`concluido` ou data informada pela loja). Fora do prazo: arrependimento recusado automaticamente com justificativa, troca a critério da loja. Reposição de estoque só em "produto recebido + aprovado", idempotente. Reembolso usa o `refund` da Fase 1 quando o pedido foi pago online, ou registro manual quando foi combinado no WhatsApp. O status do pedido **não** muda; a devolução é um modelo à parte. |
| Cliente | Solicitação pela área "Meus pedidos" (cliente logada). Visitante continua pelo WhatsApp, mas a loja registra no painel. |
| A04/RC-4 | Permissões por usuário (lista de chaves) verificadas no backend em cada rota. Owner tem todas. **Na migração, os staff atuais recebem exatamente o acesso que têm hoje**; a restrição só entra depois que você aprovar a matriz. |

#### Fase 4 — Lançamento

Trava de banco local também em `checkout-guard.spec.js` e varreduras desligadas quando `NODE_ENV=test`; correção da asserção do audit #28 (aceitar 403 ou 409, mantendo a verificação de que sobra exatamente um owner); `regras-negocio` e `pagamentos` no `npm test`; Playwright nos três navegadores; revisão de logs, mensagens, links/imagens quebradas, documentação (README, `.env.example`); homologação PagBank em sandbox (se as credenciais existirem); checklist de lançamento.

### 0.6 Decisões que dependem de você

| # | Decisão | Proposta para discutir |
|---|---|---|
| DC-1 | **RC-1** descontos automáticos | Configuráveis com os valores atuais. Definir: continuam acumulando com promoção? Margem mínima? |
| DC-2 | **RC-2** promoção + cupom | Padrão por cupom: "acumula" (como hoje) ou "não acumula" |
| DC-3 | **RC-3** sob consulta | (a) só orçamento via WhatsApp, sem sacola; (b) entra na sacola sem reservar estoque; (c) manter como está |
| DC-4 | Pagamento aprovado em pedido já cancelado (B-01) | Sugestão: alerta no painel com ações "reativar se houver estoque" / "estornar". Nunca automático. |
| DC-5 | Cancelar pedido pago (B-03) | Estorno automático via API (sugestão) ou só marcar "estorno pendente" para a loja fazer no painel do PagBank |
| DC-6 | Reabertura de pedidos (B-05) | Só owner, com justificativa |
| DC-7 | Formas de pagamento aceitas (B-10) | As da tela hoje: Pix, Cartão de crédito, Cartão de débito, Pagamento online. Dinheiro/retirada? |
| DC-8 | Matriz de permissões do staff (RC-4) | Apresentada na Fase 3 antes de aplicar |
| DC-9 | Texto da política de trocas (RC-5) | O sistema seguirá o art. 49. Mudar o texto da página depende de revisão jurídica. |
| DC-10 | Solicitação de devolução pela cliente | Só logada (sugestão) ou também visitante com código do pedido + telefone |

DC-4 e DC-5 precisam de resposta **antes** da Fase 1. As demais podem esperar a fase delas.

### 0.7 Riscos

| Risco | Mitigação |
|---|---|
| Remoto inacessível: conflitos com trabalho de terceiros | Confirmar acesso antes de começar |
| Migração roda sozinha no próximo deploy | Só migrações aditivas, scripts de reversão, teste a partir de banco populado |
| Contrato real do PagBank diferente do mock | Conferir a documentação antes de codificar; homologação em sandbox obrigatória antes de ativar |
| Sem token de sandbox, a Fase 1 sai sem homologação externa | Marcada como pendente; pagamento online continua desligado |
| `serve.js` monolítico: mudanças grandes no mesmo arquivo | Extrair só o necessário (ex. `order-events.js`, `order-status.js`), sem reescrever |
| CI usa PG 16; local PG 18; Neon com versão desconhecida | Rodar a suíte nas duas versões quando possível; confirmar a versão do Neon (somente leitura, com sua autorização) |

### 0.8 Estimativa

| Fase | Esforço de implementação + testes | Observação |
|---|---|---|
| 1 | 2–3 dias | + homologação sandbox quando houver credencial |
| 2 | 3–4 dias | RC-1/2/3 dependem de decisão |
| 3 | 4–5 dias | Maior em modelo de dados e telas do painel |
| 4 | 1–2 dias | + execução do checklist |

### 0.9 Matriz da fase

| Item | Situação |
|---|---|
| Implementado | Não (fase de análise) |
| Testado | Sim: verificação de repositório, isolamento e configuração |
| Aprovado | Aguardando autorização |
| Evidência | Seções 0.1–0.4 |
| Pendência | Acesso ao remoto; credencial de sandbox; DC-4 e DC-5 |

---

## Fase 1 — Segurança financeira e PagBank (10/11/2026)

**Situação, separada como pedido:**

| Etapa | Situação |
|---|---|
| 1. Implementação | **Concluída** (B-01 a B-04, DC-4, DC-5, histórico financeiro, painel) |
| 2. Testes automatizados | **Concluídos**: 28/28 (26 na entrega + 2 após a homologação, ver 1.14) no novo `test/pagamentos.test.js` (PagBank simulado) e nenhuma falha nova nas suítes existentes |
| 3. Homologação PagBank em sandbox | **Pendente.** Não há token de sandbox no ambiente local. Nenhuma chamada foi feita ao sandbox nem à produção. |
| 4. Autorização para produção | **Não solicitada e não concedida.** Pagamento online continua desligado; nada foi publicado. |

Nenhum commit, push, merge, deploy ou acesso ao Neon foi feito. A Fase 2 não foi iniciada.

### 1.1 Verificação do GitHub (antes de qualquer alteração)

| Verificação | Resultado |
|---|---|
| Branch / commit | `melhorias-ux-admin` / `1eea3d2` |
| Modificados / não rastreados | nenhum modificado; não rastreados: os dois relatórios e `test/regras-negocio.test.js` |
| Stash | vazio |
| Remotos | `github` → `github.com/Robert0Silva/By-nana.git` (é o upstream da branch); `origin` → `github.com/softdevconsultoria/ByNana-V2.git` |
| `git fetch github` | **funcionou** |
| `git fetch origin` | *repository not found* (o mesmo erro da Fase 0; esse remoto não é o upstream da branch) |
| Comparação | local está **3 commits à frente e 0 atrás** de `github/melhorias-ux-admin` (`e1677a7`), e 23 à frente de `github/main`. Nenhuma divergência: ninguém publicou nada na branch que conflite com este trabalho. |

Correção da Fase 0: o acesso ao GitHub existe pelo remoto `github`; só o `origin` (de outra organização) está inacessível. Nenhum remoto foi alterado.

### 1.2 Documentação oficial do PagBank conferida

Lida em developer.pagbank.com.br em 10/11/2026 (páginas de referência atualizadas entre 26/08 e 13/10/2026).

| Ponto | O que a documentação confirma | Status |
|---|---|---|
| Autenticação | `Authorization: Bearer <token>`; sandbox em `https://sandbox.api.pagseguro.com` | Confirmado |
| Consulta de checkout | `GET /checkouts/{id}` (CHEC_…), status `ACTIVE`/`INACTIVE`; descrição diz que traz "todos os pagamentos associados", **mas o exemplo e o schema não mostram a lista** | Parcial: formato da lista de pagamentos **não confirmado** |
| Consulta de pedido | `GET /orders/{id}` (ORDE_…) com `charges[]`; cada cobrança tem `id` (CHAR_…), `status` e `amount.summary {total, paid, refunded}` | Confirmado |
| Achar pedido pela cobrança | `GET /orders?charge_id=` → `{ orders: [...] }`. **Não existe** busca por `reference_id` | Confirmado |
| Estorno | `POST /charges/{id}/cancel` com `{ amount: { value: centavos } }`; resposta **201**; parcial mantém `PAID` com `summary.refunded` parcial; integral vira `CANCELED` | Confirmado |
| Erros | `error_messages[]` com `code`/`description`; 40007 *unabled_refund* (já estornado ou acima do permitido), 40008 *refund_temporarily_unavailable*, 40016 *charge_not_eligible*, 40005 *idempotency_key_in_use* (409) | Confirmado |
| Status de cobrança nos webhooks | `PAID`, `IN_ANALYSIS`, `DECLINED`, `CANCELED`, `WAITING`. `AUTHORIZED` **não aparece** nas páginas lidas | Confirmado (mantido `AUTHORIZED → pendente` por segurança) |
| Evento de checkout | `EXPIRED` enviado para `notification_urls`; payload é o objeto checkout | Confirmado; formato exato a validar no sandbox |
| Assinatura | `x-authenticity-token` = SHA-256 de `"{token}-{corpo bruto}"`; diferente = descartar | Confirmado (já era assim; mantido) |
| Idempotência | A chave vai num cabeçalho e repetir a chave devolve a mesma resposta. **O nome do cabeçalho não está publicado** | **Não confirmado.** Usado `x-idempotency-key`, a validar no sandbox |
| Estorno de Pix | A cobrança Pix traz o link `CHARGE.CANCEL`, mas não há regra escrita | **Não confirmado** |

Como a busca por `reference_id` não existe e o checkout pode não listar os pagamentos, o servidor passou a guardar o pedido (ORDE_) e a cobrança (CHAR_) do PagBank assim que chega o primeiro webhook transacional.

### 1.3 O que foi implementado

**Histórico financeiro (`order_events`).** Cada evento grava o pedido, o tipo, o status anterior e o novo (do pedido e do pagamento), a origem (`webhook`, `sweep`, `admin`, `checkout`), o admin responsável, a justificativa, metadados JSONB e a data. É gravado na mesma transação da mudança. Uma `dedupe_key` com índice único impede registrar duas vezes o mesmo fato vindo de webhook repetido ou concorrente. Eventos: checkout criado/falhou, aviso de link vencido, pagamento aprovado, tentativa recusada, pagamento expirado, consulta feita/falhou, pagamento após cancelamento, estorno solicitado/resposta/nova tentativa/confirmado/parcial/falhou, estorno após envio, cancelamento, mudança de status, decisão da equipe, reativação negada. Os eventos são encadeados: cada um parte do estado em que o anterior terminou. Um teste verifica isso em todos os 29 pedidos da suíte.

**Estados financeiros.** Novos `refund_pending`, `partially_refunded` e `refund_failed`. Colunas novas: `paid_amount`, `refunded_amount`, `payment_order_id`, `payment_charge_id`, `payment_checked_at`, `payment_check_failures` e `payment_attention` (`paid_after_cancel`, `check_failing` ou `refund_uncertain`). Nova tabela `payment_refunds` (uma linha por tentativa de estorno, com chave de idempotência). Um índice parcial permite **no máximo uma tentativa em aberto por pedido**.

**Contrato do provedor.** Ganhou `getPaymentStatus({ checkoutId, providerOrderId, chargeId })` e `refund({ chargeId, amount, idempotencyKey, expectedRefundedTotal })`. A consulta, o pedido de estorno e a confirmação ficam separados. Os erros saem classificados: `transient` (timeout, rede, 5xx, 40004, 40008) significa resultado desconhecido; os demais são recusa do PagBank. Em `NODE_ENV=test` o provedor só fala com `PAGSEGURO_API_BASE_URL` (o simulado); sem essa variável, **recusa a chamada antes de abrir conexão**. Fora de teste, a variável é ignorada.

**B-01: pagamento recusado.** `DECLINED` não cancela mais o pedido. O pedido segue pendente, a reserva continua e a tentativa entra no histórico. A cliente pode tentar de novo no mesmo link, e não há nova baixa de estoque. O e-mail de "pedido cancelado" por recusa deixou de ser enviado.

**B-02: estorno e estoque.** Estorno integral antes do envio (`novo` ou `em_andamento`) cancela o pedido e repõe o estoque uma única vez. Depois do envio (`enviado` ou `concluido`) é só financeiro: status e estoque ficam intactos, e o evento `refund_after_shipment` registra o fato. Estorno parcial vira `partially_refunded` sem cancelar, e o pedido pode continuar sendo enviado. A devolução física fica para a Fase 3.

**B-03 / DC-5: cancelar pedido pago.** Cancelar no painel um pedido `paid` ou `partially_refunded` passa obrigatoriamente pelo estorno:

1. Numa transação: trava o pedido, cria a tentativa com chave única, cancela, devolve as peças e marca `refund_pending`.
2. Chama o PagBank com a chave de idempotência.
3. Aplica o resultado. Vira `refunded` só quando a resposta ou o webhook mostram o valor estornado. Recusa definitiva vira `refund_failed` (nova tentativa usa chave nova). Timeout ou rede vira `refund_failed` com alerta "estorno sem confirmação". Nesse caso, "Tentar novamente" **consulta o PagBank antes** e só reenvia com a **mesma chave**.

A equipe não contorna o fluxo: não existe rota para alterar `payment_status`, e o status do pedido não pode ir para enviado/concluído nem ser reativado enquanto houver estorno em andamento, com falha ou concluído. A cliente recebe "estorno solicitado" no e-mail de cancelamento e "estorno confirmado" só depois da confirmação do PagBank.

**DC-4: pagamento aprovado após cancelamento.** O pagamento é registrado como `paid`, o pedido continua cancelado e é criado o evento `payment_after_cancel`. O painel mostra o alerta "Pago após cancelamento — decidir" e um e-mail vai para a loja (se `STORE_NOTIFY_EMAIL` estiver configurado). Há duas ações, ambas com justificativa obrigatória e registradas no histórico. "Reativar" valida e baixa o estoque na mesma transação, em tudo ou nada; sem estoque, nada muda e fica o evento `reactivation_denied`. "Solicitar estorno" segue o fluxo da DC-5.

**B-04: expiração.** A varredura (a cada 15 min e ao subir) consulta o PagBank antes de decidir. Pago → aplica o pagamento. Checkout comprovadamente `EXPIRED`/`INACTIVE` sem cobrança capturada → cancela e devolve o estoque. Falha ou resposta inconclusiva → **não cancela**, registra, espaça as tentativas (15 min × 2ⁿ, até 6 h), alerta a equipe a partir da 3ª e para na 12ª. Sem gateway ativo, a varredura não faz nada (antes ela cancelava os pendentes mesmo assim). Também reconcilia estornos `refund_pending` parados há mais de 10 minutos.

**Painel.** O botão "Financeiro" em cada pedido online abre: situação, valor pago, valor estornado, valor ainda não estornado, cobrança, última consulta (e falhas), alertas, "Atualizar pagamento", "Tentar estorno novamente", "Reativar" e "Solicitar estorno" (DC-4) e o histórico financeiro. A lista mostra os selos dos novos estados e o selo de alerta. O painel aberto continua aberto quando a lista é atualizada. Toda ação é validada no servidor (sessão de admin, estado do pagamento, estoque).

### 1.4 Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `payment-providers/pagseguro.js` | consulta, estorno, classificação de erros, interpretação de cobranças (pago/parcial/estornado), evento EXPIRED, trava de rede em teste |
| `payment-provider.js` | documentação do contrato (2 funções novas) |
| `serve.js` | seção "financeiro do pedido" (helpers de evento, transação, aplicação de webhook/consulta, estorno, nova tentativa, reativação DC-4), webhook reescrito, rotas `/api/orders/payment/{detail,refresh,refund,retry-refund,reactivate}`, `/api/orders/status` com estorno obrigatório e histórico, varredura com consulta, e-mails de estorno, campos financeiros na lista. Removida `isAllowedPaymentTransition` (substituída) |
| `db/schema.sql` | bloco aditivo "Fase 1" |
| `db/rollback/fase1-pagamentos.down.sql` | **novo**, reversão manual |
| `assets/js/admin.js`, `assets/css/admin.css` | painel financeiro e selos |
| `test/pagamentos.test.js` | **novo**, 28 testes com PagBank simulado |
| `test/financeiro-painel.spec.js` | **novo**, teste no navegador do painel (DC-4) |
| `test/unit.test.js` | uma expectativa ampliada (ver 1.7) |

Total: 7 arquivos modificados (+1207 / −186 linhas) e 3 novos.

### 1.5 Migração e reversão

A migração está só em `db/schema.sql` (executado pelo `db/migrate.js`) e é aditiva e idempotente. O único comando de recriação é o `CHECK` de `payment_status`, refeito como **superconjunto** do anterior, no mesmo padrão já usado para `orders_status_check`.

Validação no banco local descartável (`127.0.0.1:54329/bynana_test`), populado antes com 12 pedidos sintéticos cobrindo todas as combinações existentes de pagamento e status, mais 76 variações de produto:

| Passo | Resultado |
|---|---|
| 1ª execução (com erro de coluna duplicada no rascunho) | falhou e **não deixou rastro**: o schema roda numa transação implícita. Corrigido. |
| Migração | ok; colunas e tabelas novas criadas |
| 2ª execução (idempotência) | ok, sem mudanças |
| Integridade | hash MD5 dos pedidos (id, status, pagamento, total, referência) **idêntico antes e depois** (`8a926134…`); 12 pedidos; estoque total 760 inalterado |
| Reversão com pedido em `refund_pending` | **recusada** pelo próprio script (protege dado financeiro) |
| Reversão sem estados novos | ok; o banco volta ao estado anterior (mesmo hash, CHECK original, sem colunas e tabelas novas) |
| Reaplicação após reversão | ok |

Os pedidos sintéticos foram apagados depois. **Atenção:** o Render executa `db/migrate.js` a cada deploy, então este bloco chega ao Neon no próximo deploy. A reversão nunca é automática: exige remover o bloco do `schema.sql` e rodar o script manualmente.

### 1.6 Testes executados

Ambiente: Node 20.18.1, PostgreSQL 18.4 local, `NODE_ENV=test`, todas as variáveis sensíveis sobrescritas (ver 0.2). ESLint sem avisos.

| Suíte | Antes (auditoria) | Agora | Observação |
|---|---|---|---|
| `unit` | 6/6 | **6/6** | uma expectativa ampliada (1.7) |
| `routes` | 32/32 | **32/32** | |
| `audit` | 28/29 (+ #28 intermitente) | **28/29**; #28 intermitente | #14 já falhava: erro 23001 do PG 18 (B-11, Fase 2). #28 falhou também **no commit original** (cópia via `git archive`, 3 de 3 execuções): falha preexistente do teste (403 x 409), sem relação com esta fase |
| `regras-negocio` | 12/20 | **15/20** | **#10, #13 e #14 passaram sem nenhuma mudança no teste.** As 5 restantes são da Fase 2 (B-10, B-12, B-13, B-05) |
| `pagamentos` (novo) | — | **26/26** (executado 3 vezes); 28/28 após a correção da 1.14 | |
| Playwright chromium | 15/15 | **16/16** | inclui o novo `financeiro-painel.spec.js` (3 execuções seguidas sem falha) |

Os 23 cenários obrigatórios em `test/pagamentos.test.js`:

| # | Cenário | Teste |
|---|---|---|
| 1 | Pagamento aprovado | 01 |
| 2 | Recusado | 02 |
| 3 | Recusado → aprovado | 03 |
| 4 | Expirado (vencido cancela; ativo não; pago sem webhook é achado pela consulta) | 04 (varredura real, 2º servidor) |
| 5 | Webhook duplicado | 05 |
| 6 | Webhook atrasado | 06 |
| 7 | Fora de ordem | 07 |
| 8 | Assinatura inválida (errada, vazia, corpo alterado) | 08 |
| 9 | Estorno integral | 09 |
| 10 | Estorno parcial | 10 |
| 11 | Estorno antes do envio | 11 |
| 12 | Estorno após envio | 12 |
| 13 | Estorno após entrega | 13 |
| 14 | Falha de comunicação | 14 |
| 15 | Consulta indisponível | 15 |
| 16 | Cancelamento de pedido pago (assíncrono) | 16 |
| 17 | Estorno duplicado (e acesso sem sessão = 401) | 17 |
| 18 | Notificações e cancelamentos simultâneos | 18 |
| 19 | Aprovado após cancelamento | 19 |
| 20 | Reativação com estoque | 20 |
| 21 | Reativação sem estoque | 21 |
| 22 | Falha na transação de estoque (2 peças, tudo ou nada) | 22 |
| 23 | Repetição após timeout (processado / não processado / recusado) | 23 a/b/c |

Verificações transversais: um teste de isolamento; um teste que confere o histórico encadeado e o estoque (nunca mais reposição do que baixa, e todo cancelado com a peça de volta) **em todos os pedidos da suíte**; e um teste que confirma que os logs do servidor não citam host real do PagBank.

### 1.7 Expectativa de teste alterada (com justificativa)

Apenas uma, em `test/unit.test.js`: o retorno do webhook passou a incluir `providerOrderId`, `chargeId`, `chargeStatus`, `paidAmount` e `refundedAmount`, necessários para estornar e para o histórico. O `deepEqual` foi ampliado com esses campos, e os três campos originais (`orderId`, `status`, `providerReference`) continuam verificados com os mesmos valores. Nenhum outro teste foi alterado ou removido. A regra "recusado = `failed`" do provedor se manteve (o significado mudou no servidor: tentativa, não cancelamento).

### 1.8 Evidências de isolamento

| Evidência | Como |
|---|---|
| Banco | Todos os comandos rodaram com `DATABASE_URL=127.0.0.1:54329/bynana_test`, conferido antes de cada execução. As suítes usam `require-local-db`. O Neon não foi acessado. |
| PagBank | Servidores de teste com `PAGSEGURO_API_BASE_URL` apontando para o simulado em `127.0.0.1`. O teste "isolamento" prova que, sem essa variável, o provedor recusa as chamadas (`bloqueada em ambiente de teste`). O servidor do `regras-negocio` (sem simulado) teve o estorno do teste #10 recusado por essa trava, sem nenhuma conexão externa. |
| Mock | O simulado registra todas as chamadas recebidas. Os testes conferem corpo (`amount.value` em centavos), cabeçalho de idempotência e quantidade de pedidos de estorno. |
| E-mails | `RESEND_API_KEY` vazio em todos os servidores de teste: nada foi enviado |

### 1.9 Pendências para a homologação no sandbox

Pré-requisitos: um token de sandbox no `.env` local (`PAYMENT_PROVIDER=pagseguro`, `PAGSEGURO_SANDBOX=true`), um banco local e uma URL pública temporária (túnel) em `SITE_URL` para receber webhooks. Roteiro:

1. Pagamento com cartão aprovado e recusado, e Pix: conferir o payload real dos webhooks e a assinatura.
2. Checkout vencido: conferir o evento `EXPIRED` e **se `GET /checkouts/{id}` lista os pedidos** (o código só aproveita a lista se vier `orders[]`).
3. Estorno integral e parcial pelo painel, inclusive de **Pix**.
4. **Nome do cabeçalho de idempotência**: repetir o mesmo estorno com a mesma chave e ver se volta a mesma resposta (ou o erro 40005).
5. Se aparece status `AUTHORIZED` em algum fluxo.
6. Formato real dos erros (`error` x `description`).

Até lá, a homologação externa fica **pendente** e o pagamento online deve continuar desligado em produção.

### 1.10 Riscos conhecidos

| Risco | Mitigação / situação |
|---|---|
| A consulta de checkout pode não listar os pedidos (doc ambígua) | Se o PagBank não listar, um pedido abandonado sem nenhum webhook é cancelado com base no status `EXPIRED`/`INACTIVE` do próprio checkout. Pagamento que chegue depois cai na DC-4 (nunca reativa sozinho). Validar no sandbox. |
| Nome do cabeçalho de idempotência não publicado | A proteção principal é interna (trava do pedido + uma tentativa aberta por pedido + consulta antes de reenviar). Validar no sandbox. |
| Cancelar no painel um pedido **já enviado** devolve a peça ao estoque | Comportamento anterior, mantido. Para pedido pago, o estorno agora também é solicitado. A tabela de transições da Fase 2 (B-05) deve bloquear cancelar após o envio. |
| Cancelar pedido online **ainda pendente** não desativa o link no PagBank | A cliente ainda pode pagar; se pagar, cai na DC-4. Desativar o link (`POST /checkouts/{id}/inactivate`, citado na doc mas não lido em detalhe) pode entrar depois, com autorização. |
| Ações financeiras disponíveis para `staff` | Mesmo acesso que staff já tem hoje para cancelar pedidos. Permissões granulares são a Fase 3 (RC-4). |
| `checkout-guard.spec.js` sem a trava de banco local | Mantido para a Fase 4. Todas as execuções desta fase usaram o ambiente local. |
| Testes só em PG 18 local | O CI usa PG 16. Nada usa recurso exclusivo do 18; rodar no CI antes de publicar. |
| A migração chega ao Neon no próximo deploy | Só acrescenta; validada em banco populado; reversão testada. Nenhum deploy foi feito. |

### 1.11 Itens que dependem de decisão

| # | Decisão | Proposta |
|---|---|---|
| DC-11 | Pedido abandonado sem nenhum webhook: o status `EXPIRED`/`INACTIVE` do checkout no PagBank basta para cancelar? | Sim (implementado), com a DC-4 cobrindo pagamento tardio. Alternativa mais conservadora: só alertar a equipe, mas o estoque ficaria preso até alguém agir. |
| DC-12 | Bloquear o cancelamento de pedido já enviado ou concluído | Decidir junto com a B-05 na Fase 2 |
| DC-13 | Ao cancelar pedido online pendente, desativar o link de pagamento no PagBank | Recomendado; validar o endpoint no sandbox |
| — | DC-1 a DC-3 e DC-6 a DC-10 | Continuam abertas (Fases 2 e 3) |

### 1.12 Status por regra

| Item | Implementado | Testado | Aprovado | Evidência | Pendência |
|---|---|---|---|---|---|
| Base: `order_events` | Sim | Sim | Aguardando você | testes 01–23 + histórico encadeado em todos os pedidos | — |
| Base: estados e colunas financeiras | Sim | Sim | Aguardando você | 1.5; testes 09, 10, 14, 16 | — |
| Base: `getPaymentStatus` / `refund` | Sim | Sim (simulado) | Aguardando você | testes 04, 15, 23 | sandbox (1.9) |
| B-01 recusado | Sim | Sim | Aguardando você | testes 02, 03, 18; regras #13 | — |
| B-02 estorno x estoque | Sim | Sim | Aguardando você | testes 07, 10–13; regras #14 | devolução física (Fase 3) |
| B-03 / DC-5 cancelar pago | Sim | Sim | Aguardando você | testes 09, 14, 16, 17, 18, 23; regras #10 | cabeçalho de idempotência (sandbox) |
| B-04 expiração | Sim | Sim | Aguardando você | testes 04, 15 | DC-11; formato do checkout (sandbox) |
| DC-4 pago após cancelamento | Sim | Sim | Aguardando você | testes 19–22; `financeiro-painel.spec` | — |
| B-06 (parte financeira) | Sim | Sim | Aguardando você | histórico em todos os testes | linha do tempo completa (Fase 2) |
| Painel financeiro | Sim | Sim | Aguardando você | `financeiro-painel.spec` | — |
| Migração + reversão | Sim | Sim (local) | Aguardando você | 1.5 | aplicar no Neon só com deploy autorizado |
| Homologação sandbox | Não | Não | — | — | token de sandbox + túnel |

### 1.13 Matriz da fase

| Item | Situação |
|---|---|
| Implementado | Sim (B-01 a B-04, DC-4, DC-5, histórico financeiro, painel) |
| Testado | Sim: 28/28 pagamentos, 16/16 navegador, sem falhas novas nas suítes existentes |
| Aprovado | Aguardando sua revisão |
| Evidência | Seções 1.1 a 1.8 |
| Pendência | Homologação em sandbox: pagamento e consulta OK, estorno ainda não homologado no sandbox; correção do 409 aplicada e testada (1.14); DC-11 a DC-13; commit, push e deploy só com sua autorização |

### 1.14 Homologação no sandbox do PagBank (12/11/2026, parcial)

Ambiente: loja local (porta 18800) com o banco descartável 127.0.0.1:54329, `PAGSEGURO_SANDBOX=true` e token de sandbox lido de um arquivo fora do repositório, nunca impresso. O token foi validado antes de qualquer uso: consulta de leitura no host de sandbox respondeu 404 (credencial aceita); a mesma consulta com token falso respondeu 401. O host de produção não foi chamado. Sem endereço público, a chegada de webhooks não foi testada; tudo foi feito por consulta direta.

| Item | Resultado real no sandbox |
|---|---|
| Criação do checkout | OK. `CHEC_5AFD00EB-…` com link `pagamento.sandbox.pagbank.com.br`, R$ 50,00 |
| Pagamento (cartão de teste Visa, feito pelo usuário) | OK. Pedido `ORDE_5C86ECFF-…`, cobrança `CHAR_ACE38568-…` PAID, total 5000 / pago 5000 |
| "Atualizar pagamento" (`GET /checkouts/{id}` + `GET /orders/{id}`) | OK. Pedido passou a `paid`, com cobrança, valor e eventos `payment_checked` e `payment_approved`. Confirma que a consulta do checkout leva até o pedido e a cobrança (item antes não confirmado da 1.2) |
| Nome do cabeçalho de idempotência | Confirmado: `x-idempotency-key` é reconhecido. A mesma chave enviada de novo recebe 409 `40005 idempotency_key_in_use` |
| Estorno (`POST /charges/{id}/cancel`) | NÃO homologado. O sandbox responde 400 `40008 "Transaction is not found"` para R$ 10 e para o total, com ou sem o cabeçalho, em tentativas espaçadas. O caminho está correto (é o mesmo do link `CHARGE.CANCEL` que o próprio PagBank devolve no pedido). Aparenta limitação do sandbox para cobranças criadas pelo checkout hospedado; pendente de confirmação com o suporte do PagBank ou de teste em produção controlada |
| Reação da loja ao estorno recusado | Conforme a DC-5: pedido `cancelado`, estoque devolvido uma única vez (5 → 4 → 5), pagamento `refund_failed` com alerta `refund_uncertain`, valor estornado 0, histórico completo. Nada foi marcado como estornado sem confirmação do PagBank |

**Problema encontrado e corrigido (autorizado em 12/11/2026).** Depois de um resultado inconclusivo, "Tentar estorno novamente" reenviava com a mesma chave; o PagBank responde 409 `idempotency_key_in_use`, e o código tratava esse 409 como recusa definitiva. Na tentativa seguinte, gerava uma chave nova sem consultar o PagBank, o que abriria espaço para um segundo estorno se o primeiro tivesse sido processado com atraso.

Correção em `serve.js`:

1. O 409 `40005` passou a ser resultado incerto (`executeRefundAttempt`): a tentativa continua `unknown` com a mesma chave.
2. `retryOrderRefund` consulta o PagBank antes de qualquer reenvio. Se a consulta falhar, responde 409 e não envia nada.
3. Se a consulta mostrar o estorno já feito, apenas confirma.
4. Uma tentativa sem resposta só é encerrada (evento `refund_superseded`) e substituída por uma chave nova depois de `REFUND_UNKNOWN_SETTLE_MINUTES` (10 min) e com a consulta mostrando que o PagBank não estornou. O valor da nova tentativa sai do saldo que a consulta acabou de gravar.

No painel (`admin.js`), foi incluído o rótulo do novo evento. O simulado (`test/pagamentos.test.js`) passou a reproduzir o comportamento real do sandbox: depois de uma recusa 4xx, a chave fica "em uso" e o reenvio recebe 409; há também o modo `not-found` (40008).

Novos testes:

| Teste | O que verifica |
|---|---|
| 24 | Sequência 40008 → 409 continua incerta, com a mesma chave. Com a consulta fora do ar, nada é enviado. Passado o prazo, a nova chave estorna uma única vez e o estoque volta uma vez |
| 25 | Depois de resposta incerta, a consulta acha o estorno feito e confirma sem nova chamada |

Resultados após a correção, no banco local:

| Suíte | Resultado |
|---|---|
| `pagamentos` | 28/28, executado 2 vezes |
| `unit` | 6/6 |
| `routes` | 32/32 |
| `audit` | 28/29 (#14 é a falha preexistente do PG18) |
| `regras-negocio` | 15/20 (#5–#9 são da Fase 2) |
| Playwright chromium | 16/16 |
| ESLint | limpo |

**Reteste da correção no sandbox real (12/11/2026).** Executado sobre o mesmo pedido de homologação, que estava cancelado, com estorno não confirmado e a última tentativa sem resposta havia horas.

| Passo | Resultado real |
|---|---|
| 1ª nova tentativa | Consultou o PagBank (sem estorno) e encerrou a tentativa antiga (evento `refund_superseded`). Enviou uma chave nova; o sandbox voltou a responder 40008, e a tentativa ficou `unknown` |
| 2ª nova tentativa, logo em seguida | Consultou o PagBank e reenviou a MESMA chave; o sandbox respondeu 409 `idempotency_key_in_use`. A tentativa continuou `unknown` (2 envios), e nenhuma chave nova foi criada, como determina a correção |
| Situação final | `refund_failed`, alerta `refund_uncertain`, valor estornado 0, nada marcado como estornado sem confirmação |

A homologação do estorno com dinheiro efetivamente devolvido continua dependendo de o PagBank aceitar o estorno (suporte ou teste controlado em produção).

**Ponto de parada.** A Fase 2 não foi iniciada. Aguardando sua autorização expressa para qualquer próxima etapa.
