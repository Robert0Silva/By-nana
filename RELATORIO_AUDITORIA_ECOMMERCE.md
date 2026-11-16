# Relatório de Auditoria de Regras de Negócio — By NaNa

Data: 10/11/2026 · Branch analisada: `melhorias-ux-admin` (commit `1eea3d2`) · Tipo: auditoria e validação, sem correções

Nenhum código de produção foi alterado. A única adição ao projeto é o arquivo de testes `test/regras-negocio.test.js`, que ainda não entra no `npm test` (isso fica para a fase de correções). Nada foi commitado, enviado ou implantado. O banco configurado no `.env` (Neon, o da loja) **não foi acessado**: todos os testes rodaram num PostgreSQL 18.4 local e descartável (porta 54329), com envio de e-mail desligado.

---

## 1. Resumo executivo

O núcleo transacional da loja está sólido. Estoque por variação, concorrência no último item, recálculo de preço no servidor, idempotência do pedido, limite de uso de cupom e isolamento entre contas de clientes passaram em testes reais, inclusive em cenários de concorrência.

Os problemas graves estão em **dois pontos que ainda não estão em uso ou estão em uso parcial**:

1. **Integração PagBank (pagamento online).** O tratamento do webhook tem duas falhas críticas: uma recusa de cartão cancela o pedido e devolve a peça à vitrine enquanto a cliente ainda pode pagar no mesmo link, e um estorno devolve ao estoque peças de pedidos já entregues. Também faltam o estorno ao cancelar pelo painel e a consulta ao PagBank antes de expirar um pedido. **Enquanto `PAYMENT_PROVIDER` estiver vazio em produção, esses bugs não têm efeito.** Eles precisam ser corrigidos antes de ativar o pagamento online.
2. **Pós-venda.** Trocas, devoluções, reembolsos e o histórico do pedido acontecem fora do sistema (WhatsApp/e-mail). Por isso não há controle do prazo de 7 dias nem registro de motivo. As transições de status do pedido também não são restritas.

Há ainda **riscos comerciais que não são bugs, mas decisões pendentes**. Os descontos automáticos (Pix 5%, 2 peças −20%, 3+ peças −30%) estão fixos no código e se somam a promoções e cupons. Num caso testado, a peça saiu 65% abaixo do preço de tabela.

### Indicadores

| Indicador | Valor |
|---|---|
| Regras avaliadas | **110** |
| Aprovadas | **74** |
| Reprovadas | **16** |
| Não implementadas | **18** |
| Não testáveis | **2** |
| **Aprovação sobre regras implementadas** (aprovadas ÷ aprovadas+reprovadas) | **82,2%** |
| Aprovação sobre o total avaliado | 67,3% |
| Bugs críticos | **2** |
| Bugs altos | **2** |
| Bugs médios | **5** |
| Bugs baixos | **6** |

Testes executados: **87** (67 já existentes + 20 novos). Resultado: **77 passaram, 10 falharam** (detalhes na seção 5).

---

## 2. Funcionalidades analisadas

**Stack:** Node.js 20 sem framework (`serve.js`, ~4.100 linhas, HTTP nativo), PostgreSQL (`db/schema.sql`), front em JavaScript puro (`assets/js/main.js` loja, `assets/js/admin.js` painel, `assets/js/promo.js` regras de preço compartilhadas entre front e servidor). Pagamento online plugável (`payment-provider.js` + `payment-providers/pagseguro.js`, Checkout PagBank hospedado). E-mail via Resend (`email.js`). Testes com `node:test` (unidade/integração) e Playwright (e2e). CI no GitHub Actions com PostgreSQL 16.

| Área | O que existe |
|---|---|
| Catálogo | Produtos com capa + até 7 fotos, categoria (com grupo de menu), coleção, preço ou "sob consulta", visível/oculto, destaque e "leve também" |
| Variações | Tamanho + cor + SKU + estoque por combinação, medidas por tamanho, grade padrão (P–GG / 33–42), razão de movimentações (`inventory_movements`) |
| Preço | Promoções por produto/categoria/coleção/site com vigência; cupons (%, fixo, vigência, 1ª compra, limite de usos); descontos automáticos Pix e por quantidade |
| Checkout | Sacola em `localStorage`, pedido gravado no servidor com reserva de estoque, chave de idempotência, fechamento por WhatsApp ou PagBank |
| Frete | Regra por UF com fallback `*`, frete grátis acima de valor, prazo em dias úteis, retirada na loja |
| Pedidos | Status `novo → em_andamento → enviado → concluido` / `cancelado`, `payment_status` separado, rastreio, e-mails de status |
| Clientes | Cadastro, login, recuperação de senha, endereços, favoritos, histórico, avaliações (só quem comprou) |
| Painel | Multiusuário (owner/staff), log de atividade, relatórios, carrinhos abandonados, avise-me |
| Pós-venda | Somente páginas informativas (Trocas e Devoluções, Ajuda); o processo roda por WhatsApp/e-mail |

