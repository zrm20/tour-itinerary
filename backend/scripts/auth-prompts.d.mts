import type { Readable, Writable } from 'node:stream';
export function accountInput(
  register: boolean,
  env?: NodeJS.ProcessEnv,
  io?: {
    input: Readable & { isTTY?: boolean };
    output: Writable & { isTTY?: boolean };
  },
): Promise<{
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  preferredName?: string;
}>;
