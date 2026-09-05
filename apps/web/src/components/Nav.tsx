import Link from 'next/link';

export function Nav() {
  return (
    <nav className="top">
      <div className="inner">
        <span className="brand">AICA</span>
        <Link href="/">Overview</Link>
        <Link href="/apis">API catalog</Link>
        <Link href="/runs">Runs</Link>
      </div>
    </nav>
  );
}
