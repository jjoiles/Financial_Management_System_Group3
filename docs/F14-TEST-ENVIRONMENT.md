# F14: Dedicated Test Environment

## 1. Purpose

This guide explains how to run the Financial Request Management System in an isolated local testing environment.

The environment uses a Supabase managed local stack associated with the `feature/F14-test-environment` Git branch. It runs in Docker on the developer's computer and uses local test data rather than production financial records.

Do not use production credentials or the `--remote` option when following this guide.

## 2. Requirements

Install the following tools:

- Git
- Node.js and npm
- Docker Desktop
- Supabase CLI

Check the installed versions:

```bash
node --version
npm --version
npx supabase --version
docker --version
```

Start Docker Desktop before starting Supabase.

## 3. Get the project

Clone the repository and check out the F14 branch:

```bash
git clone https://github.com/jjoiles/Financial_Management_System_Group3.git
cd Financial_Management_System_Group3
git fetch origin
git checkout feature/F14-test-environment
git pull origin feature/F14-test-environment
npm install
```

## 4. Local Supabase configuration

The repository includes `supabase/config.toml`, which enables the Supabase CLI managed stack:

```toml
project_id = "vqccflhdudodyjxqjfoq"

[experimental]
stack = true
```

The repository also includes `supabase/supabase.lock` to keep the local service versions consistent.

Start the isolated local stack:

```bash
npx supabase stack start --eager
npx supabase stack list
npx supabase status
```

In the stack listing, confirm that the project is associated with the F14 branch. The Supabase CLI should identify the target as a local stack.

## 5. Configure local application credentials

Generate the local Supabase environment values:

```bash
npx supabase status --env --output-format text > /tmp/f14-supabase.env
set -a
source /tmp/f14-supabase.env
set +a
umask 077
cat > .env.local <<ENVVARS
SUPABASE_URL="$API_URL"
SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY"
SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
VITE_SUPABASE_URL="$API_URL"
VITE_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY"
ENVVARS
rm -f /tmp/f14-supabase.env
unset API_URL PUBLISHABLE_KEY SERVICE_ROLE_KEY
```

The `.env.local` file contains local development credentials. It is ignored by Git and must not be committed or shared.

Do not paste secret keys into source files, documentation, screenshots, or GitHub.

## 6. Apply and verify database migrations

Apply the repository migrations to the local database:

```bash
npx supabase migration up
npx supabase migration list
```

Confirm that the local and local database migration versions match.

The commands above use the local stack by default. Do not add `--remote`.

To confirm the database target, run:

```bash
npx supabase db query --read-only "SELECT current_database();"
```

The CLI output should identify the target as the local stack.

## 7. Verify the local API

Check the local Supabase Auth health endpoint using the API URL displayed by `npx supabase status`:

```bash
curl -i http://127.0.0.1:26361/auth/v1/health
```

The expected response is HTTP 200. The local API address and port can differ if the stack configuration changes; use the API URL reported by the CLI in that case.

## 8. Local test account

Use a local test account for application testing. Do not use a production account or real financial information.

For reviewer testing, the local test account can be assigned the reviewer role using the local database. Replace the example email with the email of the local test account:

```sql
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'reviewer'::public.app_role
FROM auth.users
WHERE email = 'your-local-test-account@example.com'
ON CONFLICT (user_id, role) DO NOTHING;
```

Run this SQL only against the local database.

## 9. Run the application

Start the application:

```bash
npm run dev
```

Open the local address printed by Vite in the terminal.

Sign in with the local test account. Use the local application to submit test requests and verify the dashboard, request details, reviewer decisions, and SLA tracking.

## 10. F14 verification performed

The following checks were completed in the local test environment:

- The managed Supabase stack started and ran locally.
- The application connected to the local Supabase API.
- All 11 repository migrations were applied and matched the local database migration history.
- The application dashboard and request pages loaded.
- A test request was submitted and routed to the Department Budget Reviewer stage.
- The initial SLA duration was verified as 72 hours.
- SLA dashboard states were checked for on-track, approaching-deadline, and overdue stages. Test timestamps were restored after those checks.
- An approval test completed successfully. The request and approval stage were marked approved and completed, and the workflow event and reviewer comment were saved.
- A rejection test completed successfully. The request and approval stage were marked rejected and completed, and the workflow event and reviewer comment were saved.
- The SLA dashboard showed the completed test stages.
- The SLA utility test suite passed: 8 tests.

The two decision-path test requests were local test records only:

| Test | Request | Result |
|---|---|---|
| Approval | FR-2026-OTQ1A6 | Approved |
| Rejection | FR-2026-ZUCIN0 | Rejected |

No actual funds were requested, approved, transferred, or spent.

## 11. Power Automate behavior

The local test environment did not have `POWER_AUTOMATE_FLOW_URL` configured. The application's workflow initialization therefore used simulated mode.

Local request creation, routing metadata, SLA tracking, and reviewer decision records were verified. This local test does not establish that an external Power Automate flow was called.

## 12. Stop and restart the local environment

To stop the managed local stack while preserving its local data:

```bash
npx supabase stack stop
```

To start it again:

```bash
npx supabase stack start --eager
```

Use the managed `stack` commands for this F14 environment.

## 13. Files and credentials

The following environment configuration and supporting files are part of the repository:

- `supabase/config.toml`
- `supabase/supabase.lock`
- `supabase/.gitignore`
- `docs/F14-TEST-ENVIRONMENT.md`

The following files or directories contain local configuration or runtime state and must not be committed:

- `.env.local`
- `supabase/.branches/`
- `supabase/.temp/`

## 14. Data safety guidelines

- Use only local test accounts and fictional test requests.
- Do not enter real financial information.
- Do not use production credentials in `.env.local`.
- Do not use `--remote` for F14 testing.
- Check the Supabase CLI target before running database commands.
- Keep local service-role keys private.
- Stop the local stack when testing is finished.

The purpose of F14 is to allow developers to test application changes without modifying production data.
