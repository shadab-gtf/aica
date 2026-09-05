import { useEffect, useState } from 'react';

import { OrderService, totalOf } from '../services/orders.js';
import type { Order, OrderStatus } from '../types.js';
import { formatMoney, formatStatus, truncate } from '../utils/format.js';

export interface OrderListProps {
  token: string;
  status?: OrderStatus;
}

export function OrderList({ token, status }: OrderListProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const service = new OrderService({ token });
    const load = status ? service.byStatus(status) : service.list();

    load.then((result) => setOrders(result)).finally(() => setLoading(false));
  }, [token, status]);

  if (loading) {
    return <p>Loading orders…</p>;
  }

  return (
    <section>
      <h2>Orders ({orders.length})</h2>
      <ul>
        {orders.map((order) => (
          <li key={order.id}>
            <span>{truncate(order.id)}</span>
            <span>{formatStatus(order.status)}</span>
            <span>{formatMoney(order.total)}</span>
          </li>
        ))}
      </ul>
      <footer>Total: {totalOf(orders)}</footer>
    </section>
  );
}

export default OrderList;
