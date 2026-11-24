export type AnalyticsKpi = {
  label: string;
  value: string;
};

interface AnalyticsSummaryCardsProps {
  items: AnalyticsKpi[];
}

export default function AnalyticsSummaryCards({
  items,
}: AnalyticsSummaryCardsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-2xl border border-border bg-card p-5 shadow-sm"
        >
          <p className="text-xs text-muted-foreground">{item.label}</p>
          <p className="mt-1 text-2xl font-bold font-[family-name:var(--font-display)] text-card-foreground">
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}
