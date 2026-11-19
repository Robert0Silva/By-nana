// Implementação do contrato descrito em payment-provider.js usando o Checkout PagBank
// (ex-PagSeguro): cria uma página de pagamento hospedada -> cliente paga lá -> webhook de
// confirmação. Documentação: https://developer.pagbank.com.br/docs/checkout
//
// Env vars usadas (ver .env.example):
//   PAGSEGURO_TOKEN — token da conta PagBank (Portal do Desenvolvedor > Tokens em sandbox;
//     Vendas > Integrações > Gerar Token em produção). Usado tanto pra autenticar as chamadas
//     de API (Authorization: Bearer) quanto pra validar a assinatura dos webhooks.
//   PAGSEGURO_SANDBOX — "true" pra usar sandbox.api.pagseguro.com em vez de api.pagseguro.com.
//   SITE_URL — domínio público do site; sem ela não dá pra montar redirect_url/notification_urls
//     com URL absoluta, então o checkout é criado sem redirecionamento nem notificação (só
//     funciona pra testar a página de pagamento manualmente).
//   PAGSEGURO_API_BASE_URL — SÓ em NODE_ENV=test: aponta as chamadas pra um PagBank simulado
//     local (test/pagamentos.test.js). Fora de teste é ignorada. Em teste, sem ela, nenhuma
//     chamada sai da máquina (a requisição é recusada antes de abrir conexão).
//   PAGSEGURO_TIMEOUT_MS — tempo máximo de espera por resposta (padrão 10s).
//
// Endpoints usados (conferidos na documentação oficial em 10/11/2026 — ver
// RELATORIO_IMPLEMENTACAO_ECOMMERCE.md, Fase 1):
//   POST /checkouts                  cria o checkout hospedado (rel=PAY é o link da cliente)
//   GET  /checkouts/{id}             consulta o checkout (status ACTIVE/INACTIVE/EXPIRED)
//   GET  /orders/{id}                consulta o pedido PagBank (ORDE_...) com as cobranças
//   GET  /orders?charge_id={id}      acha o pedido PagBank a partir da cobrança
//   POST /charges/{id}/cancel        estorno integral ou parcial: { amount: { value: centavos } }
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// A documentação confirma que a chave de idempotência vai num cabeçalho e que repetir a chave
// devolve a mesma resposta, mas NÃO publica o nome do cabeçalho. x-idempotency-key é o nome
// usado nas APIs do PagBank, a confirmar no sandbox. A proteção contra estorno duplicado NÃO
// depende disso: o servidor trava o pedido e só deixa existir uma tentativa de estorno em aberto.
const IDEMPOTENCY_HEADER = 'x-idempotency-key';

function apiBase() {
  const override = (process.env.PAGSEGURO_API_BASE_URL || '').trim();
  if (process.env.NODE_ENV === 'test') {
    // Em teste nunca falamos com o PagBank de verdade (nem sandbox): ou há um simulado local,
    // ou a chamada é recusada.
    return override ? new URL(override) : null;
  }
  const sandbox = (process.env.PAGSEGURO_SANDBOX || '').trim().toLowerCase() === 'true';
  return new URL(sandbox ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com');
}

// Erro de chamada ao PagBank com o que o chamador precisa para decidir:
//   transient = true  -> resultado desconhecido (timeout, rede, 5xx, "tente mais tarde").
//                        Para estorno, NUNCA tratar como sucesso nem como falha definitiva.
//   transient = false -> o PagBank respondeu e recusou (4xx).
class PagBankError extends Error {
  constructor(message, { statusCode = null, code = null, transient = false } = {}) {
    super(message);
    this.name = 'PagBankError';
    this.statusCode = statusCode;
    this.code = code;
    this.transient = transient;
  }
}

const TRANSIENT_ERROR_CODES = new Set(['40004', '40008']); // rate_limit, refund_temporarily_unavailable

function psRequest(method, urlPath, body, extraHeaders = {}) {
  const token = (process.env.PAGSEGURO_TOKEN || '').trim();
  if (!token) return Promise.reject(new PagBankError('PAGSEGURO_TOKEN não configurado'));
  const base = apiBase();
  if (!base) {
    return Promise.reject(new PagBankError('Chamada ao PagBank bloqueada em ambiente de teste (sem PAGSEGURO_API_BASE_URL)', { transient: true }));
  }
  const payload = body ? JSON.stringify(body) : null;
  const timeoutMs = Number(process.env.PAGSEGURO_TIMEOUT_MS) || 10_000;
  const transport = base.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port || undefined,
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...extraHeaders,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data;
          try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
            return;
          }
          const first = Array.isArray(data.error_messages) ? data.error_messages[0] : null;
          const code = first && first.code ? String(first.code) : null;
          const detail = (first && (first.description || first.error)) || `HTTP ${res.statusCode}`;
          reject(new PagBankError(`PagBank ${method} ${urlPath.split('?')[0]} -> ${res.statusCode}: ${detail}`, {
            statusCode: res.statusCode,
            code,
            transient: res.statusCode >= 500 || res.statusCode === 429 || TRANSIENT_ERROR_CODES.has(code),
          }));
        });
      }
    );
    // sem timeout, uma lentidão do PagBank deixaria a cliente esperando a resposta do pedido
    req.setTimeout(timeoutMs, () => req.destroy(new PagBankError(`PagBank ${method} ${urlPath.split('?')[0]} -> timeout`, { transient: true })));
    req.on('error', (err) => reject(err instanceof PagBankError ? err : new PagBankError(`PagBank ${method} ${urlPath.split('?')[0]} -> ${err.message}`, { transient: true })));
    if (payload) req.write(payload);
    req.end();
  });
}

