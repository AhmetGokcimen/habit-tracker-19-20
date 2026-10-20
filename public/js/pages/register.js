import { api } from '../api.js';
import { $ } from '../dom.js';
import { setupAuthStage } from '../auth-stage.js';
import { showFormErrors, clearFormErrors, withBusy } from '../shell.js';

const mascot = setupAuthStage();
const form = $('#register-form');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFormErrors(form);
  // Client checks are only for convenience; the server validates everything again.
  if (!form.reportValidity()) return;

  const payload = {
    username: form.username.value.trim(),
    email: form.email.value.trim(),
    password: form.password.value,
  };
  await withBusy(form.querySelector('[type="submit"]'), async () => {
    try {
      await api.post('/api/auth/register', payload);
      mascot.react('happy');
      setTimeout(() => location.assign('/'), 350);
    } catch (err) {
      mascot.react('oops');
      showFormErrors(form, err);
    }
  });
});
