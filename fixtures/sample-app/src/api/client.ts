import { BASE_URL, DEFAULT_TIMEOUT_MS, authHeaders } from './config.js';
import type { Order, OrderFilter } from '../types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(token), ...init.headers },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ApiError(response.status, `Request to ${path} failed`);
  }

  return (await response.json()) as T;
}

export async function fetchOrders(token: string, filter: OrderFilter = {}): Promise<Order[]> {
  const query = new URLSearchParams();
  if (filter.status) query.set('status', filter.status);
  if (filter.limit) query.set('limit', String(filter.limit));

  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<Order[]>(`/orders${suffix}`, token);
}

export async function fetchOrder(token: string, orderId: string): Promise<Order> {
  return request<Order>(`/orders/${orderId}`, token);
}

export async function createOrder(token: string, order: Partial<Order>): Promise<Order> {
  return request<Order>('/orders', token, {
    method: 'POST',
    body: JSON.stringify(order),
  });
}

export async function cancelOrder(token: string, orderId: string): Promise<void> {
  await request<void>(`/orders/${orderId}`, token, { method: 'DELETE' });
}
