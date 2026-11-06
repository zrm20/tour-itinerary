export function provisionOidc(
  connectionString: string,
  options: {
    audience: string;
    clientId: string;
    callback: string;
    lifetime?: number;
  },
): Promise<void>;
