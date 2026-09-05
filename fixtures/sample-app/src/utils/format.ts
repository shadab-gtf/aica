import type { Money, OrderStatus } from '../types.js';

export function formatMoney(money: Money): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: money.currency,
  }).format(money.amount / 100);
}

export function formatStatus(status: OrderStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'shipped':
      return 'Shipped';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

export function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
