/**
 * One-line summary of how many requests match the current search/filter.
 */
export default function RequestCountSummary({
  matching,
  total,
  isFiltered,
}: {
  matching: number;
  total: number;
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
    </p>
  );
}
