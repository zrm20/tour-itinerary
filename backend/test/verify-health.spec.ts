import { createServer, type RequestListener, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const expectedCommit = '0123456789abcdef0123456789abcdef01234567';
const verifier = resolve('scripts/verify-health.mjs');
let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
});

async function serve(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port');
  }
  return `http://127.0.0.1:${address.port}/health`;
}

async function verify(url: string): Promise<{
  exitCode: number | null;
  output: string;
}> {
  const child = spawn(
    process.execPath,
    [verifier, '--url', url, '--commit', expectedCommit, '--attempts', '1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exitCode = await new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );
  return { exitCode, output };
}

it('accepts the exact health response and expected commit', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', commit: expectedCommit }));
  });

  await expect(verify(url)).resolves.toMatchObject({ exitCode: 0 });
});

it('rejects a mismatched commit', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: 'ok',
        commit: 'abcdef0123456789abcdef0123456789abcdef01',
      }),
    );
  });

  const result = await verify(url);

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('commit did not match');
});

it.each([
  ['non-200 response', 503, '{"status":"ok"}', 'expected HTTP 200'],
  ['invalid JSON', 200, 'not-json', 'valid JSON'],
  ['wrong status', 200, '{"status":"starting"}', 'status was not "ok"'],
] as const)('rejects a %s', async (_name, status, body, expectedMessage) => {
  const url = await serve((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });

  const result = await verify(url);

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(expectedMessage);
});

it('fails after the bounded attempts when the container is unavailable', async () => {
  const result = await verify('http://127.0.0.1:1/health');

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('attempt 1/1 failed');
});
