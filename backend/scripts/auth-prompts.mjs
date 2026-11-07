import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/** Prompt only for missing values, preserving environment-driven automation. */
export async function accountInput(
  register,
  env = process.env,
  { input = process.stdin, output: terminal = process.stdout } = {},
) {
  let hidden = false;
  let readline;
  let passwordLabel = '';
  const maskPassword = (_text, key) => {
    if (
      !hidden ||
      key?.name === 'return' ||
      key?.name === 'enter' ||
      (key?.ctrl && key.name === 'c')
    )
      return;
    terminal.write(
      `\r\x1b[2K${passwordLabel}${'*'.repeat(Array.from(readline.line).length)}`,
    );
  };
  const abort = new AbortController();
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) terminal.write(chunk, encoding);
      callback();
    },
  });
  async function field(
    label,
    variable,
    { secret = false, optional = false, minLength = 1 } = {},
  ) {
    const supplied = secret ? env[variable] : env[variable]?.trim();
    if (supplied) return supplied;
    if (!input.isTTY || !terminal.isTTY) {
      if (optional) return undefined;
      throw new Error(
        `${variable} is required without an interactive terminal`,
      );
    }
    if (!readline) {
      readline = createInterface({
        input,
        output,
        terminal: true,
      });
      readline.on('SIGINT', () => abort.abort());
      readline.on('close', () => abort.abort());
      input.on('keypress', maskPassword);
    }
    while (true) {
      passwordLabel = `${label}: `;
      hidden = secret;
      if (secret) terminal.write(passwordLabel);
      let answer;
      try {
        answer = await readline.question(`${label}: `, {
          signal: abort.signal,
        });
      } finally {
        hidden = false;
        if (secret) terminal.write('\n');
      }
      const value = secret ? answer : answer.trim();
      if (!value && optional) return undefined;
      if (value.length >= minLength) return value;
      terminal.write(
        value
          ? `Password must contain at least ${minLength} characters.\n`
          : `${label} is required.\n`,
      );
    }
  }
  try {
    const email = await field('Email', 'OIDC_EMAIL');
    const password = await field(
      register
        ? 'Password (at least 8 characters; Enter to continue)'
        : 'Password (Enter to continue)',
      'OIDC_PASSWORD',
      { secret: true, minLength: register ? 8 : 1 },
    );
    if (!register) return { email, password };
    const firstName = await field('First name', 'OIDC_FIRST_NAME');
    const lastName = await field('Last name', 'OIDC_LAST_NAME');
    const preferredName = await field(
      'Preferred name (optional; Enter to skip)',
      'OIDC_PREFERRED_NAME',
      { optional: true },
    );
    return { email, password, firstName, lastName, preferredName };
  } finally {
    input.removeListener('keypress', maskPassword);
    readline?.close();
  }
}
