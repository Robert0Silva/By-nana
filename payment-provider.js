// Ponto de extensão pra um gateway de pagamento online (Mercado Pago, Stripe, PagSeguro...).
// Sem PAYMENT_PROVIDER configurado no .env, isso fica "desligado" e o checkout continua como
// sempre foi: pedido registrado e pagamento combinado na conversa do WhatsApp
// (orders.payment_status fica 'manual'). Com um provedor ativo, o site oferece "pagamento
// online" como uma forma de pagamento a mais (ver ONLINE_PAYMENT_METHOD em serve.js) — as
// demais (Pix combinado, dinheiro na entrega etc.) continuam indo pro fluxo manual de sempre.
//
// Como plugar mais um gateway:
//   1. Criar um arquivo, ex. payment-providers/stripe.js, exportando um objeto com o formato
//      de PROVIDERS abaixo (createCheckoutSession + handleWebhook).
//   2. Registrar esse objeto em PROVIDERS aqui embaixo com a chave do env var (ex. 'stripe').
//   3. Definir PAYMENT_PROVIDER=stripe (+ as chaves de API do provedor) no .env.
//   4. Nenhuma outra mudança é necessária — serve.js já chama getActiveProvider() na criação do
//      pedido (ver /api/orders) pra gerar o checkoutUrl, e encaminha POST /api/webhooks/<chave>
//      pra provider.handleWebhook() atualizar orders.payment_status.
//
// Contrato esperado de cada provedor:
//   createCheckoutSession({ orderId, total, customerName, customerEmail, items })
//     -> Promise<{ checkoutUrl: string, providerReference: string }>
//   handleWebhook(req) -> Promise<{ orderId, status: 'paid'|'pending'|'failed'|'refunded', providerReference } | { ignored: true } | null>
//     (null = assinatura inválida; o caller responde 401. { ignored: true } = notificação que não
//     é sobre um pagamento, ou sem dado suficiente; o caller só responde 200 e não faz nada.)

const PROVIDERS = {
  mercadopago: require('./payment-providers/mercadopago'),
  // stripe: require('./payment-providers/stripe'),
};

function getActiveProvider() {
  const key = (process.env.PAYMENT_PROVIDER || '').trim();
  if (!key) return null;
  const provider = PROVIDERS[key];
  if (!provider) {
    console.warn(`[payment-provider] PAYMENT_PROVIDER="${key}" não tem implementação registrada em PROVIDERS — caindo para o fluxo manual/WhatsApp.`);
    return null;
  }
  return provider;
}

module.exports = { getActiveProvider };
