// Ponto de extensão pra um gateway de pagamento online (Mercado Pago, Stripe, PagSeguro...).
// A cliente ainda não escolheu qual usar, então por enquanto isso fica "desligado": nenhum
// provedor configurado, o checkout continua exatamente como é hoje (pedido é registrado e o
// pagamento é combinado na conversa do WhatsApp — orders.payment_status fica 'manual').
//
// Como plugar um gateway de verdade quando a cliente decidir:
//   1. Criar um arquivo, ex. payment-providers/mercadopago.js, exportando um objeto com o
//      formato de PROVIDERS abaixo (createCheckoutSession + verifyWebhookSignature).
//   2. Registrar esse objeto em PROVIDERS aqui embaixo com a chave do env var (ex. 'mercadopago').
//   3. Definir PAYMENT_PROVIDER=mercadopago (+ as chaves de API do provedor) no .env.
//   4. Nenhuma outra mudança é necessária — serve.js já chama getActiveProvider() na criação do
//      pedido (ver /api/orders) e grava paymentStatus = 'pending' quando há provedor ativo;
//      falta só implementar o webhook do provedor chamando algo como
//      UPDATE orders SET payment_status = 'paid' WHERE id = $1 quando o pagamento confirmar.
//
// Contrato esperado de cada provedor:
//   createCheckoutSession({ orderId, total, customerName, customerEmail, items })
//     -> Promise<{ checkoutUrl: string, providerReference: string }>
//   verifyWebhookSignature(req, rawBody) -> boolean

const PROVIDERS = {
  // mercadopago: require('./payment-providers/mercadopago'),
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
