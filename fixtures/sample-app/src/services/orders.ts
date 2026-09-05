import { cancelOrder, createOrder, fetchOrder, fetchOrders } from '../api/client.js';
import type { Order, OrderFilter, OrderStatus } from '../types.js';

export interface OrderServiceOptions {
  token: string;
  pageSize?: number;
}

export class OrderService {
  private readonly token: string;
  private readonly pageSize: number;

  constructor(options: OrderServiceOptions) {
    this.token = options.token;
    this.pageSize = options.pageSize ?? 25;
  }

  async list(filter: OrderFilter = {}): Promise<Order[]> {
    return fetchOrders(this.token, { limit: this.pageSize, ...filter });
  }

  async byStatus(status: OrderStatus): Promise<Order[]> {
    return this.list({ status });
  }

  async get(orderId: string): Promise<Order> {
    return fetchOrder(this.token, orderId);
  }

  async place(order: Partial<Order>): Promise<Order> {
    return createOrder(this.token, order);
  }

  async cancel(orderId: string): Promise<void> {
    await cancelOrder(this.token, orderId);
  }
}

export function totalOf(orders: readonly Order[]): number {
  return orders.reduce((sum, order) => sum + order.total.amount, 0);
}
