/**
 * One-line summary of how many requests match the current search/filter,
 * including how many are locally saved prototype records.
 */
export default function RequestCountSummary({
  matching,
  total,
  prototypeCount,
  isFiltered,
}: {
  matching: number;
  total: number;
  prototypeCount: number;
  isFiltered: boolean;
}) {
  return (
    <p className="text-xs text-muted-foreground" aria-live="polite">
      {isFiltered ? (
        <>
          <span className="font-semibold text-foreground">{matching}</span> of {total} request
          {total === 1 ? "" : "s"} match your search and filters
        </>
      ) : (
        <>
          <span className="font-semibold text-foreground">{total}</span> request
          {total === 1 ? "" : "s"} total
        </>
      )}
      {prototypeCount > 0 && (
        <>
          {" · "}
          <span className="font-medium text-warning">{prototypeCount} saved locally on this device only</span>
        </>
      )}
    </p>
  );
}
