import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

let issuer: string;
let status = 200;
let received: unknown;
let directory: string;
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  request.on('end', () => {
    received = {
      path: request.url,
      origin: request.headers.origin,
      body:
        request.headers['content-type'] === 'application/x-www-form-urlencoded'
          ? Object.fromEntries(new URLSearchParams(body))
          : body
            ? (JSON.parse(body) as unknown)
            : null,
    };
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        token: 'private-session-token',
        password: 'private-password',
      }),
    );
  });
});
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'oidc-cli-errors-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  issuer = `http://127.0.0.1:${address.port}/auth`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
});
async function run(mode: string, account: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('OIDC_')) delete env[key];
  const child = spawn(process.execPath, ['scripts/oidc-client.mjs', mode], {
    env: {
      ...env,
      AUTH_ISSUER: issuer,
      OIDC_SESSION_FILE: join(directory, 'session.json'),
      ...account,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, output };
}
const account = {
  OIDC_EMAIL: 'cli@example.test',
  OIDC_PASSWORD: 'private-password',
  OIDC_FIRST_NAME: ' Alex ',
  OIDC_LAST_NAME: 'River',
};
test('noninteractive registration sends the profile and matching origin without printing secrets', async () => {
  status = 200;
  const result = await run('register', account);
  expect(result.code).toBe(0);
  expect(result.output).toContain('Registration succeeded');
  expect(result.output).not.toMatch(/private-session-token|private-password/);
  expect(received).toEqual({
    path: '/auth/sign-up/email',
    origin: new URL(issuer).origin,
    body: {
      email: 'cli@example.test',
      password: 'private-password',
      firstName: 'Alex',
      lastName: 'River',
    },
  });
});
test('registration reports HTTP rejection without leaking the response', async () => {
  status = 422;
  const result = await run('register', {
    ...account,
    OIDC_PREFERRED_NAME: 'Lex',
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain('Registration rejected (HTTP 422)');
  expect(result.output).not.toMatch(/private-session-token|private-password/);
});
test('missing noninteractive input fails promptly with the missing variable', async () => {
  const result = await run('register', { OIDC_EMAIL: account.OIDC_EMAIL });
  expect(result.code).toBe(1);
  expect(result.output).toContain(
    'OIDC_PASSWORD is required without an interactive terminal',
  );
});
test('sign-in checks client configuration before prompting', async () => {
  const result = await run('signin');
  expect(result.code).toBe(1);
  expect(result.output).toContain(
    'OIDC_CLIENT_ID and OIDC_CALLBACK_URL are required',
  );
});
test('sign-out checks client configuration before prompting', async () => {
  const result = await run('signout');
  expect(result.code).toBe(1);
  expect(result.output).toContain(
    'OIDC_CLIENT_ID and OIDC_CALLBACK_URL are required',
  );
});

const client = {
  OIDC_CLIENT_ID: 'local-cli',
  OIDC_CALLBACK_URL: 'http://127.0.0.1:9876/callback',
};
async function savedSession(name: string, overrides = {}) {
  const path = join(directory, name);
  await writeFile(
    path,
    JSON.stringify({
      issuer,
      clientId: client.OIDC_CLIENT_ID,
      idToken: 'private-id-token',
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return path;
}
test('sign-out with no saved session does not ask for credentials or contact the provider', async () => {
  received = undefined;
  const result = await run('signout', client);
  expect(result.code).toBe(1);
  expect(result.output).toContain('No saved CLI session');
  expect(received).toBeUndefined();
});
test('failed logout preserves the saved session for retry without leaking it', async () => {
  status = 503;
  const path = await savedSession('retry.json');
  const before = await readFile(path, 'utf8');
  const result = await run('signout', { ...client, OIDC_SESSION_FILE: path });
  expect(result.code).toBe(1);
  expect(result.output).not.toMatch(
    /private-id-token|private-session-token|private-password/,
  );
  expect(await readFile(path, 'utf8')).toBe(before);
  status = 200;
  const retry = await run('signout', { ...client, OIDC_SESSION_FILE: path });
  expect(retry.code).toBe(0);
  expect(received).toMatchObject({
    path: '/auth/oauth2/end-session',
    body: { client_id: 'local-cli', id_token_hint: 'private-id-token' },
  });
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
test.each([
  { issuer: 'https://other.example.test/auth' },
  { clientId: 'another-client' },
])(
  'sign-out refuses a saved session for a different provider or client: %j',
  async (overrides) => {
    const path = await savedSession('mismatch.json', overrides);
    received = undefined;
    const result = await run('signout', { ...client, OIDC_SESSION_FILE: path });
    expect(result.code).toBe(1);
    expect(result.output).toContain('Saved CLI session does not match');
    expect(received).toBeUndefined();
    expect(await readFile(path, 'utf8')).toContain('private-id-token');
  },
);
test('sign-out refuses a session file readable by other users', async () => {
  const path = await savedSession('public.json');
  await chmod(path, 0o644);
  received = undefined;
  const result = await run('signout', { ...client, OIDC_SESSION_FILE: path });
  expect(result.code).toBe(1);
  expect(result.output).toContain('Session file must be private');
  expect(received).toBeUndefined();
});
test('sign-out refuses a symbolic link without deleting its target', async () => {
  const target = await savedSession('target.json');
  const path = join(directory, 'link.json');
  await symlink(target, path);
  received = undefined;
  const result = await run('signout', { ...client, OIDC_SESSION_FILE: path });
  expect(result.code).toBe(1);
  expect(received).toBeUndefined();
  expect(await readFile(target, 'utf8')).toContain('private-id-token');
});
test('failed sign-in removes its empty reservation so the user can retry', async () => {
  const result = await run('signin', client);
  expect(result.code).toBe(1);
  expect(result.output).toContain('OIDC_EMAIL is required');
  await expect(stat(join(directory, 'session.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
