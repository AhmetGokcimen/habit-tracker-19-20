import { api } from '../api.js';
import { $ } from '../dom.js';
import { setupAuthStage, safeNextPath } from '../auth-stage.js';
import { showFormErrors, clearFormErrors, withBusy } from '../shell.js';

const mascot = setupAuthStage();
const form = $('#login-form');

// Already logged in? Skip the form.
api.get('/api/auth/me').then(() => location.replace(safeNextPath()), () => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFormErrors(form);
  // Client checks are only for convenience; the server validates everything again.
  if (!form.reportValidity()) return;

  const payload = { username: form.username.value.trim(), password: form.password.value };
  await withBusy(form.querySelector('[type="submit"]'), async () => {
    try {
      await api.post('/api/auth/login', payload);
      mascot.react('happy');
      setTimeout(() => location.assign(safeNextPath()), 350);
    } catch (err) {
      mascot.react('oops');
      showFormErrors(form, err);
      form.password.select();
    }
  });
});
