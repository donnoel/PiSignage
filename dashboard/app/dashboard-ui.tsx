export function StatusPill({ label, tone }: { label: string; tone: "good" | "warn" | "muted" }) {
  const className = {
    good: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    warn: "bg-amber-100 text-amber-900 ring-amber-200",
    muted: "bg-zinc-100 text-zinc-700 ring-zinc-200"
  }[tone];

  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${className}`}>{label}</span>;
}

export function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-zinc-950">{value}</p>
      {detail ? <p className="mt-1 text-sm text-zinc-600">{detail}</p> : null}
    </div>
  );
}
