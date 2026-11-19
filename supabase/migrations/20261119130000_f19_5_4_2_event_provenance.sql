-- ============================================================
-- F19.5.4.2: WORKFLOW EVENT PROVENANCE + DEFAULT DELETE PRIVILEGE
-- ============================================================
--
-- Follows 20261119120100_f19_5_4_1_security_hardening.sql.
-- Design and verification: docs/F19_Security_Hardening.md.
--
-- 1. Workflow event provenance
--
--    Every database-generated workflow event is written inside a SECURITY
--    DEFINER function owned by the table owner (postgres):
--      f5_log_financial_request      request_created, status_changed,
--                                    routing_changed, request_updated
--                                    (source db_trigger)
--      f5_log_request_attachment     attachment_added, attachment_removed
--                                    (source db_trigger)
--      f6_add_link                   record_linked (source db_trigger)
--      f16_record_approval_decision  approval_approved, approval_rejected
--                                    (no source key)
--      f19_complete_workflow_initialization
--                                    workflow_initialized, workflow_failed
--                                    (source f19_workflow_initialization)
--      f19_amend_request_workflow    request_amended
--                                    (source f19_amend_request_workflow)
--    No application code inserts workflow events directly. The RLS INSERT
--    policies nevertheless let a requester (for an own request) and an admin,
--    reviewer or leadership user (for any request) insert any event_type,
--    metadata (including "source": "db_trigger"), created_at and, for the
--    reviewer policy, any actor_user_id.
--
--    f19_guard_workflow_event_provenance (BEFORE INSERT, SECURITY INVOKER)
--    uses the trust anchor of zz_f19_guard_request_status: an insert is
--    database-generated only when current_user is the table owner, read from
--    pg_class. That holds inside the SECURITY DEFINER functions above and is
--    never true for anon, authenticated or service_role. Session settings are
--    not consulted. For every other caller the event is a client event:
--      - a reserved (database-generated) event_type is rejected;
--      - metadata must be a JSON object, and a "source" other than "client"
--        is rejected; the stored event always has "source": "client";
--      - actor_user_id must be empty or auth.uid(), and is set to auth.uid();
--      - created_at is set to now().
--    Owner-context inserts are not changed, so every workflow RPC and trigger
--    behaves exactly as before. The existing policies, which still decide who
--    may append an event to which request, are unchanged.
--
--    Existing events are not modified. Events stored before this migration
--    cannot be shown to be database-generated.
--
--    RESERVED_EVENT_TYPES must list every event_type a database function
--    writes; src/lib/workflow/event-provenance-migration.test.ts checks this
--    against the whole migration history.
--
-- 2. Default DELETE privilege
--
--    No application path deletes rows from a future table (the only
--    application DELETE target, request_attachments, is an existing table
--    and keeps its grant). Future tables created by postgres in schema public
--    therefore no longer grant DELETE to authenticated; a table that needs it
--    must grant it explicitly. No other role or schema changes.
--
-- Not changed here (separate design review): S4, the trust that
-- f19_guard_request_workflow_fields places in the app.f19_* session settings.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Workflow event provenance
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.f19_guard_workflow_event_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	-- Every event_type written by a database function (see the header).
	reserved_event_types CONSTANT TEXT[] := ARRAY[
		'request_created',
		'status_changed',
		'routing_changed',
		'request_updated',
		'attachment_added',
		'attachment_removed',
		'record_linked',
		'approval_approved',
		'approval_rejected',
		'workflow_initialized',
		'workflow_failed',
		'request_amended'
	];
	trusted BOOLEAN;
	caller UUID;
BEGIN
	-- Database-generated only when executing as the table owner: inside the
	-- SECURITY DEFINER workflow functions and triggers.
	SELECT pg_catalog.pg_get_userbyid(c.relowner) = current_user
	INTO trusted
	FROM pg_catalog.pg_class c
	WHERE c.oid = TG_RELID;

	IF COALESCE(trusted, FALSE) THEN
		RETURN NEW;
	END IF;

	IF NEW.event_type = ANY (reserved_event_types) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'insufficient_privilege',
			MESSAGE = pg_catalog.format(
				'Workflow event type %s is reserved for database-generated events.',
				NEW.event_type
			);
	END IF;

	IF NEW.metadata IS NULL OR pg_catalog.jsonb_typeof(NEW.metadata) <> 'object' THEN
		RAISE EXCEPTION USING
			ERRCODE = 'check_violation',
			MESSAGE = 'Workflow event metadata must be a JSON object.';
	END IF;

	IF NEW.metadata ? 'source' AND (NEW.metadata ->> 'source') IS DISTINCT FROM 'client' THEN
		RAISE EXCEPTION USING
			ERRCODE = 'insufficient_privilege',
			MESSAGE = pg_catalog.format(
				'Workflow event source %s is reserved for database-generated events.',
				NEW.metadata ->> 'source'
			);
	END IF;

	caller := auth.uid();
	IF NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id IS DISTINCT FROM caller THEN
		RAISE EXCEPTION USING
			ERRCODE = 'insufficient_privilege',
			MESSAGE = 'A client workflow event can only be attributed to the signed-in user.';
	END IF;

	NEW.actor_user_id := caller;
	NEW.created_at := pg_catalog.now();
	NEW.metadata := NEW.metadata || pg_catalog.jsonb_build_object('source', 'client');
	RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.f19_guard_workflow_event_provenance() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS f19_guard_workflow_event_provenance ON public.workflow_events;
CREATE TRIGGER f19_guard_workflow_event_provenance
BEFORE INSERT ON public.workflow_events
FOR EACH ROW
EXECUTE FUNCTION public.f19_guard_workflow_event_provenance();

-- ------------------------------------------------------------
-- 2. Default DELETE privilege for future tables (role postgres, schema public)
-- ------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
	REVOKE DELETE ON TABLES FROM authenticated;
