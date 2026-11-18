# F10 — Isolated testing setup and production gates

## Inspection results
- Current checkout: `feature/f10-reviewer-notifications`, commit `ecc1ea2`; working tree was clean before this planning task. PR #205 remains unmerged according to the user; its remote contents were not independently inspected.
- Lovable surfaces list shows **Main project only; no open drafts**. This project's preview and published app share the live database. The hosted backend responds normally.
- `docs/F14-TEST-ENVIRONMENT.md` documents a developer-computer local stack and past F14 checks. Configuration alone does not prove that stack still exists or is running. No Docker executable or socket was detected in this sandbox.
- No separate hosted staging target was identified in inspected configuration. Unlisted external projects or a developer's local environment cannot be ruled out.
- F10 SQL is review-only under `docs/f10/`; it has not been applied. Existing F12/F11 migrations are under `drizzle/migrations`; older baseline/F16 migrations are under `supabase/migrations`. Do not blindly replay both histories: the repository includes schemas not currently installed on live.

## Recommended environment: a Lovable test draft
A new Lovable draft normally gets a separate test database containing structure but no data. **Creation can fall back to the live database if test setup fails.** Therefore creating a draft is not sufficient proof of isolation.

A Git feature branch or ordinary preview is NOT database isolation. Do not change the main project's environment variables to point at staging.

### Approval scope
Approving this setup authorizes only:
- Creating one draft named **F10 isolated verification**, followed by an isolation check.
- Within that draft's independently confirmed test database only: F10 schema application, synthetic test requests, disposable test identities, protected test role assignments, TOTP enrollment, isolated failure/role-revocation tests, and recovery testing.
- Documentation and test corrections within the draft.

It does **not** authorize live-database SQL, production accounts/roles, production configuration, accepting the draft, merging PR #205, publishing, importing production records, or automatic production migration replay. If isolation or migration execution targeting cannot be verified, stop for another decision.

## Step-by-step setup

### 1. Create without starting database work
After approval, create the draft without an automatic implementation prompt. Inspect the creation result and surfaces list. Continue only if they explicitly identify its **own test database**; if they identify the live database, perform no writes and stop.

The draft starts from the main project's last saved version. Verify its source includes `ecc1ea2`'s F10 corrections and all three review SQL files before testing. Do not assume the draft Git branch is the PR branch or accept it back into main.

### 2. Verify the target inside the draft
Open the draft's own chat before any database action. Recheck that the current surface is the test draft and its backend is isolated, then inspect backend health and read-only schema/object inventories there. Database tools act on the current surface; main-thread tools must not be used to write draft data.

Record private target evidence without exposing keys or internal database addresses. Confirm no production request/user data was copied. Inspect current request RLS, role helpers, F11 trigger/policies/grants, function ownership, and migration history.

Keep external Power Automate/email/webhook calls disabled or pointed only to an approved test receiver **in the isolated environment**. Check inherited settings before submission; do not send synthetic tests to production integrations.

### 3. Establish the correct baseline
Use the test database's copied structure as the baseline, not a wholesale migration replay. Verify `financial_requests`, `user_roles`, `app_role`, F11 storage/trigger, `auth.uid()`/JWT behavior, UUID generation, and exact current request access definitions.

Resolve any missing baseline prerequisite in the draft only after reviewing its specific SQL. Do not import F16 merely to test F10: F10 does not require it. Audit historical migration journal timestamps/order before the migration tool applies pending files. Stop if the runner would replay unrelated changes.

### 4. Apply F10 to the test database only
From the confirmed draft chat, submit the reviewed contents of `docs/f10/reviewer-notifications.proposed.sql` through the approved migration tool. Keep SQL helpers before their policies, service sequence rights explicit, functions schema-qualified, and trigger last.

The migration tool applies immediately; it must never be called from this main/shared-database thread for this test. It regenerates draft schema types. Verify actual objects, indexes, ACLs, policies, trusted definer ownership, and AAL2 denial afterward. A successful tool message is not sufficient evidence.

The proposal uses plain CREATE statements; do not rerun against an already-installed F10 schema or hand-edit migration metadata to force it through.

### 5. Provision test identities only in the draft
Because a test draft starts without user data, create five distinct disposable app-owned test users: requester, reviewer A, reviewer B, admin, and leadership-only. Use the approved draft auth test-user tooling where available, otherwise the app's signup/confirmation flow. Do not use or clone production credentials.

Assign exact roles through protected `user_roles` records in the draft only, after confirming the target. Never put roles in editable metadata/profiles or use the UI role switch as authorization. Provisioning is privileged setup, not a new self-service privilege escalation path.

For real browser checks, use identities that remain available throughout the verification; tool-created temporary users may be removed at turn end. If persistent fixture accounts are needed, obtain approval for that isolated provisioning method and later cleanup.

Enroll an authenticator and verify it through the app to obtain a real AAL2 session. Keep TOTP secrets, passwords, cookies and tokens private. Minted test sessions may be AAL1 and are not proof of MFA. A real AAL1 session must also be tested against the Data API, not just UI controls.

## Verification matrix

### Application checks (no database mutation needed)
Rerun all unit tests and platform TypeScript/build checks. Baseline: 253/253 application tests; database tests remain unexecuted so far.

### Isolated SQL checks
Run `docs/f10/database-verification.proposed.sql` only after auditing it in the draft. It needs privileged isolated role-switch/DDL setup and five existing fixture IDs. It deliberately removes role rows and injects failures inside rollback scopes; ROLLBACK does not make it safe for production and does not rewind identity sequences.

