export type EditorOptions = {
  issuer: string;
  audience: string;
  clientId: string;
  callback: string;
};

// Kept as browser JavaScript, like the provider-owned login page. Tests execute
// this exact script with browser adapters and the real HTTP/provider boundary.
const script = String.raw`
(async () => {
  const status = document.getElementById('auth-status');
  const signIn = document.getElementById('sign-in');
  const signOut = document.getElementById('sign-out');
  const key = 'tour-itinerary:graphiql:auth';
  const binding = options && JSON.stringify(options);
  let session = {};
  let storageAvailable = true;
  let busy = false;
  let timer;
  const message = (text) => { status.textContent = text; };
  const save = () => {
    try { sessionStorage.setItem(key, JSON.stringify({ binding, ...session })); }
    catch { storageAvailable = false; }
  };
  const controls = () => {
    signIn.hidden = !options || !!session.idToken;
    signOut.hidden = !options || !session.idToken;
    signIn.disabled = signOut.disabled = busy || !storageAvailable;
  };
  const expire = () => {
    clearTimeout(timer);
    delete session.accessToken;
    delete session.expiresAt;
    save();
    message('Session expired. Sign out, then sign in again.');
    controls();
  };
  const showSession = () => {
    clearTimeout(timer);
    if (session.accessToken && session.expiresAt <= Date.now()) return expire();
    if (session.accessToken) {
      message('Signed in.');
      timer = setTimeout(expire, Math.max(0, session.expiresAt - Date.now()));
    } else message(session.idToken ? 'Signed out of the editor. Retry provider sign-out.' : 'Signed out.');
    controls();
  };
  const post = async (path, body) => {
    const response = await fetch('/graphql/auth/' + path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Editor authentication failed');
    return response.json();
  };
  const random = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return base64url(bytes);
  };
  const base64url = (bytes) => btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || '{}');
    if (saved.binding === binding) session = saved;
    else sessionStorage.removeItem(key);
  } catch { storageAvailable = false; }

  signIn.onclick = async () => {
    busy = true;
    controls();
    try {
      if (location.origin !== new URL(options.issuer).origin) throw new Error('Wrong origin');
      const verifier = random();
      const pending = { verifier, state: random(), nonce: random(), createdAt: Date.now() };
      session = { pending };
      save();
      if (!storageAvailable) throw new Error('Storage unavailable');
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const url = new URL(options.issuer + '/oauth2/authorize');
      url.search = new URLSearchParams({
        client_id: options.clientId, redirect_uri: options.callback,
        response_type: 'code', scope: 'openid profile email', resource: options.audience,
        state: pending.state, nonce: pending.nonce,
        code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      location.assign(url.href);
    } catch {
      busy = false;
      message('Cannot start sign-in. Use the configured issuer origin and enable browser session storage, then retry.');
      controls();
    }
  };
  signOut.onclick = async () => {
    busy = true;
    clearTimeout(timer);
    delete session.accessToken;
    delete session.expiresAt;
    save();
    message('Signing out of the provider…');
    controls();
    try {
      await post('logout', { idToken: session.idToken });
      session = {};
      save();
      message('Signed out. Sign in to switch accounts.');
    } catch { message('Provider sign-out failed. The editor token is cleared. Retry sign-out.'); }
    busy = false;
    controls();
  };

  showSession();
  if (callback) {
    busy = true;
    controls();
    try {
      const pending = session.pending;
      delete session.pending;
      save();
      if (!options || !pending || !storageAvailable ||
          Date.now() - pending.createdAt > 600000 || Date.now() < pending.createdAt ||
          callback.getAll('state').length !== 1 || callback.get('state') !== pending.state ||
          callback.has('error') || callback.getAll('code').length !== 1 || !callback.get('code') ||
          (callback.has('iss') && (callback.getAll('iss').length !== 1 || callback.get('iss') !== options.issuer)))
        throw new Error('Invalid callback');
      const tokens = await post('exchange', { code: callback.get('code'), verifier: pending.verifier, nonce: pending.nonce });
      session = tokens;
      save();
      showSession();
    } catch {
      session = {};
      save();
      message('Sign-in failed, was cancelled, or expired. Start sign-in again.');
    }
    busy = false;
    controls();
  } else if (session.pending) {
    delete session.pending;
    save();
    message('Sign-in was not completed. Start sign-in again.');
  }
  if (!options) message('Signed out. Editor sign-in is not configured; public queries are available.');
  else if (!storageAvailable) message('Enable browser session storage and reload to sign in. Public queries are available.');

  const fetcher = async (parameters) => {
    if (session.accessToken && session.expiresAt <= Date.now()) expire();
    const token = session.accessToken;
    const response = await fetch('/graphql', {
      method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(parameters),
    });
    const result = await response.json();
    if (token && session.accessToken === token &&
        (response.status === 401 || result.errors?.some(error => error.extensions?.code === 'UNAUTHENTICATED')))
      expire();
    return result;
  };
  ReactDOM.render(React.createElement(GraphiQL, {
    fetcher, defaultEditorToolsVisibility: true,
    shouldPersistHeaders: false, isHeadersEditorEnabled: false,
  }), document.getElementById('graphiql'));
})();
`;

export function editorPage(options: EditorOptions | null) {
  // Escape configuration for a script context; never interpolate callback input.
  const json = JSON.stringify(options).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GraphiQL · Tour Itinerary</title>
<script>
const callback = location.pathname === '/graphql/auth/callback' ? new URLSearchParams(location.search) : null;
if (callback) history.replaceState(null, '', '/graphql');
const options = ${json};
</script>
<style>body{margin:0;font-family:system-ui,sans-serif}header{padding:0.75rem;display:flex;gap:1rem;align-items:center;min-height:2rem}button{font:inherit;cursor:pointer}#graphiql{height:calc(100vh - 4rem)}</style>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<link rel="stylesheet" href="https://unpkg.com/graphiql@3.8.3/graphiql.min.css">
</head><body>
<header aria-label="Editor authentication"><span id="auth-status" role="status" aria-live="polite">Loading sign-in status…</span><button id="sign-in" hidden>Sign in</button><button id="sign-out" hidden>Sign out / switch account</button></header>
<div id="graphiql">Loading GraphiQL…</div>
<script src="https://unpkg.com/graphiql@3.8.3/graphiql.min.js"></script>
<script>${script}</script>
</body></html>`;
}
