# Project implementation rules

- Keep request list search/filter/sort logic in a browser-safe pure module so both pages and automated tests use the same rules.
- Treat request read permission failures separately from empty results and availability failures; local prototype rows must always be scoped to the signed-in owner.
- Authorization helpers callable by authenticated users must bind checks to auth.uid(); keep anonymous execution revoked and preserve table RLS.