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
const https = require('https');
const crypto = require('crypto');

function apiHost() {
  return (process.env.PAGSEGURO_SANDBOX || '').trim().toLowerCase() === 'true'
    ? 'sandbox.api.pagseguro.com'
    : 'api.pagseguro.com';
}

function psRequest(method, urlPath, body) {
  const token = (process.env.PAGSEGURO_TOKEN || '').trim();
  if (!token) return Promise.reject(new Error('PAGSEGURO_TOKEN não configurado'));
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: apiHost(),
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
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
          } else {
            const detail = (Array.isArray(data.error_messages) && data.error_messages[0] && data.error_messages[0].description) || raw;
            reject(new Error(`PagBank ${method} ${urlPath} -> ${res.statusCode}: ${detail}`));
          }
        });
      }
    );
    req.on('error', reject);
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
    payment_methods: [{ type: 'CREDIT_CARD' }, { type: 'DEBIT_CARD' }, { type: 'PIX' }],
  };
  if (customerName || customerEmail) {
    body.customer = { name: customerName || undefined, email: customerEmail || undefined };
  }

  if (siteUrl) {
    // O checkout hospedado do PagBank não distingue sucesso/pendência/falha na URL de retorno
    // (diferente do Mercado Pago, que tem back_urls separadas) — reaproveita o estado "pending"
    // já existente no front (handleCheckoutReturn em main.js). A confirmação real do pagamento
    // chega só pelo webhook (handleWebhook abaixo), que já dispara o e-mail de "pagamento
    // aprovado" — é isso que avisa a cliente, não o redirecionamento.
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

const STATUS_MAP = {
  PAID: 'paid',
  AUTHORIZED: 'pending',
  IN_ANALYSIS: 'pending',
  WAITING: 'pending',
  DECLINED: 'failed',
  CANCELED: 'failed',
};

// Recebe o request bruto do endpoint /api/webhooks/pagseguro (rawBody já drenado pelo caller —
// ver serve.js), valida a assinatura e interpreta o payload. O PagBank manda dois tipos de
// notificação nessa mesma URL: evento de checkout (sem "charges", ex. status EXPIRED — ignorado,
// não é sobre pagamento) e evento transacional (com "charges", que é o que importa aqui).
async function handleWebhook(req, rawBody) {
  if (!verifySignature(rawBody, req)) return null;

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { ignored: true }; }

  const orderId = payload.reference_id;
  const charges = Array.isArray(payload.charges) ? payload.charges : [];
  if (!orderId || !charges.length) return { ignored: true };

  // Cobrança mais recente é a que representa o estado atual do pagamento (ex.: uma tentativa
  // de cartão recusada seguida de uma nova tentativa aprovada).
  const charge = charges[charges.length - 1];
  const refundedAmount = Number(charge.amount && charge.amount.summary && charge.amount.summary.refunded) || 0;
  const status = refundedAmount > 0 ? 'refunded' : (STATUS_MAP[charge.status] || 'pending');
  return { orderId, status, providerReference: charge.id || payload.id };
}

module.exports = { createCheckoutSession, handleWebhook };
