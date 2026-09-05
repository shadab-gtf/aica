import Link from 'next/link';

export function Nav() {
  return (
    <nav className="sidebar">
      <div className="brand">
        <div className="brand-logo">▲</div>
        <span>AICA</span>
      </div>
      <div className="nav-links">
        <Link href="/" className="nav-link">
          Overview
        </Link>
        <Link href="/apis" className="nav-link">
          API catalog
        </Link>
        <Link href="/runs" className="nav-link">
          Runs
        </Link>
      </div>
    </nav>
  );
}
