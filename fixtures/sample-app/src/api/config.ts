export const BASE_URL = 'https://api.example.com/v1';

export const DEFAULT_TIMEOUT_MS = 10_000;

export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}
