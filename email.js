// Envio de e-mail transacional via API HTTP do Resend (sem dependência extra — usa o fetch
// nativo do Node). Uma falha aqui nunca deve derrubar o fluxo principal (pedido, redefinição de
// senha etc.), então todo erro é engolido e logado em vez de lançado.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM;

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    console.warn(`[email] RESEND_API_KEY/EMAIL_FROM não configurados — e-mail para ${to} não enviado.`);
    return { ok: false };
  }
  if (!to) return { ok: false };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
    if (!res.ok) {
      console.error(`[email] Resend respondeu ${res.status} ao enviar para ${to}: ${await res.text()}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[email] Falha ao enviar e-mail para ${to}:`, err);
    return { ok: false };
  }
}

module.exports = { sendEmail };
