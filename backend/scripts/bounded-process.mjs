import { spawn } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import process from 'node:process';

// Linux delivery uses a separate process group so a timeout also stops npm's
// shell, the database runner, Prisma CLI and its schema-engine descendants.
// Deliberately discard diagnostics: database URLs must never reach summaries.
export async function boundedProcess(bin, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      ...options,
      detached: true,
      stdio: 'ignore',
    });
    let expired = false;
    const stop = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, 120_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Database subprocess failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      stop();
      if (code === 0 && !expired) resolve();
      else reject(new Error('Database subprocess failed or timed out'));
    });
  });
}
