import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';

let issuer: string;
let status = 200;
let received: unknown;
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  request.on('end', () => {
    received = {
      path: request.url,
      origin: request.headers.origin,
      body: JSON.parse(body) as unknown,
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  issuer = `http://127.0.0.1:${address.port}/auth`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
async function run(mode: string, account: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('OIDC_')) delete env[key];
  const child = spawn(process.execPath, ['scripts/oidc-client.mjs', mode], {
    env: { ...env, AUTH_ISSUER: issuer, ...account },
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