---

## 3. Matriz de regras de negócio

Legenda: ✅ aprovada · ❌ reprovada · ⛔ não implementada · ❔ não testável. "Evidência" aponta o teste (arquivo e número na execução) ou o trecho analisado.

### 3.1 Cadastro de produtos

| # | Regra | Status | Evidência |
|---|---|---|---|
| P01 | Nome, categoria, descrição e foto obrigatórios | ✅ | `serve.js:1776-1784` |
| P02 | Preço > 0; vazio = "sob consulta"; negativo/zero recusado | ✅ | audit #12 |
| P03 | Imagem principal + até 7 secundárias | ✅ | `serve.js:1908-1945` |
| P04 | Produto oculto some da vitrine e do checkout | ✅ | routes #56 |
| P05 | Produto com venda não pode ser excluído (orienta ocultar) | ❌ | audit #14 · **B-11** |
| P06 | Promoção respeita vigência e escopo | ✅ | unit #62 |
| P07 | Promoção nunca gera preço negativo; % < 100 | ✅ | unit #63, `serve.js:1308` |
| P08 | Alerta/bloqueio de produto duplicado | ⛔ | sem verificação por nome/SKU de produto |
| P09 | Imagem própria por cor da variação | ⛔ | galeria é por produto |
| P10 | Detecção de imagem quebrada | ❔ | depende dos arquivos em disco/produção |
| P11 | Subcategorias | ⛔ | só `group_name` para o mega-menu |

### 3.2 Variações (roupas e calçados)

| # | Regra | Status | Evidência |
|---|---|---|---|
| V01 | Estoque individual por tamanho + cor | ✅ | regras #1 (cenário A/C) |
| V02 | Combinação tamanho/cor única por produto | ✅ | índice `variants_product_size_color_idx`, `serve.js:293-295` |
| V03 | Variação esgotada não pode ser comprada | ✅ | regras #2 (cenário B) |
| V04 | Quantidade acima do estoque da variação é recusada | ✅ | regras #3 |
| V05 | Compra de uma variação nunca consome outra | ✅ | regras #1, #3 |
| V06 | Trocar tamanho/cor de item já na sacola | ⛔ | é preciso remover e adicionar de novo |
| V07 | Grade padrão para roupas (P–GG) e calçados (33–42) | ✅ | `serve.js:255-272` |

### 3.3 Estoque

| # | Regra | Status | Evidência |
|---|---|---|---|
| E01 | Baixa na compra | ✅ | routes #50, regras #1 |
| E02 | Cancelamento devolve uma vez só | ✅ | audit #9 |
| E03 | Estoque nunca negativo | ✅ | `CHECK (stock >= 0)` + trava, audit #1 |
| E04 | Duas clientes pelo último item: só uma leva (cenário D) | ✅ | audit #1 (8 pedidos simultâneos) |
| E05 | Pedidos simultâneos sem deadlock | ✅ | audit #2 |
| E06 | Reativar cancelado exige estoque | ✅ | audit #10 |
| E07 | Ajuste no painel com estoque desatualizado é recusado | ✅ | audit #16 |
| E08 | Histórico de movimentações por variação | ✅ | `inventory_movements` |
| E09 | Estoque só volta quando a peça volta apta | ❌ | regras #14 · **B-02** |
| E10 | "Avise-me" disparado em toda reposição | ❌ | **B-14** |

### 3.4 Carrinho

| # | Regra | Status | Evidência |
|---|---|---|---|
| C01 | Adicionar, remover, alterar quantidade | ✅ | `main.js:1965-2060`, e2e existente |
| C02 | Quantidade na sacola limitada ao estoque | ✅ | `main.js:1987`, `main.js:2050` |
| C03 | Quantidade zero/negativa recusada no servidor | ✅ | regras #4 |
| C04 | Quantidade fracionada recusada | ❌ | regras #5 · **B-12** |
| C05 | Mesma variação em várias linhas consolidada | ✅ | audit #3 |
| C06 | Preço da sacola acompanha o catálogo atual | ✅ | sacola recalcula com `/api/data`; servidor recalcula no pedido |
| C07 | Peça esgotada ou oculta sinalizada na sacola antes do checkout | ❌ | **B-07** |
| C08 | Sacola persiste durante a navegação | ✅ | `localStorage` |