Verify:
- Exact reviewer/admin roles versus requester, leadership-only and anonymous access.
- AAL1/missing claims denied; real AAL2 allowed; admin outcomes/retry similarly gated.
- Owner-only read/read_at update; cross-recipient denial; no browser INSERT/DELETE or recipient changes.
- Trusted definer owners, inherited/default grants, sequence permissions, and no public internal-helper execution.
- Submission trigger, no-op updates, repeated legitimate review transitions, unique event/recipient constraints.
- Old failed/unassigned events superseded, terminal events inactive, delivered events immutable.
- No reviewers: saved request, unassigned event, no invented recipients.
- Failed alert insert: request and F11 remain persisted; scoped admin retry recovers after fault removal.
- Role revocation immediately denies subsequent database reads/writes even if leadership remains.
- F11 submission/status rows and permissions unchanged.

If draft tools cannot execute SET ROLE/DDL/update assertions with authorized isolated privileges, report those tests blocked. Do not elevate the shared database. A locally controlled database may be required for privileged integration tests.

### Additional tests not covered by the one-session script
- Two-session concurrency: hold the request lock while creating a newer transition; concurrently retry the older event and confirm superseded/no duplicate old alerts.
- Inject event-storage failure, not only notification-insert failure; inspect warnings and request/F11 outcomes.
- Test revoked reviewer plus retained leadership on the same identity, actual unauthorized API writes, and restricted service/internal RPC access.
- Exercise reviewed non-destructive disablement/recovery and verify missed-interval requests are not silently backfilled.
- Measure fan-out/locks/latency using synthetic test records.

### Live browser flow on the TEST app only
Requester submits a synthetic request → backend persistence confirmed → reviewer A receives one alert → reviewer B cannot read A's alert → AAL2 reviewer opens authorized secure link and toggles read/unread → unauthorized identities/AAL1 token fail → subsequent status transition updates F9 and creates F11/F10 alerts as appropriate. Confirm no local prototype fallback was used, no external delivery occurred, and F12 filters/F23 visible CSV remain correct. Repeat desktop/mobile and sign-out/identity change checks.

“Live reviewer testing” here means actual auth/database interaction in the test app, not the published production app. F10 uses polling, so allow up to 30 seconds plus request/network time rather than claiming immediate delivery.

## Alternative when a test draft is unavailable
Use the documented F14 developer-computer local stack, or a separate user-owned hosted database with separately approved cost/resources. No local stack was started and its current CLI commands have not been verified here.

- Work in a separate checkout at `ecc1ea2`, not the main Lovable preview; use isolated local configuration and credentials only in that checkout.
- Verify the CLI's supported local startup commands and target before any SQL; never use a remote production target.
- Reconstruct a reviewed baseline including F11 from both historical sources without blindly replaying conflicting migrations. A local baseline richer than production can mask compatibility failures, so record differences.
- Apply F10 locally and run the same identity/MFA/RLS/concurrency suite.
- External/local database mutation is not available through this project's main Cloud migration tool; agree on execution access/tooling before proceeding.

A remix is another structure-only project option, not a data clone; isolation and correct F10 source revision would still need verification. Production data export is unnecessary for synthetic F10 testing and is not part of this approval.

## Production deployment: separate approvals and recovery gates
**No production action is included in this setup approval.** After isolated tests pass:
1. Review test evidence, unresolved risks, exact production SQL/diff, pending migration history, and known global reviewer/admin request-access dependency.
2. Identify actual authorized production reviewers/admins through a separately approved provisioning decision; test identities and their credentials must not migrate from the draft.
3. Verify backup evidence with the user in **More → Database → Manage → Backups**, reading the newest UTC timestamp. No tool here verifies backup inventory. Cloud provides daily database snapshots retained up to roughly 14 days, not PITR. Both schema and data are covered, storage files are not.
4. Before the change, preserve current database state using **More → Database → Manage → Settings → Export data → Database → Export → Start export**. Limits: one export/24 hours, database up to 15 GB, export up to 5 GB; backend must be running. The export contains accounts/password hashes: secure it. It excludes storage files, secrets, provider settings and function code. Storage files require separate download from **More → Storage**. No full dump scripts are proposed.
5. Prefer `docs/f10/disablement-recovery.proposed.sql`'s reviewed non-destructive F10 stop procedure: disable only F10 generation/retry, retain requests/roles/F11 and history. Approve it separately; even this requires locks and permission changes.
6. A full daily-snapshot restore is a last resort: it restores the same database in place, causes several minutes of unavailability, permanently loses writes after the snapshot, and reverts schema as well as data. It is not a reversible/per-table rollback. Export first; retest application/schema compatibility afterward.
7. Obtain explicit approval for production migration/permissions, any production role provisioning, deployment/publishing, and PR #205 merge as separate scoped actions. Do not accept a backend draft merely to test it: acceptance may propagate changes and is outside this plan.
8. Apply only the reviewed production change during an agreed window; validate policies/ownership, real AAL2 reviewer flow, F11/F9 regressions, exports, warnings and latency. Do not copy test identities, fixture role edits, failure-injection SQL or test records.

## Completion and blockers
Deliver an updated F10 report with target-isolation evidence, actual database/browser results, migration identifiers, ACL/owner findings and unexecuted cases. Keep PR #205 unmerged until separately approved.

Current blockers: no test draft yet; isolated runtime privilege capabilities not verified; no isolated reviewer identities or AAL2 sessions yet; no backup timestamp evidence; no production enablement approval. Approval of this plan starts isolated setup only, with a mandatory stop if the draft uses live data.
