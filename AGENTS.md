# Project implementation rules

- Keep request list search/filter/sort logic in a browser-safe pure module so both pages and automated tests use the same rules.
- Treat request read permission failures separately from empty results and availability failures; local prototype rows must always be scoped to the signed-in owner.
- Authorization helpers callable by authenticated users must bind checks to auth.uid(); keep anonymous execution revoked and preserve table RLS.
- Read optional feature-branch approval stages through the shared typed view of the existing browser client; generated schema files stay untouched and missing-table errors remain visible to callers.
- Request-list exports serialize only displayed RLS-loaded rows in displayed section/sort order; block exports on read errors and never fetch a hidden dataset or send files automatically.
- Requester alerts originate only from persisted database INSERT/status transitions; the private table is owner-scoped and the browser only reads or acknowledges alerts, preventing fabricated delivery and cross-user leakage.
- Poll private notifications with identity-scoped cancellation and no Realtime subscription; this preserves session isolation without adding publication or realtime policies.
- Tracking status checks use a browser-safe cancellable scheduler and identity-scoped request reads; polling avoids unapproved publication changes and never writes F11 alerts.
- Reviewer notifications use the existing browser client through a typed optional-table adapter, exact own reviewer/admin role reads plus AAL2, and recipient-scoped cancellation; dedicated F10 RLS enforces both server-side without changing shared helpers. SQL and recovery proposals stay outside migration runners until explicitly approved.