export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
      {hint ? <div style={{ color: 'var(--muted)', marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}
