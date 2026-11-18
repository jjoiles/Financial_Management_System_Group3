# Issue #12 — F12

- [x] Add composed request search, filtering, and sorting with tests.
- [x] Repair restricted authorization helper execution without widening row access.
- [x] Distinguish access failures from empty lists; preserve owned prototype requests.
- [x] Verify tests, preview, automatic TypeScript and production checks; commit on the feature branch.
- [x] Verify using the existing Requester session only; do not create accounts or elevate access.

Verification limits: the existing Requester session returns no backend requests; populated-list ordering is covered by automated fixtures rather than elevated-access browser tests. Optional F16 approval-stage tables are not installed on this backend and remain outside F12.

# Issue #23 — F23

- [x] Add a guarded CSV download of the visible F12 request results, preserving displayed section/sort order.
- [x] Provide explicit manual-sharing feedback without sending data or simulating delivery.
- [x] Test CSV escaping, ordering, empty results, access denial, and downloads; verify automatic checks.
- [x] Document changed files and limitations; commit on the current feature branch without merging.