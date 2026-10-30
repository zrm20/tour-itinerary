export class AppConfig {
  readonly port: number;
  readonly commit: string;

  constructor(env: NodeJS.ProcessEnv) {
    const nodeEnv = env.NODE_ENV ?? 'development';
    if (!['development', 'test', 'production'].includes(nodeEnv)) {
      throw new Error(
        'Invalid configuration: NODE_ENV must be development, test, or production',
      );
    }

    const port = env.PORT ?? '3000';
    this.port = Number(port);
    if (!/^\d+$/.test(port) || this.port < 1 || this.port > 65535) {
      throw new Error(
        'Invalid configuration: PORT must be an integer from 1 to 65535',
      );
    }
    this.commit = env.COMMIT_SHA ?? 'local';
    if (
      !/^[0-9a-f]{40}$/.test(this.commit) &&
      (nodeEnv === 'production' || this.commit !== 'local')
    ) {
      throw new Error(
        'Invalid configuration: COMMIT_SHA must be a full 40-character lowercase Git SHA (local is allowed outside production)',
      );
    }
  }
}
