export interface OidcOptions {
  issuer: string;
  audience: string;
  clientId: string;
  callback: string;
}
export interface AuthorizationRequest extends OidcOptions {
  url: URL;
  verifier: string;
  state: string;
  nonce: string;
}
export interface TokenSet {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
}
export function authorizationRequest(
  options: OidcOptions,
): AuthorizationRequest;
export function callbackCode(
  location: string,
  request: AuthorizationRequest,
): string;
export function exchangeCode(
  request: AuthorizationRequest,
  code: string,
  verifier?: string,
): Promise<TokenSet>;
export function signIn(
  options: OidcOptions,
  credentials: { email: string; password: string },
): Promise<TokenSet>;
export function signOut(
  options: OidcOptions,
  hint: { idToken: string },
): Promise<void>;
