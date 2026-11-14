import { randomBytes } from 'node:crypto';
import type { Response } from 'express';

const styles = `
  body { font-family: system-ui, sans-serif; background: #f4f4f5; color: #18181b; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 3px rgb(0 0 0 / 0.1); width: min(22rem, 90vw); }
  h1 { font-size: 1.25rem; margin: 0 0 1.5rem; }
  label { display: block; font-size: 0.875rem; margin-bottom: 1rem; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.5rem; font: inherit; border: 1px solid #a1a1aa; border-radius: 0.25rem; }
  button { width: 100%; padding: 0.6rem; font: inherit; border: 0; border-radius: 0.25rem; background: #18181b; color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  p[role="alert"] { color: #b91c1c; font-size: 0.875rem; }
`;

// Messages are fixed so they never reflect input or reveal whether an account exists.
const loginScript = `
  const form = document.getElementById('login');
  const alert = document.getElementById('error');
  const button = form.querySelector('button');
  const showError = (message) => {
    alert.textContent = message;
    alert.hidden = false;
    form.elements.password.value = '';
    form.elements.password.focus();
    button.disabled = false;
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alert.hidden = true;
    button.disabled = true;
    try {
      const response = await fetch('/auth/sign-in/email', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          email: form.elements.email.value,
          password: form.elements.password.value,
          oauth_query: location.search.slice(1),
        }),
      });
      if (response.status === 401) return showError('Incorrect email or password.');
      const result = response.ok ? await response.json() : undefined;
      const next = typeof result?.url === 'string' ? new URL(result.url, location.href) : undefined;
      if (next && (next.protocol === 'http:' || next.protocol === 'https:'))
        return location.assign(next.href);
      showError('Sign-in could not be completed. Return to your application and start sign-in again.');
    } catch {
      showError('Sign-in is unavailable. Try again.');
    }
  });
`;

function renderDocument(
  nonce: string,
  title: string,
  content: string,
  script = '',
) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Tour Itinerary</title>
<style nonce="${nonce}">${styles}</style>
</head>
<body>
<main>
<h1>${title}</h1>
${content}
</main>
${script ? `<script nonce="${nonce}">${script}</script>` : ''}
</body>
</html>
`;
}

function sendHtml(
  response: Response,
  status: number,
  render: (nonce: string) => string,
) {
  const nonce = randomBytes(16).toString('base64');
  response
    .status(status)
    .set({
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    })
    .type('html')
    .send(render(nonce));
}

export function sendLoginPage(response: Response) {
  sendHtml(response, 200, (nonce) =>
    renderDocument(
      nonce,
      'Sign in',
      `<form id="login" method="post">
<label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required></label>
<p id="error" role="alert" hidden></p>
<button type="submit">Sign in</button>
</form>`,
      loginScript,
    ),
  );
}

export function sendInvalidLoginRequest(response: Response) {
  sendHtml(response, 400, (nonce) =>
    renderDocument(
      nonce,
      'Sign-in link invalid',
      '<p>This sign-in request is invalid or has expired. Return to your application and start sign-in again.</p>',
    ),
  );
}
