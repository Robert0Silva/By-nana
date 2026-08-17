// Implementação do contrato descrito em payment-provider.js usando o Checkout Pro do Mercado
// Pago (preferência de pagamento -> página hospedada pelo MP -> webhook de confirmação).
//
// Env vars usadas (ver .env.example):
//   MERCADOPAGO_ACCESS_TOKEN  — access token da conta MP (TEST-... em sandbox, APP_USR-... em produção).
//   MERCADOPAGO_WEBHOOK_SECRET — "Assinatura secreta" configurada no painel do MP em
//     Suas integrações > (sua aplicação) > Webhooks, usada pra validar que a notificação
//     realmente veio do Mercado Pago (ver verifySignature abaixo).
//   SITE_URL — domínio público do site; sem ela não dá pra montar back_urls/notification_url
//     com URL absoluta, então a preferência é criada sem redirecionamento automático nem
//     notificação (só funciona pra testar a página de pagamento manualmente).
const https = require('https');
const crypto = require('crypto');

function mpRequest(method, urlPath, body) {
  const accessToken = (process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
  if (!accessToken) return Promise.reject(new Error('MERCADOPAGO_ACCESS_TOKEN não configurado'));
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.mercadopago.com',
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
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
            reject(new Error(`Mercado Pago ${method} ${urlPath} -> ${res.statusCode}: ${data.message || raw}`));
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
    // Um único item com o total já calculado no servidor (desconto/frete inclusos) em vez de
    // um item por produto — evita qualquer divergência de arredondamento entre a soma dos
    // itens e orders.total, que é o valor que já reservou o estoque e é a fonte da verdade.
    items: [
      {
        id: orderId,
        title: `Pedido ${orderId} — By NaNa`,
        description: description || undefined,
        quantity: 1,
        unit_price: Number(total),
        currency_id: 'BRL',
      },
    ],
    payer: {
      name: customerName || undefined,
      email: customerEmail || undefined,
    },
    external_reference: orderId,
    statement_descriptor: 'BY NANA',
  };

  if (siteUrl) {
    body.back_urls = {
      success: `${siteUrl}/?checkout=success&order=${encodeURIComponent(orderId)}`,
      pending: `${siteUrl}/?checkout=pending&order=${encodeURIComponent(orderId)}`,
      failure: `${siteUrl}/?checkout=failure&order=${encodeURIComponent(orderId)}`,
    };
    body.auto_return = 'approved';
    body.notification_url = `${siteUrl}/api/webhooks/mercadopago`;
  }

  const preference = await mpRequest('POST', '/checkout/preferences', body);
  // sandbox_init_point só existe pra access token de teste (TEST-...); em produção o próprio
  // init_point já é a URL certa — por isso tenta o sandbox primeiro e cai pro outro.
  const checkoutUrl = preference.sandbox_init_point || preference.init_point;
  if (!checkoutUrl) throw new Error('Mercado Pago não retornou init_point na preferência');
  return { checkoutUrl, providerReference: preference.id };
}

// Notificação v2 do MP assina `id:{data.id};request-id:{x-request-id};ts:{ts};` com HMAC-SHA256
// usando a "assinatura secreta" do painel de Webhooks — não é a mesma coisa que o access token.
// Doc: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/webhooks/notifications
function verifySignature(req, dataId) {
  const secret = (process.env.MERCADOPAGO_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    console.warn('[mercadopago] MERCADOPAGO_WEBHOOK_SECRET não configurado — rejeitando webhook (não dá pra confirmar que veio do Mercado Pago).');
    return false;
  }
  const signatureHeader = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  if (!signatureHeader || !requestId || !dataId) return false;

  const parts = {};
  String(signatureHeader).split(',').forEach((pair) => {
    const [key, value] = pair.split('=').map((s) => s.trim());
    if (key) parts[key] = value;
  });
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const STATUS_MAP = {
  approved: 'paid',
  pending: 'pending',
  in_process: 'pending',
  authorized: 'pending',
  rejected: 'failed',
  cancelled: 'failed',
  refunded: 'refunded',
  charged_back: 'refunded',
};

// Recebe o request bruto do endpoint /api/webhooks/mercadopago, valida a assinatura e busca o
// pagamento pra descobrir o pedido (external_reference) e o novo payment_status. Retorna null
// quando a assinatura é inválida (o caller deve responder 401) ou quando a notificação não é
// sobre um pagamento (ex.: teste de "merchant_order" — o caller deve só responder 200 e ignorar).
async function handleWebhook(req) {
  const url = new URL(req.url, 'http://internal');
  const type = url.searchParams.get('type') || url.searchParams.get('topic');
  const dataId = url.searchParams.get('data.id') || url.searchParams.get('id');
  if (type && type !== 'payment') return { ignored: true };
  if (!dataId) return { ignored: true };

  if (!verifySignature(req, dataId)) return null;

  const payment = await mpRequest('GET', `/v1/payments/${encodeURIComponent(dataId)}`);
  const orderId = payment.external_reference;
  const status = STATUS_MAP[payment.status] || 'pending';
  if (!orderId) return { ignored: true };
  return { orderId, status, providerReference: String(payment.id) };
}

module.exports = { createCheckoutSession, handleWebhook };