async function createCheckoutSession({ orderId, total, customerName, customerEmail, items }) {
  const siteUrl = (process.env.SITE_URL || '').trim().replace(/\/$/, '');
  const description = (items || [])
    .map((it) => `${it.qty}x ${it.name}`)
    .join(', ')
    .slice(0, 250);

  const body = {
    reference_id: orderId,
    // Um único item com o total já calculado no servidor (desconto/frete inclusos) em vez de
    // um item por produto — evita qualquer divergência de arredondamento entre a soma dos
    // itens e orders.total, que é o valor que já reservou o estoque e é a fonte da verdade.
    items: [
      {
        reference_id: orderId,
        name: `Pedido ${orderId} — By NaNa`,
        description: description || undefined,
        quantity: 1,
        unit_amount: Math.round(Number(total) * 100), // centavos
      },
    ],
    customer_modifiable: true,
    // Mesmo prazo de CHECKOUT_EXPIRATION_HOURS (payment-provider.js): passado esse tempo o link
    // deixa de aceitar pagamento e a varredura de pedidos pendentes consulta o PagBank antes de
    // devolver o estoque.
    expiration_date: new Date(Date.now() + require('../payment-provider').CHECKOUT_EXPIRATION_HOURS * 60 * 60 * 1000).toISOString(),
    payment_methods: [{ type: 'CREDIT_CARD' }, { type: 'DEBIT_CARD' }, { type: 'PIX' }],
  };
  if (customerName || customerEmail) {
    body.customer = { name: customerName || undefined, email: customerEmail || undefined };
  }

  if (siteUrl) {
    // O checkout hospedado do PagBank não distingue sucesso/pendência/falha na URL de retorno
    // — reaproveita o estado "pending" já existente no front (handleCheckoutReturn em main.js).
    // A confirmação real do pagamento chega só pelo webhook / consulta no servidor, nunca pelo
    // redirecionamento do navegador.
    body.redirect_url = `${siteUrl}/?checkout=pending&order=${encodeURIComponent(orderId)}`;
    body.notification_urls = [`${siteUrl}/api/webhooks/pagseguro`];
  }

  const checkout = await psRequest('POST', '/checkouts', body);
  const payLink = Array.isArray(checkout.links) ? checkout.links.find((l) => l.rel === 'PAY') : null;
  if (!payLink || !payLink.href) throw new Error('PagBank não retornou link de pagamento (rel=PAY) no checkout');
  return { checkoutUrl: payLink.href, providerReference: checkout.id };
}

