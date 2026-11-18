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

# Issue #11 — F11

- [x] Add persisted, owner-only status notifications; preserve request authorization and F12/F23.
- [x] Replace sample bell notifications with private updates and safe request links.
- [x] Add focused service tests and rollback-only database integration assertions.
- [x] Verify existing Requester submission/alert/link/read flow, automatic checks, and documentation; commit on the F11 branch.
- [ ] Execute full database UPDATE/failure-injection integration suite — blocked by sandbox UPDATE/ALTER/SET ROLE privileges; do not elevate.

# Issue #9 — F9

- [x] Inspect status persistence, access, F11, F12, F23, and live-update publication availability.
- [x] Add identity-scoped automatic tracking checks without database changes; user approved the polling alternative.
- [x] Test status refresh, cleanup, errors, reconnection, authorization, and preserved list behavior.
- [x] Verify preview and automatic checks; document limitations and commit on the F9 branch without merging.

# Issue #10 — F10

- [x] Complete code-only exact-role/AAL2 remediation, stale-event handling, expanded review-only SQL tests, and non-destructive recovery documentation.
- [x] Run the full suite and automatic checks; update the F10 report and commit without applying SQL or merging PR #205.

- [x] Inspect submission, routing, F11 notifications, request access, and hosted reviewer availability.
- [x] Obtain approval for application code/tests and unapplied SQL preparation only.
- [x] Implement reviewer alert application code, secure links, read/unread states, and unavailable-table handling; prepare generation/RLS SQL outside executable migration folders.
- [x] Run focused and full automated tests and inspect automatic checks; do not execute database integration changes.
- [x] Write the F10 verification report and commit on the current feature branch without merging.
- [ ] Enable persisted reviewer delivery — blocked pending separate explicit approval to apply reviewed SQL.
- [ ] Verify real signed-in reviewer delivery/read/link/privacy — blocked by unapplied schema and no existing authorized reviewer; requester session unavailable this turn.

Blockers: no reviewer/admin role records or named reviewer assignments exist; the hosted database is shared with production. Database SQL must remain unapplied pending separate explicit approval. No accounts, role assignments, existing records, permissions, or production configuration may change.