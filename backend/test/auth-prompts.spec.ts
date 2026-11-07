/* eslint-disable no-control-regex -- Terminal rendering assertions must match ANSI escape sequences. */
import { PassThrough, Writable } from 'node:stream';
import { expect, test } from 'vitest';
import { accountInput } from '../scripts/auth-prompts.mjs';

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
  });
  let transcript = '';
  const output = Object.assign(
    new Writable({
      write(chunk, encoding, done) {
        transcript += (chunk as Buffer).toString();
        done();
      },
    }),
    { isTTY: true, columns: 100 },
  );
  return {
    input,
    output,
    transcript: () => transcript,
    // Model the cursor-to-column-1 and erase-to-end sequences readline emits.
    line: () =>
      transcript
        .split(/\r?\n/)
        .at(-1)!
        .replace(/^.*\x1b\[1G\x1b\[0J/s, '')
        .replace(/^.*\r\x1b\[2K/s, '')
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test('field label survives readline redraw and remains visible while typing', async () => {
  const io = terminal();
  const result = accountInput(false, {}, io);
  try {
    await tick();
    expect(io.line()).toContain('Email:');
    io.input.write('alex');
    await tick();
    expect(io.line()).toContain('Email: alex');
  } finally {
    io.input.write('\x03');
    await result.catch(() => {});
  }
});
test('password shows masks, retries a short registration password, and allows editing', async () => {
  const io = terminal();
  const result = accountInput(true, { OIDC_EMAIL: 'alex@example.test' }, io);
  try {
    await tick();
    io.input.write('short');
    await tick();
    expect(io.line()).toContain('*****');
    expect(io.transcript()).not.toContain('short');
    io.input.write('\r');
    await tick();
    expect(io.transcript()).toContain('at least 8 characters');
    expect(io.line()).toContain('Password');
    io.input.write('secret-123x');
    await tick();
    io.input.write('\x7f');
    await tick();
    expect(io.line()).toContain('*********');
    io.input.write('\r');
    await tick();
    expect(io.line()).toContain('First name:');
    io.input.write('Alex\r');
    await tick();
    io.input.write('River\r');
    await tick();
    io.input.write('\r');
    expect(await result).toMatchObject({
      password: 'secret-123',
      firstName: 'Alex',
      lastName: 'River',
      preferredName: undefined,
    });
    expect(io.transcript()).not.toContain('secret-123');
  } finally {
    io.input.write('\x03');
    await result.catch(() => {});
  }
});

test('cancelling a masked prompt rejects and removes input listeners', async () => {
  const io = terminal();
  const result = accountInput(false, { OIDC_EMAIL: 'alex@example.test' }, io);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await tick();
  io.input.write('cancelled-password');
  io.input.write('\x03');
  await rejected;
  expect(io.transcript()).not.toContain('cancelled-password');
  expect(io.input.listenerCount('keypress')).toBe(0);
});
