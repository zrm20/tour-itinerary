// System-time adapter for the public CLI timeout test; production has no hook.
import timers from 'node:timers';
import { syncBuiltinESMExports } from 'node:module';
const setTimeout = timers.setTimeout;
timers.setTimeout = (callback, delay, ...args) =>
  setTimeout(callback, delay === 120_000 ? 500 : delay, ...args);
syncBuiltinESMExports();
