export function StatusPill({
  label,
  size = "default",
  tone
}: {
  label: string;
  size?: "compact" | "default";
  tone: "danger" | "good" | "warn" | "muted";
}) {
  const className = {
    danger: "bg-rose-100 text-rose-800 ring-rose-200",
    good: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    warn: "bg-amber-100 text-amber-900 ring-amber-200",
    muted: "bg-zinc-100 text-zinc-700 ring-zinc-200"
  }[tone];
  const sizeClassName = size === "compact" ? "px-1.5 py-px text-[0.625rem]" : "px-2.5 py-1 text-xs";

  return <span className={`inline-flex whitespace-nowrap rounded-full font-semibold ring-1 ${sizeClassName} ${className}`}>{label}</span>;
}

export function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-h-32 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase text-zinc-500">{label}</p>
      <p className="mt-2 break-words text-2xl font-semibold leading-tight text-zinc-950">{value}</p>
      {detail ? <p className="mt-2 text-sm leading-5 text-zinc-600">{detail}</p> : null}
    </div>
  );
}
