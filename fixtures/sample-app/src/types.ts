export type OrderStatus = 'pending' | 'shipped' | 'cancelled';

export interface Money {
  amount: number;
  currency: string;
}

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPrice: Money;
}

export interface Order {
  id: string;
  status: OrderStatus;
  total: Money;
  lines: OrderLine[];
  placedAt: string;
  note?: string | null;
}

export interface Customer {
  id: string;
  email: string;
  name: string;
}

export enum Channel {
  Web = 'web',
  Mobile = 'mobile',
  Partner = 'partner',
}

export type OrderFilter = {
  status?: OrderStatus;
  channel?: Channel;
  limit?: number;
};
