// Thin client for the JSON API. Every request is same-origin, carries the
// session cookie automatically (HttpOnly — JS never sees it) and sends the
// X-Requested-With header that the server's CSRF check requires.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.details = Array.isArray(body?.details) ? body.details : [];
  }
}

async function request(method, path, { json, form } = {}) {
  const headers = { 'X-Requested-With': 'fetch', Accept: 'application/json' };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // browser sets the multipart boundary
  }

  const res = await fetch(path, { method, headers, body, credentials: 'same-origin', cache: 'no-store' });
  const isJson = res.headers.get('Content-Type')?.includes('application/json');
  const data = isJson ? await res.json() : null;

  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    goToLogin();
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export function goToLogin() {
  const next = location.pathname + location.search;
  location.assign(`/login.html?next=${encodeURIComponent(next)}`);
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, json) => request('POST', path, { json }),
  patch: (path, json) => request('PATCH', path, { json }),
  del: (path) => request('DELETE', path),
  upload: (method, path, form) => request(method, path, { form }),
};
