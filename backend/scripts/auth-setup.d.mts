export function provisionOidc(
  connectionString: string,
  options: {
    audience: string;
    clientId: string;
    callback: string;
    lifetime?: number;
    secret?: string;
    browser?: { clientId: string; callback: string };
  },
): Promise<void>;
