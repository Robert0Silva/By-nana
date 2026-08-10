const form = document.getElementById('resetForm');
const msg = document.getElementById('resetMsg');
const token = new URLSearchParams(location.search).get('token') || '';

function setMsg(text, kind) {
  msg.textContent = text;
  msg.className = `account-form-msg ${kind === 'ok' ? 'is-ok' : 'is-error'}`;
  msg.hidden = !text;
}

if (!token) {
  form.hidden = true;
  setMsg('Link inválido. Solicite a redefinição de senha novamente na loja.', 'error');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('', '');
  const newPassword = document.getElementById('resetPassword').value;
  const confirm = document.getElementById('resetPasswordConfirm').value;
  if (newPassword !== confirm) {
    setMsg('As senhas não coincidem.', 'error');
    return;
  }
  try {
    const res = await fetch('/api/customers/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Não foi possível redefinir a senha');
    form.hidden = true;
    setMsg('Senha redefinida! Você já pode entrar na loja com a nova senha.', 'ok');
  } catch (err) {
    setMsg(err.message, 'error');
  }
});
