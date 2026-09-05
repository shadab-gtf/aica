import type { ReactNode } from 'react';

/**
 * Something the user has to know before reading the rest of the page.
 *
 * Used for the two states this dashboard is genuinely likely to be in — the
 * agent server is not running, or it is running and no project is open — both
 * of which would otherwise render as an empty page that looks broken.
 */
export function Notice({
  kind = 'warn',
  title,
  children,
}: {
  kind?: 'warn' | 'error';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={kind === 'error' ? 'notice error' : 'notice'} role="status">
      <strong>{title}</strong>
      {children ? <div style={{ marginTop: 6 }}>{children}</div> : null}
    </div>
  );
}
