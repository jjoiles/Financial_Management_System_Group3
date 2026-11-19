-- ============================================================
-- F19.5.4.1: SECURITY HARDENING (S1, S2, S3)
-- ============================================================
--
-- Findings from the F19.5.4 historical workflow and security audit.
-- Design and verification: docs/F19_Security_Hardening.md.
--
-- S1  financial_requests.created_at becomes database-controlled and immutable.
--     - f19_assign_request_created_at (BEFORE INSERT) sorts before every other
--       BEFORE trigger on the table and sets created_at to now(), the column
--       default, so F4 derives request_number and the fiscal metadata from the
--       authoritative value. A client-supplied value is replaced, never kept.
--     - zz_f19_guard_request_created_at (BEFORE INSERT OR UPDATE) sorts after
--       every trigger that modifies the row (only zz_f19_guard_request_status,
--       which does not touch created_at, follows it) and checks the final row:
--       on INSERT created_at must equal now(); on UPDATE it must be unchanged.
--     - Applies to every role, every request status and every write path,
--       including the table owner and the SECURITY DEFINER workflow functions.
--       There is no session setting or other bypass.
--     - Existing rows are not touched: no historical timestamp is rewritten.
--     - Exceptional corrections are NOT part of the application. They require
--       a separate, reviewed and auditable process run by the table owner (a
--       dedicated migration that records the old and new values and the
--       reason, and disables and re-enables the guard in the same
--       transaction). Workflow events are never used to correct timestamps.
--
-- S2  TRUNCATE, TRIGGER, REFERENCES and (PostgreSQL 17+) MAINTAIN are revoked
--     from anon and authenticated on the five F19 tables. RLS never applies to
--     TRUNCATE, and no application path needs any of these privileges.
--
-- S3  Direct INSERT, UPDATE and DELETE are revoked from anon on the five F19
--     tables (anon has no write policy on any of them). authenticated keeps
--     exactly the DML commands that have an RLS policy and an application
--     path:
--       financial_requests  INSERT (submission), UPDATE (owner edits while
--                           submitted, routing write during initialization,
--                           reviewer/admin updates)
--       workflow_events     INSERT (the existing owner and reviewer policies)
--     DELETE on financial_requests and UPDATE/DELETE on workflow_events have
--     no policy, so they are revoked. Stage, amendment and initialization-state
--     writes already go only through SECURITY DEFINER functions.
--     SELECT is unchanged for every role. service_role is unchanged.
--
-- Default privileges: the grants came from the default ACL of role postgres
-- in schema public, which gave anon and authenticated every table privilege
-- on new tables. Only that scope is corrected, so future tables created by
-- postgres in public no longer receive TRUNCATE, TRIGGER, REFERENCES or
-- MAINTAIN for anon and authenticated, or INSERT, UPDATE or DELETE for anon.
-- New tables still receive SELECT for both roles and SELECT, INSERT, UPDATE
-- and DELETE for authenticated (governed by RLS); any other privilege must be
-- granted explicitly by the migration that creates the table. The defaults of
-- other roles (for example supabase_admin) and other schemas are unchanged.
--
-- Not changed here (separate design review): S4, the trust that
-- f19_guard_request_workflow_fields places in the app.f19_* session settings.
-- ============================================================

-- ------------------------------------------------------------
-- S1: authoritative, immutable created_at
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.f19_assign_request_created_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	-- The authoritative creation time is the inserting transaction's start
	-- time, the same value as the column default.
	NEW.created_at := pg_catalog.now();
	RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.f19_guard_request_created_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.created_at IS DISTINCT FROM pg_catalog.now() THEN
			RAISE EXCEPTION USING
				ERRCODE = 'check_violation',
				MESSAGE = 'financial_requests.created_at is assigned by the database on insert.';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION USING
			ERRCODE = 'check_violation',
			MESSAGE = 'financial_requests.created_at cannot be changed.',
			HINT = 'Exceptional corrections require a separate, reviewed and auditable process run by the table owner.';
	END IF;

	RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.f19_assign_request_created_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.f19_guard_request_created_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS f19_assign_request_created_at ON public.financial_requests;
CREATE TRIGGER f19_assign_request_created_at
BEFORE INSERT ON public.financial_requests
FOR EACH ROW
EXECUTE FUNCTION public.f19_assign_request_created_at();

DROP TRIGGER IF EXISTS zz_f19_guard_request_created_at ON public.financial_requests;
CREATE TRIGGER zz_f19_guard_request_created_at
BEFORE INSERT OR UPDATE ON public.financial_requests
FOR EACH ROW
EXECUTE FUNCTION public.f19_guard_request_created_at();

-- ------------------------------------------------------------
-- S2: privileges RLS cannot govern
-- ------------------------------------------------------------

REVOKE TRUNCATE, TRIGGER, REFERENCES
ON TABLE
	public.financial_requests,
	public.approval_stage_tracking,
	public.workflow_events,
	public.request_workflow_amendments,
	public.workflow_initialization_state
FROM anon, authenticated;

-- ------------------------------------------------------------
-- S3: direct writes without a policy or an application path
-- ------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE
ON TABLE
	public.financial_requests,
	public.approval_stage_tracking,
	public.workflow_events,
	public.request_workflow_amendments,
	public.workflow_initialization_state
FROM anon;

REVOKE DELETE ON TABLE public.financial_requests FROM authenticated;
REVOKE UPDATE, DELETE ON TABLE public.workflow_events FROM authenticated;

-- ------------------------------------------------------------
-- Default privileges for future tables (role postgres, schema public only)
-- ------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
	REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
	REVOKE INSERT, UPDATE, DELETE ON TABLES FROM anon;

-- MAINTAIN exists from PostgreSQL 17; earlier servers have nothing to revoke.
DO $$
BEGIN
	IF pg_catalog.current_setting('server_version_num')::INTEGER >= 170000 THEN
		EXECUTE 'REVOKE MAINTAIN ON TABLE
			public.financial_requests,
			public.approval_stage_tracking,
			public.workflow_events,
			public.request_workflow_amendments,
			public.workflow_initialization_state
		FROM anon, authenticated';
		EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
			REVOKE MAINTAIN ON TABLES FROM anon, authenticated';
	END IF;
END;
$$;