### 3.5 Preços, descontos e promoções

| # | Regra | Status | Evidência |
|---|---|---|---|
| D01 | Servidor recalcula preço, desconto, frete e total (cenário G) | ✅ | audit #6 |
| D02 | Cupom expirado, agendado ou inativo recusado (cenário E) | ✅ | audit #8, unit #65 |
| D03 | Cupom inexistente ignorado sem travar o pedido | ✅ | routes #55 |
| D04 | Limite de usos respeitado sob concorrência | ✅ | audit #22 |
| D05 | Cupom × Pix × quantidade não se somam (vale o maior) | ✅ | unit #66 |
| D06 | Total nunca negativo | ✅ | audit #8 |
| D07 | Cupom de 1ª compra coerente entre sacola e pedido | ❌ | **B-08** |
| D08 | Valor mínimo de compra para cupom | ⛔ | sem campo em `coupons` |
| D09 | Limite de uso por cliente | ⛔ | só limite global e "1ª compra" |
| D10 | Política de acúmulo promoção + cupom/Pix/quantidade definida pela loja | ⛔ | acumulam sempre (regras #17, #18) · ver **RC-1/RC-2** |
| D11 | Descontos automáticos configuráveis no painel | ⛔ | fixos em `promo.js:86-91` |

### 3.6 Checkout

| # | Regra | Status | Evidência |
|---|---|---|---|
| K01 | Campos obrigatórios (nome, telefone, pagamento, entrega, itens) | ✅ | routes #48 |
| K02 | Telefone com DDD | ✅ | routes #60 |
| K03 | E-mail validado quando informado | ✅ | `serve.js:2579` |
| K04 | CPF no checkout | ⛔ | não coletado (o PagBank coleta na página dele) |
| K05 | Endereço completo, CEP com 8 dígitos e UF válida | ❌ | regras #7 · **B-13** |
| K06 | Sacola vazia recusada | ✅ | `serve.js:2583` |
| K07 | Cliques repetidos não duplicam pedido (cenário H) | ✅ | audit #21, #24 |
| K08 | Limite de pedidos em sequência por IP | ✅ | routes #59 |
| K09 | Forma de pagamento validada contra as opções oferecidas | ❌ | regras #6 · **B-10** |
| K10 | Pedido guarda preço, preço de tabela e variação do momento | ✅ | `items` JSONB, `serve.js:2720-2731` |
| K11 | Falha em qualquer item não cria pedido parcial | ✅ | audit #4 |

### 3.7 Frete e entrega

| # | Regra | Status | Evidência |
|---|---|---|---|
| F01 | Frete por UF com regra padrão `*` | ✅ | `serve.js:2748-2756` |
| F02 | Frete grátis acima do valor configurado (R$ 499) | ✅ | audit #7 |
| F03 | Retirada na loja sem frete | ✅ | regras #1 |
| F04 | Prazo estimado exibido | ✅ | `days_min`/`days_max` |
| F05 | Estado sem regra é bloqueado | ✅ | `serve.js:2646-2652` (hoje a regra `*` atende todos) |
| F06 | Frete por peso/CEP/transportadora | ⛔ | só valor fixo por UF |
| F07 | Existência do CEP validada no servidor | ⛔ | só formato; ViaCEP apenas no navegador |

### 3.8 Pedidos e status

| # | Regra | Status | Evidência |
|---|---|---|---|
| S01 | Só status da lista são aceitos | ✅ | audit #11 |
| S02 | Envio/conclusão exige pagamento confirmado | ✅ | audit #23 |
| S03 | Transições válidas (ex.: cancelado ↛ concluído) | ❌ | regras #8, #9 · **B-05** |
| S04 | Cancelar pedido pago aciona ou registra o estorno | ❌ | regras #10 · **B-03** |
| S05 | Histórico do pedido com data e responsável | ❌ | **B-06** |
| S06 | Cliente avisada por e-mail a cada mudança | ✅ | `serve.js:3024-3030` (quando há e-mail) |
| S07 | Status "devolvido" | ⛔ | não existe |
| S08 | Código de rastreio no envio | ✅ | `serve.js:3013` |
| S09 | Pedido online expirado só cancela depois de confirmar com o gateway | ❌ | **B-04** |

### 3.9 Pagamento online (PagBank)

| # | Regra | Status | Evidência |
|---|---|---|---|
| G01 | Assinatura do webhook validada | ✅ | regras #12, unit #67 |
| G02 | Webhook repetido é idempotente | ✅ | regras #11 |
| G03 | Notificação atrasada não "despaga" pedido pago | ✅ | `serve.js:436-442` |
| G04 | Uma tentativa recusada não cancela o pedido enquanto o link vale | ❌ | regras #13 · **B-01** |
| G05 | Estorno parcial tratado diferente de total | ❌ | `pagseguro.js:156` · **B-02** |
| G06 | Falha ao criar o checkout cai para o fluxo manual | ✅ | `serve.js:2829-2835` |

### 3.10 Conta do cliente

| # | Regra | Status | Evidência |
|---|---|---|---|
| U01 | Cadastro valida e-mail, senha ≥ 8, CPF (se informado) e aceite de privacidade | ✅ | routes #52, #53, #57 |
| U02 | Sem conta duplicada, inclusive em cliques simultâneos | ✅ | audit #19 |
| U03 | Login com limite de tentativas | ✅ | `serve.js:959-999` |
| U04 | Recuperação de senha segura (hash, expiração, resposta genérica) | ✅ | audit #26, routes #45, #46 |
| U05 | Troca de senha derruba sessões antigas | ✅ | routes #54 |
| U06 | Atualização de dados e endereços | ✅ | `serve.js:3133-3370` |
| U07 | Histórico de pedidos | ✅ | regras #15 |
| U08 | Cliente não vê pedido de outra; token forjado recusado | ✅ | regras #15 |
| U09 | Confirmação de e-mail | ⛔ | — |
| U10 | Pedidos feitos como visitante vinculados à conta depois | ⛔ | — |
| U11 | CPF mascarado no painel | ✅ | `serve.js:825-830` |

### 3.11 Trocas, devoluções e arrependimento

| # | Regra | Status | Evidência |
|---|---|---|---|
| T01 | Prazo de 7 dias de arrependimento informado (CDC art. 49) | ✅ | `trocas-e-devolucoes.html` |
| T02 | Solicitação de troca/devolução/cancelamento pelo sistema | ⛔ | só WhatsApp/e-mail |
| T03 | Registro de motivo e controle do prazo | ⛔ | — |
| T04 | Reembolso registrado no sistema | ⛔ | — |
| T05 | Texto da política sem restringir direito legal | ❔ | requer análise jurídica · ver **RC-5** |

### 3.12 Painel administrativo

| # | Regra | Status | Evidência |
|---|---|---|---|
| A01 | Toda rota do painel exige sessão de admin válida no servidor | ✅ | routes #43, audit #18 |
| A02 | Admin desativado perde acesso na hora | ✅ | `serve.js:1108-1118` |
| A03 | Só o owner gerencia usuários | ✅ | audit #17 |
| A04 | Permissões por função para operações sensíveis | ⛔ | staff faz todo o resto (regras #20) · ver **RC-4** |
| A05 | Log das ações administrativas | ✅ | `admin_activity_log` |
| A06 | Alterações do painel refletem na loja | ✅ | audit #13 |
| A07 | Painel enxerga todos os pedidos | ❌ | **B-09** |

### 3.13 Segurança e integridade

| # | Regra | Status | Evidência |
|---|---|---|---|
| X01 | SQL sempre parametrizado | ✅ | nenhuma interpolação de entrada em SQL |
| X02 | HTML escapado na exibição (XSS) | ✅ | regras #16, `escapeHtml` em admin/e-mails, CSP |
| X03 | Cabeçalhos de segurança e CSP | ✅ | routes #41, #42 |
| X04 | Arquivos internos e path traversal protegidos | ✅ | routes #36, #37 |
| X05 | Cupons privados fora do dado público | ✅ | routes #58 |
| X06 | Promoções inativas/agendadas fora do dado público | ❌ | **B-15** |
| X07 | Segredos de sessão separados para cliente e admin | ✅ | `serve.js:62-69` |

---

## 4. Casos de teste executados

**Ambiente:** PostgreSQL 18.4 local (embedded-postgres, instalado só numa pasta temporária, fora do projeto), `node db/migrate.js` + `npm run configure:business` + estoque 10 em todas as variações (igual ao CI). Variáveis de ambiente sobrescritas para teste (segredos de sessão próprios, `RESEND_API_KEY` vazio, `PAYMENT_PROVIDER` vazio na suíte existente). Lint (`npm run lint`) passou sem avisos. Os testes e2e do Playwright **não foram executados** nesta rodada.

| Suíte | Arquivo | Testes | Passou | Falhou |
|---|---|---|---|---|
| Existente — auditoria anterior | `test/audit.test.js` | 29 | 27 | 2 (#14 sempre; #28 intermitente) |
| Existente — rotas | `test/routes.test.js` | 32 | 32 | 0 |
| Existente — unidade | `test/unit.test.js` | 6 | 6 | 0 |
| **Nova — regras de negócio** | `test/regras-negocio.test.js` | 20 | 12 | 8 |
| **Total** | | **87** | **77** | **10** |

Cenários obrigatórios do roteiro:

| Cenário | Teste | Resultado |
|---|---|---|
| A — Camisa M preta, 2 unidades | regras #1 | ✅ total R$ 160 (2 × R$ 100 com −20% automático de 2 peças), só M preta baixou |
| B — Sapato 37 com estoque zero | regras #2 | ✅ recusado com 409, nada baixou |
| C — Bolsa em duas cores | regras #1, #3 | ✅ cada cor com estoque próprio |
| D — Última unidade disputada | audit #1 | ✅ 8 pedidos simultâneos → 1 aprovado, 7 recusados, estoque 0 |
| E — Cupom válido / expirado | audit #8, routes #55 | ✅ |
| F — Cancelamento | audit #9 | ✅ estoque volta uma vez; reativar reserva de novo |
| G — Manipulação de preço/quantidade | audit #6, regras #4 | ✅ preço/total do navegador ignorados; qty inválida recusada |
| H — Pedido duplicado | audit #21, #24 | ✅ mesma chave devolve o mesmo pedido |

## 5. Resultado de cada teste novo

| # | Teste (`test/regras-negocio.test.js`) | Resultado | Observado |
|---|---|---|---|
| 1 | [CEN-A/C] M preta baixa só M preta | ✅ | — |
| 2 | [CEN-B] 37 esgotado não é comprado | ✅ | — |
| 3 | Quantidade acima do estoque da variação | ✅ | — |
| 4 | Qty 0, −1, texto, nulo recusadas | ✅ | — |
| 5 | Qty fracionada recusada | ❌ | 1,5 aceita como 1 (201) |
| 6 | Forma de pagamento inventada recusada | ❌ | "Boleto em 12x sem juros" aceito (201) |
| 7 | UF inexistente recusada | ❌ | "ZZ" aceita (201) |
| 8 | Cancelado ↛ concluído | ❌ | aceito (200) |
| 9 | Concluído ↛ novo | ❌ | aceito (200) |
| 10 | Cancelar pedido pago não deixa "cancelado + pago" | ❌ | ficou `cancelado` / `paid`, sem estorno |
| 11 | Webhook PAID repetido é idempotente | ✅ | — |
| 12 | Webhook com assinatura errada recusado | ✅ | — |
| 13 | Recusa de cartão não cancela enquanto o link vale | ❌ | 1ª recusa cancelou e devolveu a peça; o pagamento seguinte caiu em pedido `cancelado` / `paid` |
| 14 | Estorno de pedido entregue não repõe estoque | ❌ | estoque 2 → 3 e pedido entregue virou `cancelado` |
| 15 | Cliente só vê os próprios pedidos | ✅ | — |
| 16 | Nome com HTML guardado como texto | ✅ | — |
| 17 | *Comportamento atual:* promoção + cupom acumulam | ✅ | R$ 100 → 60 → 42 |
| 18 | *Comportamento atual:* promoção + desconto por quantidade | ✅ | 3 × R$ 100 com 50% off → R$ 105 (−65%) |
| 19 | *Comportamento atual:* "sob consulta" fecha pedido de R$ 0 | ✅ | reserva a peça |
| 20 | *Comportamento atual:* staff exclui cliente | ✅ | permitido |

Os testes 17 a 20 documentam regras que a loja ainda precisa decidir. Eles passam hoje e servem para avisar se o comportamento mudar sem querer.

Falhas da suíte existente:

**audit #14:** excluir produto com venda devolve **500** em vez de 409 (ver B-11).

**audit #28:** falhou em 1 de 3 execuções. Quando dois owners se rebaixam ao mesmo tempo, a segunda requisição às vezes recebe 403 (porque a primeira já a rebaixou) em vez do 409 esperado pelo teste. A regra de negócio, de que a loja nunca fica sem owner, foi cumprida nas duas execuções. O problema está na asserção do teste, que é estrita demais, e não no sistema.

---

## 6. Bugs encontrados

### B-01 · CRÍTICA · Recusa de cartão cancela o pedido online e libera a peça enquanto a cliente ainda pode pagar

| | |
|---|---|
| Funcionalidade | Webhook PagBank / pagamento online |
| Regra esperada | No checkout hospedado, a cliente pode tentar outro cartão ou Pix no mesmo link até ele expirar. Uma tentativa recusada não encerra o pedido. |
| Comportamento | A 1ª notificação com cobrança `DECLINED` vira `failed`. O pedido é cancelado, o estoque volta à vitrine e a cliente recebe o e-mail "pagamento não concluído". Se ela paga em seguida, o pedido fica `cancelado` + `paid`, e a peça pode já ter sido vendida a outra pessoa. |
| Evidência | regras #13: estoque voltou para 1 após a recusa; estado final `cancelado/paid` |
| Local | `payment-providers/pagseguro.js:133,154` (DECLINED → failed); `serve.js:2899-2905` (failed → cancela e repõe) |
| Recomendação | Tratar `DECLINED` como "tentativa recusada" e manter o pedido `pending`. Só cancelar quando o checkout expirar (evento `EXPIRED`) ou pela varredura de prazo (com a consulta do B-04). |

### B-02 · CRÍTICA · Estorno cancela qualquer pedido e devolve todo o estoque, mesmo após a entrega (e mesmo se parcial)

| | |
|---|---|
| Funcionalidade | Webhook PagBank / estoque |
| Regra esperada | Estorno muda o status financeiro. A peça só volta ao estoque quando retorna fisicamente e em condições de venda. Estorno parcial não cancela o pedido inteiro. |
| Comportamento | Qualquer valor em `summary.refunded > 0` vira `refunded`. O pedido em qualquer status (inclusive `concluido`) vai para `cancelado` e **todas** as peças voltam ao estoque. |
| Evidência | regras #14: pedido concluído, estorno → estoque 2 → 3, status `cancelado` |
| Local | `payment-providers/pagseguro.js:155-156`; `serve.js:2899-2905` |
| Recomendação | Repor estoque automaticamente só se o pedido ainda não saiu (`novo`/`em_andamento`). Depois do envio, registrar o estorno e deixar a reposição para a conferência da devolução (ver T02-T04). Distinguir estorno parcial (`refunded < paid`). |

### B-03 · ALTA · Cancelar no painel um pedido já pago não estorna nem sinaliza

| | |
|---|---|
| Funcionalidade | Status do pedido × pagamento |
| Regra esperada | Pedido pago e cancelado precisa de estorno solicitado ou, ao menos, de um estado "estorno pendente" visível. |
| Comportamento | Fica `status = cancelado` e `payment_status = paid`. Nada pede ou registra o estorno, e o dinheiro fica retido sem alerta. |
| Evidência | regras #10 |
| Local | `serve.js:2992-2993`, `serve.js:3012-3015` |
| Recomendação | Ao cancelar um pedido `paid`, chamar o estorno da API do PagBank (`POST /charges/{id}/cancel`) ou bloquear o cancelamento até a loja confirmar o estorno, com aviso no painel. |

### B-04 · ALTA · Pedido pendente expira sem consultar o PagBank

| | |
|---|---|
| Funcionalidade | Varredura de pedidos online pendentes |
| Regra esperada | Antes de cancelar por prazo, confirmar com o gateway se o pagamento realmente não aconteceu. |
| Comportamento | Após 26h em `pending`, o pedido é cancelado e o estoque reposto só com base no banco local. Se o webhook de pagamento se perdeu, uma compra paga é cancelada e a cliente recebe "pagamento não concluído". |
| Evidência | análise de código (a varredura roda por timer; não automatizada nesta rodada) |
| Local | `serve.js:4069-4111` |
| Recomendação | Consultar `GET /checkouts/{id}` / `GET /orders/{id}` antes de cancelar e aplicar o status real. O mesmo endpoint serve para um botão "atualizar pagamento" no painel. |

### B-05 · MÉDIA · Transições de status sem restrição

| | |
|---|---|
| Regra esperada | Fluxo `novo → em_andamento → enviado → concluido`, cancelamento antes do envio e reabertura só por procedimento explícito |
| Comportamento | Qualquer status vai para qualquer outro: cancelado → concluído, concluído → novo, enviado → novo etc. A única trava é a de pagamento não confirmado. |
| Evidência | regras #8, #9 |
| Local | `serve.js:2965-2967` |
| Recomendação | Tabela de transições permitidas no servidor; reabertura de concluído/cancelado só para owner, com motivo obrigatório. |

### B-06 · MÉDIA · Pedido sem histórico próprio

| | |
|---|---|
| Regra esperada | Linha do tempo por pedido com data, status anterior/novo, quem alterou (pessoa, webhook ou sistema) e motivo |
| Comportamento | O log de atividade só guarda `{ status }` das mudanças feitas no painel. Mudanças por webhook e pela varredura não são registradas, e não há tela de histórico no pedido. |
| Local | `serve.js:3023`; webhook `serve.js:2908-2913`; varredura `serve.js:4091` |
| Recomendação | Tabela `order_events` gravada na mesma transação de cada mudança, exibida no detalhe do pedido. |

### B-07 · MÉDIA · Sacola não avisa peça esgotada ou oculta antes do checkout

| | |
|---|---|
| Regra esperada | Ao abrir a sacola, itens indisponíveis ou com quantidade acima do estoque atual aparecem sinalizados |
| Comportamento | Item de produto oculto some da lista, mas continua contando no badge e é enviado no pedido. Item esgotado aparece normal. A cliente só descobre no "Finalizar", com erro. |
| Local | `assets/js/main.js:1823` (contagem inclui itens invisíveis), `assets/js/main.js:1852` (`if (!p) return;`) |
| Recomendação | Reconciliar a sacola com o catálogo a cada carregamento: marcar "esgotado"/"indisponível", limitar a quantidade ao estoque e oferecer remover. |

### B-08 · MÉDIA · Cupom de 1ª compra aceito na sacola e descartado no pedido sem aviso

| | |
|---|---|
| Comportamento | `/api/coupons/validate` não sabe quem é a cliente e aprova o cupom de boas-vindas. No pedido, quem já comprou perde o desconto silenciosamente e o total muda entre a sacola e a confirmação. |
| Local | `serve.js:1505-1517` vs `serve.js:2659-2667` |
| Recomendação | Validar a regra de 1ª compra também na validação (com token ou telefone) e, no pedido, devolver um aviso explícito quando um cupom for descartado. |

### B-09 · MÉDIA · Painel mostra só os 300 pedidos mais recentes

| | |
|---|---|
| Local | `serve.js:853-865` (`LIMIT 300`, sem paginação nem busca) |
| Impacto | Pedidos mais antigos ficam invisíveis no painel, o que atrapalha trocas, garantia de 90 dias e conferência. |
| Recomendação | Paginação e busca por código, telefone e e-mail. |

### B-10 · BAIXA · Forma de pagamento livre

`serve.js:2580` aceita qualquer texto (regras #6: "Boleto em 12x sem juros"). O desconto Pix só se aplica ao valor exato `Pix`, então não há ganho financeiro, mas o pedido pode ficar com uma forma de pagamento que a loja não oferece. **Correção:** lista branca com as opções do `index.html:443-446`.

### B-11 · BAIXA · Excluir produto com venda dá erro 500 no PostgreSQL 18+

`serve.js:2218` só reconhece o código `23503`. A partir do PostgreSQL 18, a violação de `ON DELETE RESTRICT` vem como `23001`. O produto não é apagado (o dado fica íntegro), mas a loja vê um erro genérico em vez de "Oculte-o da loja". O CI usa PG 16, por isso passa lá. **Correção:** tratar `23503` e `23001`.

### B-12 · BAIXA · Quantidade fracionada arredondada para baixo

`serve.js:2602` usa `Math.floor`: 1,5 vira 1 sem aviso (regras #5). **Correção:** exigir inteiro.

### B-13 · BAIXA · UF inexistente aceita

`serve.js:2631` só confere duas letras, e a regra `*` atende qualquer coisa (regras #7). **Correção:** lista das 27 UFs.

### B-14 · BAIXA · "Avise-me" não dispara em toda reposição

Só o ajuste unitário de variação chama `notifyBackInStock` (`serve.js:2153`). Reposição pelo editor completo do produto (`syncProductVariants`, `serve.js:301-362`) e devolução por cancelamento (`restockOrderItems`, `serve.js:386-403`) não avisam quem pediu.

### B-15 · BAIXA · Promoções agendadas e inativas expostas em `/api/data`

`serve.js:1525,1538` envia todas as promoções. Quem abre o JSON vê campanhas futuras antes do lançamento. **Correção:** filtrar por `isPromoActive` no servidor, como já é feito com os cupons.

---

## 7. Riscos comerciais

Estes pontos não são bugs: são regras que funcionam como foram escritas, mas que a loja precisa decidir conscientemente.

| # | Risco | Detalhe | Sugestão |
|---|---|---|---|
| RC-1 | **Descontos automáticos fixos e acumuláveis com promoção** | Pix 5%, 2 peças −20% e 3+ peças −30% estão no código (`promo.js:86-91`), sem controle no painel, e incidem sobre o preço já promocional. Testado: 3 peças com 50% off saem a R$ 105 de R$ 300 (−65%). | Tornar configurável (ligar/desligar, faixas, se acumula com promoção) e definir uma margem mínima. |
| RC-2 | Promoção + cupom acumulam | R$ 100 com 40% + cupom 30% = R$ 42 (regras #17) | Opção por cupom "não acumula com promoção". |
| RC-3 | Peça "sob consulta" fecha pedido de R$ 0 e reserva estoque | regras #19 | Decidir se "sob consulta" pode entrar na sacola ou só gerar contato. |
| RC-4 | Staff tem quase todos os poderes | Exclui clientes, muda preço, cria cupom de 100% fixo, cancela pedido pago (regras #20) | Restringir ao owner: exclusão de cliente/produto, cupons e promoções acima de X%, cancelamento de pedido pago. |
| RC-5 | Texto do direito de arrependimento | A página condiciona a devolução do valor a a peça "retornar em condições de revenda" e não diz quem paga o envio de volta. Pelo art. 49 do CDC a devolução é integral e imediata; cobrar o frete de retorno da cliente ou condicionar o reembolso pode ser considerado restrição ao direito. | **Revisar com um advogado.** Este relatório não é parecer jurídico. |
| RC-6 | Pós-venda fora do sistema | Sem registro de solicitação, motivo, prazo de 7 dias, reembolso ou status "devolvido". Depende da memória da equipe e do WhatsApp. | Ver plano de ação, fase 3. |
| RC-7 | Versão do PostgreSQL | CI em PG 16; a versão do Neon em produção não foi verificada. Uma atualização para PG 18 ativa o B-11. | Alinhar a versão do CI com a de produção. |

---

## 8. Regras não implementadas

Produto duplicado (P08), imagem por cor (P09), subcategorias (P11), troca de variação na sacola (V06), valor mínimo para cupom (D08), limite de uso por cliente (D09), política de acúmulo configurável (D10), descontos automáticos configuráveis (D11), CPF no checkout (K04), frete por peso/CEP/transportadora (F06), validação de CEP no servidor (F07), status "devolvido" (S07), confirmação de e-mail (U09), vínculo de pedidos de visitante à conta (U10), solicitação de troca/devolução/cancelamento no sistema (T02), registro de motivo e prazo (T03), reembolso registrado no sistema (T04) e permissões granulares no painel (A04).

Nenhuma delas foi inventada como regra obrigatória. Ficam registradas como pendência ou oportunidade. As que mais pesam para uma loja de moda são T02-T04 (pós-venda), D10/D11 (margem) e A04 (permissões).

---

## 9. Recomendações de correção

Para o **PagBank**, que é o motivo de a integração precisar evoluir:

1. Separar "tentativa recusada" de "pedido sem pagamento". `DECLINED` mantém o pedido `pending`, e o cancelamento vem só de `EXPIRED` ou da varredura (B-01).
2. Criar no provedor uma função `getPaymentStatus(reference)` que consulta a API, usada pela varredura antes de cancelar (B-04) e por um botão "Atualizar pagamento" no painel.
3. Criar `refund(reference, amount)` no provedor, chamada ao cancelar um pedido pago (B-03), com estado intermediário visível se a chamada falhar.
4. Reposição de estoque por estorno só antes do envio. Depois do envio, quem decide é a conferência da devolução (B-02).
5. Registrar cada evento de pagamento no histórico do pedido (B-06).

Para o restante: máquina de estados do pedido no servidor (B-05), reconciliação da sacola (B-07), aviso de cupom descartado (B-08), paginação de pedidos (B-09) e as validações simples B-10 a B-15.

Também recomendo incluir `test/regras-negocio.test.js` no `npm test` depois das correções, ajustar a asserção instável do audit #28 e rodar os testes de integração do PagBank em sandbox, conforme o README: aprovado, recusado e depois aprovado, expirado, webhook duplicado e estorno antes e depois do envio.

---

## 10. Plano de ação priorizado

| Fase | Itens | Por quê | Esforço estimado |
|---|---|---|---|
| **1 — Antes de ativar o pagamento online** | B-01, B-02, B-03, B-04, histórico de pagamento (parte do B-06) | Prejuízo financeiro direto, venda de peça inexistente e cobrança sem pedido | 2–3 dias + validação em sandbox |
| **2 — Integridade operacional** | B-05, B-06, B-07, B-08, decisão sobre RC-1/RC-2/RC-3 | Evita erro humano no painel e frustração no checkout; protege a margem | 2–3 dias |
| **3 — Pós-venda e permissões** | T02-T04 + S07 (fluxo de troca/devolução com prazo de 7 dias), A04/RC-4, B-09, revisão jurídica RC-5 | Controle de prazos legais e rastreabilidade | 3–5 dias |
| **4 — Ajustes menores** | B-10 a B-15, RC-7, audit #28, e2e no CI | Higiene | 1 dia |

**Aguardando autorização para iniciar as correções.** Nenhuma alteração foi feita além da criação deste relatório e do arquivo de testes.