// Confirma que a notificação veio mesmo do PagBank: SHA256 de "{token}-{corpo bruto}" precisa
// bater com o header x-authenticity-token. Usa o corpo exatamente como chegou (sem re-serializar
// via JSON.stringify) porque qualquer espaço a mais já muda o hash.
// Doc: https://developer.pagbank.com.br/reference/confirmar-autenticidade-da-notificacao
function verifySignature(rawBody, req) {
  const token = (process.env.PAGSEGURO_TOKEN || '').trim();
  if (!token) {
    console.warn('[pagseguro] PAGSEGURO_TOKEN não configurado — rejeitando webhook (não dá pra confirmar que veio do PagBank).');
    return false;
  }
  const header = req.headers['x-authenticity-token'];
  if (!header) return false;

  const expected = crypto.createHash('sha256').update(`${token}-${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(header), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Status de cobrança do PagBank -> vocabulário do contrato. 'failed' aqui quer dizer "esta
// tentativa não foi aprovada" (cartão recusado, cobrança cancelada antes de pagar) — NÃO
// cancela o pedido: a cliente pode tentar de novo no mesmo link enquanto ele estiver válido.
const STATUS_MAP = {
  PAID: 'paid',
  AUTHORIZED: 'pending',
  IN_ANALYSIS: 'pending',
  WAITING: 'pending',
  DECLINED: 'failed',
  CANCELED: 'failed',
};

const cents = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

// Lê a lista de cobranças de um pedido PagBank e devolve a situação financeira consolidada.
// Uma cobrança com dinheiro capturado (paga, ou paga e depois estornada) vale mais que
// tentativas recusadas — sem isso, uma tentativa recusada posterior "despagaria" o pedido.
function summarizeCharges(charges) {
  const list = Array.isArray(charges) ? charges : [];
  if (!list.length) return null;
  const captured = list.find((c) => c && c.status === 'PAID')
    || list.find((c) => c && c.amount && c.amount.summary && cents(c.amount.summary.paid) > 0)
    || list.find((c) => c && c.amount && c.amount.summary && cents(c.amount.summary.refunded) > 0);
  const charge = captured || list[list.length - 1];
  const summary = (charge.amount && charge.amount.summary) || {};
  const refundedCents = cents(summary.refunded);
  let paidCents = cents(summary.paid);
  if (!paidCents && (charge.status === 'PAID' || refundedCents)) paidCents = cents(summary.total) || cents(charge.amount && charge.amount.value);

  let status;
  if (refundedCents > 0) {
    // Sem saber quanto foi pago, um estorno é tratado como integral (comportamento anterior).
    status = paidCents && refundedCents < paidCents ? 'partially_refunded' : 'refunded';
  } else {
    status = STATUS_MAP[charge.status] || 'pending';
  }
  return {
    status,
    chargeId: charge.id || null,
    chargeStatus: charge.status || null,
    paidAmount: paidCents / 100,
    refundedAmount: refundedCents / 100,
  };
}

// Recebe o request bruto do endpoint /api/webhooks/pagseguro (rawBody já drenado pelo caller —
// ver serve.js), valida a assinatura e interpreta o payload. O PagBank manda dois tipos de
// notificação nessa mesma URL: evento de checkout (sem "charges", ex. status EXPIRED) e evento
// transacional (pedido PagBank com "charges").
async function handleWebhook(req, rawBody) {
  if (!verifySignature(rawBody, req)) return null;

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { ignored: true }; }

  const orderId = payload.reference_id;
  if (!orderId) return { ignored: true };
  const charges = Array.isArray(payload.charges) ? payload.charges : [];
  if (!charges.length) {
    // Evento de checkout: só o vencimento interessa (registrado no histórico; o cancelamento
    // continua dependendo da consulta conclusiva feita pela varredura).
    if (payload.status === 'EXPIRED' && String(payload.id || '').startsWith('CHEC')) {
      return { orderId, kind: 'checkout', checkoutStatus: 'EXPIRED', providerReference: payload.id };
    }
    return { ignored: true };
  }

  const snapshot = summarizeCharges(charges);
  return {
    orderId,
    status: snapshot.status,
    providerReference: snapshot.chargeId || payload.id,
    providerOrderId: payload.id || null,
    chargeId: snapshot.chargeId,
    chargeStatus: snapshot.chargeStatus,
    paidAmount: snapshot.paidAmount,
    refundedAmount: snapshot.refundedAmount,
  };
}

const encode = (v) => encodeURIComponent(String(v));

// Situação real do pagamento, consultada no PagBank (nunca no navegador).
// reference: { checkoutId, providerOrderId, chargeId }
// Retorna { conclusive, status, providerOrderId, chargeId, chargeStatus, paidAmount,
//           refundedAmount, checkoutStatus }
//   status: 'paid' | 'pending' | 'failed' | 'refunded' | 'partially_refunded' | 'expired'
//   conclusive: false quando não dá pra afirmar nada (ex.: checkout ainda ativo, ou formato de
//     resposta desconhecido) — quem chama não pode cancelar o pedido nesse caso.
// Erros de comunicação são lançados (PagBankError) — também nunca autorizam cancelamento.
async function getPaymentStatus(reference = {}) {
  const { checkoutId, chargeId } = reference;
  let { providerOrderId } = reference;
  let order = null;

  if (!providerOrderId && chargeId) {
    const found = await psRequest('GET', `/orders?charge_id=${encode(chargeId)}`);
    order = Array.isArray(found.orders) && found.orders[0] ? found.orders[0] : null;
    providerOrderId = order ? order.id : null;
  }
  let checkout = null;
  if (!providerOrderId && checkoutId) {
    checkout = await psRequest('GET', `/checkouts/${encode(checkoutId)}`);
    // A documentação diz que a consulta traz "todos os pagamentos associados", mas não publica
    // o formato — só aproveitamos se vier uma lista de pedidos reconhecível.
    const linked = Array.isArray(checkout.orders) ? checkout.orders : null;
    if (linked && linked.length) providerOrderId = linked[linked.length - 1].id || null;
  }
  if (providerOrderId && !order) order = await psRequest('GET', `/orders/${encode(providerOrderId)}`);

  const snapshot = order ? summarizeCharges(order.charges) : null;
  const base = {
    providerOrderId: providerOrderId || null,
    chargeId: snapshot ? snapshot.chargeId : null,
    chargeStatus: snapshot ? snapshot.chargeStatus : null,
    paidAmount: snapshot ? snapshot.paidAmount : 0,
    refundedAmount: snapshot ? snapshot.refundedAmount : 0,
    checkoutStatus: checkout ? checkout.status || null : null,
  };
  if (snapshot && snapshot.status !== 'failed' && snapshot.status !== 'pending') {
    return { ...base, conclusive: true, status: snapshot.status };
  }
  if (snapshot && snapshot.status === 'pending') {
    // Pix aguardando, cartão em análise: ainda pode virar pago.
    return { ...base, conclusive: false, status: 'pending' };
  }

  // Sem cobrança capturada: só é conclusivo se o checkout comprovadamente não aceita mais
  // pagamento (vencido/inativado no próprio PagBank).
  if (!checkout && checkoutId) checkout = await psRequest('GET', `/checkouts/${encode(checkoutId)}`);
  const checkoutStatus = checkout ? checkout.status || null : null;
  const expiredByDate = checkout && checkout.expiration_date && new Date(checkout.expiration_date).getTime() < Date.now();
  const closed = checkoutStatus === 'EXPIRED' || checkoutStatus === 'INACTIVE' || (checkoutStatus !== 'ACTIVE' && expiredByDate);
  if (checkout && closed) {
    return { ...base, checkoutStatus, conclusive: true, status: 'expired' };
  }
  return { ...base, checkoutStatus, conclusive: false, status: snapshot ? snapshot.status : 'pending' };
}

// Pede ao PagBank o estorno (integral ou parcial) de uma cobrança paga.
// Retorna { confirmed, chargeStatus, paidAmount, refundedAmount, raw } quando o PagBank
// aceitou (HTTP 2xx). confirmed = true só quando o resumo devolvido já mostra o valor estornado.
// Lança PagBankError: transient=true -> resultado desconhecido (NÃO é estorno confirmado nem
// falha definitiva); transient=false -> recusado pelo PagBank.
async function refund({ chargeId, amount, idempotencyKey, expectedRefundedTotal }) {
  if (!chargeId) throw new PagBankError('Cobrança do PagBank não identificada para estorno');
  const value = Math.round(Number(amount) * 100);
  if (!(value > 0)) throw new PagBankError('Valor de estorno inválido');
  const headers = idempotencyKey ? { [IDEMPOTENCY_HEADER]: String(idempotencyKey) } : {};
  const response = await psRequest('POST', `/charges/${encode(chargeId)}/cancel`, { amount: { value } }, headers);
  const summary = (response.amount && response.amount.summary) || {};
  const refundedCents = cents(summary.refunded);
  const target = Math.round(Number(expectedRefundedTotal != null ? expectedRefundedTotal : amount) * 100);
  return {
    confirmed: refundedCents > 0 && refundedCents >= target,
    chargeStatus: response.status || null,
    paidAmount: cents(summary.paid) / 100,
    refundedAmount: refundedCents / 100,
  };
}

module.exports = { createCheckoutSession, handleWebhook, getPaymentStatus, refund, summarizeCharges, PagBankError, IDEMPOTENCY_HEADER };
