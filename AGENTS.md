# Project implementation rules

- Keep request list search/filter/sort logic in a browser-safe pure module so both pages and automated tests use the same rules.
- Treat request read permission failures separately from empty results and availability failures; local prototype rows must always be scoped to the signed-in owner.
- Authorization helpers callable by authenticated users must bind checks to auth.uid(); keep anonymous execution revoked and preserve table RLS.
- Read optional feature-branch approval stages through the shared typed view of the existing browser client; generated schema files stay untouched and missing-table errors remain visible to callers.