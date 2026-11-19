-- F19.5.2: independent SQL verification of the eight F19 catalog metrics
-- against the records already stored in the local database.
--
-- READ-ONLY. Nothing is inserted, updated, deleted, truncated or created.
-- No temporary tables, views or functions; every calculation is a CTE.
-- The session default and the transaction are both forced read-only, the
-- script aborts unless both are on, and it ends with ROLLBACK.
--
-- Run (local stack only):
--   docker exec -i <local-db-container> psql -U postgres -d postgres -X \
--     -v ON_ERROR_STOP=1 < verification/f19_5_2_metric_verification.sql
--
-- Reporting period (half-open, start <= t < end_exclusive), overridable:
--   -v period_start=2026-11-01T00:00:00Z -v period_end_exclusive=2026-12-01T00:00:00Z
-- Default: calendar month November 2026, UTC boundaries (the F18 calendar
-- month convention, docs/F19_Efficiency_Metrics.md section 3.2). The session
-- time zone is set to UTC so timestamps serialise as the browser sees them.
-- The F19.5.1 audit comparison applies only to the default period; for any
-- other period, period-dependent rows report "n/a (non-audit period)".
--
-- Independence rules followed here:
-- - No F19.4 TypeScript and no F19 database helper function is called
--   (in particular not f19_is_valid_queue_id). Expected values come only
--   from SQL over public.financial_requests and public.approval_stage_tracking.
-- - Recognized queue IDs are the literal QUEUES keys of
--   src/lib/routing/rules.ts, in QUEUES order.
-- - Each population is classified by ONE ordered CASE expression that
--   follows the catalog condition order, so the first failed condition is
--   the record's only exclusion code.
-- - Exclusion and flag counts cover the whole dataset (DATA_QUALITY_RULES 5);
--   the reporting period is applied only to included records, afterwards.
-- - The decisive stage is the highest (workflow_revision, stage_order) over
--   every revision, compared as integers; no fallback to an earlier stage.
-- - no-data (empty statistic) is printed as "no-data", never 0.
--
-- JavaScript precision: the browser parses timestamps to whole milliseconds,
-- truncating extra digits (V8). Every instant is therefore compared and
-- subtracted as floor(epoch * 1000) integer milliseconds, which reproduces
-- the TypeScript values exactly. A microsecond-precision duration is shown
-- beside each duration statistic for transparency.
--
-- A "valid instant" mirrors toValidInstant (src/lib/time-zones.ts) applied
-- to Postgres JSON output in a UTC session: finite (not +/-infinity), year
-- 0001-9999 AD. infinity, BC dates and 5-digit years are accepted by
-- timestamptz but rejected by the ISO-8601 pattern the browser applies.

\set ON_ERROR_STOP on
\pset pager off
\pset null '(null)'

\if :{?period_start}
\else
  \set period_start '2026-11-01T00:00:00Z'
\endif
\if :{?period_end_exclusive}
\else
  \set period_end_exclusive '2026-12-01T00:00:00Z'
\endif

-- ------------------------------------------------------------
-- 0. Read-only enforcement
-- ------------------------------------------------------------

SET default_transaction_read_only = on;
-- One snapshot for every statement below.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL timezone = 'UTC';

DO $$
BEGIN
  IF current_setting('default_transaction_read_only') <> 'on'
     OR current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'F19.5.2 must run in a read-only transaction.';
  END IF;
END;
$$;

SELECT (:'period_end_exclusive'::timestamptz > :'period_start'::timestamptz) AS period_ok \gset
\if :period_ok
\else
  \echo 'ERROR: period_end_exclusive must be later than period_start.'
  ROLLBACK;
  \quit
\endif

\echo
\echo '== 0. Session and reporting period =='
SELECT current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('default_transaction_read_only') AS default_transaction_read_only,
       current_setting('TimeZone') AS session_time_zone,
       :'period_start'::timestamptz AS period_start_utc,
       :'period_end_exclusive'::timestamptz AS period_end_exclusive_utc,
       'half-open: start <= t < end_exclusive' AS period_rule,
       (SELECT max(version) FROM supabase_migrations.schema_migrations) AS latest_applied_migration;

-- ------------------------------------------------------------
-- 1. Schema confirmation (source columns of SOURCE_FIELDS)
-- ------------------------------------------------------------

DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(e.tbl || '.' || e.col || ' ' || e.typ, ', ')
  INTO missing
  FROM (VALUES
    ('financial_requests', 'id', 'uuid'),
    ('financial_requests', 'status', 'request_status'),
    ('financial_requests', 'created_at', 'timestamptz'),
    ('approval_stage_tracking', 'id', 'uuid'),
    ('approval_stage_tracking', 'request_id', 'uuid'),
    ('approval_stage_tracking', 'workflow_revision', 'int4'),
    ('approval_stage_tracking', 'stage_order', 'int4'),
    ('approval_stage_tracking', 'queue_id', 'text'),
    ('approval_stage_tracking', 'status', 'text'),
    ('approval_stage_tracking', 'started_at', 'timestamptz'),
    ('approval_stage_tracking', 'completed_at', 'timestamptz')
  ) AS e(tbl, col, typ)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = e.tbl AND a.attname = e.col
      AND NOT a.attisdropped AND a.atttypid::regtype::text IN (e.typ, CASE e.typ
        WHEN 'timestamptz' THEN 'timestamp with time zone'
        WHEN 'int4' THEN 'integer'
        WHEN 'request_status' THEN 'public.request_status' END)
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Source columns missing or retyped: %', missing;
  END IF;
END;
$$;

\echo
\echo '== 1. Schema confirmation: source columns and their nullability =='
SELECT c.relname AS table_name, a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND ((c.relname = 'financial_requests' AND a.attname IN ('id', 'status', 'created_at'))
    OR (c.relname = 'approval_stage_tracking' AND a.attname IN (
      'id', 'request_id', 'workflow_revision', 'stage_order', 'queue_id',
      'status', 'started_at', 'completed_at')))
  AND NOT a.attisdropped
ORDER BY c.relname DESC, a.attnum;

\echo
\echo '== 1b. Constraints that decide which exclusions are structurally possible =='
SELECT conrelid::regclass AS table_name, conname AS constraint_name,
       convalidated AS validated, pg_get_constraintdef(oid) AS definition
FROM pg_catalog.pg_constraint
WHERE conrelid = 'public.approval_stage_tracking'::regclass AND contype IN ('c', 'u', 'f')
UNION ALL
SELECT i.indrelid::regclass, c.relname, i.indisvalid, pg_get_indexdef(i.indexrelid)
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = 'public.approval_stage_tracking'::regclass
  AND c.relname = 'approval_stage_tracking_single_active_per_request'
ORDER BY 2;

\echo
\echo '== 1c. Dataset distributions =='
SELECT 'financial_requests' AS table_name, status::text AS status, count(*) AS records
FROM public.financial_requests GROUP BY status
UNION ALL
SELECT 'approval_stage_tracking', status || ' / ' || queue_id || ' / rev ' || workflow_revision, count(*)
FROM public.approval_stage_tracking GROUP BY status, queue_id, workflow_revision
ORDER BY 1 DESC, 2;

-- ------------------------------------------------------------
-- 2-8. Metric verification (one statement, shared CTEs)
-- ------------------------------------------------------------

\echo
\echo '== 2-8. Expected metric results, exclusion and flag counts, audit comparison =='
\echo '   expected: value derived here. audit: F19.5.1 figure. observability (exclusion rows):'
\echo '   observed | absent: possible | absent: blocked by trigger | impossible: validated constraint'

WITH
params AS (
  SELECT p_start, p_end,
         floor(extract(epoch FROM p_start) * 1000)::bigint AS p_start_ms,
         floor(extract(epoch FROM p_end) * 1000)::bigint AS p_end_ms,
         (p_start = timestamptz '2026-11-01T00:00:00Z'
          AND p_end = timestamptz '2026-12-01T00:00:00Z') AS audit_period
  FROM (SELECT :'period_start'::timestamptz AS p_start,
               :'period_end_exclusive'::timestamptz AS p_end) AS p
),
-- Literal QUEUES keys, src/lib/routing/rules.ts, in QUEUES order.
recognized_queues(queue_id, queue_ord) AS (
  VALUES ('department_budget', 1), ('research_admin', 2), ('provost_finance', 3),
         ('sponsored_programs', 4), ('dean_office', 5), ('cfo_office', 6)
),
-- Requests. Prototypes are browser-only and never stored, so none is here.
req AS (
  SELECT r.id, r.status::text AS status, r.created_at, v.created_valid,
         CASE WHEN v.created_valid
              THEN floor(extract(epoch FROM r.created_at) * 1000)::bigint END AS created_ms,
         FALSE AS is_prototype
  FROM public.financial_requests r
  CROSS JOIN LATERAL (SELECT COALESCE(isfinite(r.created_at)
      AND r.created_at >= timestamptz '0001-01-01T00:00:00Z'
      AND r.created_at < timestamptz '10000-01-01T00:00:00Z', FALSE) AS created_valid) AS v
),
-- Stages with their request's status (NULL when the request is not stored).
stg AS (
  SELECT s.id, s.request_id, s.workflow_revision, s.stage_order, s.queue_id, s.status,
         s.started_at, s.completed_at, v.started_valid, v.completed_valid,
         CASE WHEN v.started_valid
              THEN floor(extract(epoch FROM s.started_at) * 1000)::bigint END AS started_ms,
         CASE WHEN v.completed_valid
              THEN floor(extract(epoch FROM s.completed_at) * 1000)::bigint END AS completed_ms,
         EXISTS (SELECT 1 FROM recognized_queues q WHERE q.queue_id = s.queue_id) AS queue_recognized,
         r.status AS request_status,
         COALESCE(r.status IN ('submitted', 'under_review'), FALSE) AS request_pending
  FROM public.approval_stage_tracking s
  LEFT JOIN req r ON r.id = s.request_id
  CROSS JOIN LATERAL (SELECT
      COALESCE(isfinite(s.started_at)
        AND s.started_at >= timestamptz '0001-01-01T00:00:00Z'
        AND s.started_at < timestamptz '10000-01-01T00:00:00Z', FALSE) AS started_valid,
      COALESCE(isfinite(s.completed_at)
        AND s.completed_at >= timestamptz '0001-01-01T00:00:00Z'
        AND s.completed_at < timestamptz '10000-01-01T00:00:00Z', FALSE) AS completed_valid) AS v
),
-- Constraint facts read from the catalog (not from F19 helper functions).
structural AS (
  SELECT
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.approval_stage_tracking'::regclass
            AND conname = 'approval_stage_tracking_status_check' AND convalidated) AS status_check,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.approval_stage_tracking'::regclass
            AND conname = 'approval_stage_tracking_status_completed_check' AND convalidated) AS status_completed_check,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.approval_stage_tracking'::regclass
            AND conname = 'approval_stage_tracking_queue_allowlist_check' AND convalidated) AS queue_allowlist,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.approval_stage_tracking'::regclass
            AND conname = 'approval_stage_tracking_request_revision_stage_unique' AND convalidated) AS key_unique,
    EXISTS (SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
            WHERE c.relname = 'approval_stage_tracking_single_active_per_request'
              AND i.indisunique AND i.indisvalid) AS single_active,
    (SELECT bool_and(attnotnull) FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.approval_stage_tracking'::regclass
       AND attname IN ('status', 'workflow_revision', 'stage_order')) AS keys_not_null
),

-- ---------- 2. request_volume ----------
-- Scope: every request. Conditions: 1 prototype_request, 2 invalid_created_at.
rv_class AS (
  SELECT r.*, CASE
      WHEN r.is_prototype THEN 'prototype_request'
      WHEN NOT r.created_valid THEN 'invalid_created_at'
    END AS exclusion
  FROM req r
),

-- ---------- 3. active_queue_workload ----------
-- Scope: stages with status 'active'. Condition: 1 orphaned_active_stage.
aqw_class AS (
  SELECT s.*, CASE WHEN NOT s.request_pending THEN 'orphaned_active_stage' END AS exclusion
  FROM stg s WHERE s.status = 'active'
),
aqw_included AS (SELECT * FROM aqw_class WHERE exclusion IS NULL),
-- Separate report. Scope: pending requests with no stage of any status.
-- Condition: 1 prototype_request.
pws_class AS (
  SELECT r.*, CASE WHEN r.is_prototype THEN 'prototype_request' END AS exclusion
  FROM req r
  WHERE r.status IN ('submitted', 'under_review')
    AND NOT EXISTS (SELECT 1 FROM public.approval_stage_tracking s WHERE s.request_id = r.id)
),

-- ---------- 4. stage_processing_time_{average,median} ----------
-- Scope: every stage. Conditions in catalog order.
spt_class AS (
  SELECT s.*, CASE
      WHEN s.status = 'active' AND NOT s.request_pending THEN 'orphaned_active_stage'
      WHEN s.status = 'active' THEN 'in_progress_stage'
      WHEN s.status IN ('skipped', 'cancelled') THEN 'skipped_or_cancelled_stage'
      WHEN s.status IS NULL OR s.status NOT IN ('active', 'completed', 'skipped', 'cancelled')
        THEN 'unrecognized_stage_status'
      WHEN s.status = 'completed' AND s.completed_at IS NULL THEN 'stage_missing_completed_at'
      WHEN NOT COALESCE(s.started_valid AND s.completed_valid AND s.completed_ms >= s.started_ms, FALSE)
        THEN 'invalid_stage_timestamps'
    END AS exclusion
  FROM stg s
),
spt_period AS (
  SELECT s.*,
         (s.completed_ms - s.started_ms) / 3600000.0 AS hours_ms,
         extract(epoch FROM s.completed_at - s.started_at) / 3600 AS hours_us
  FROM spt_class s, params p
  WHERE s.exclusion IS NULL AND s.completed_ms >= p.p_start_ms AND s.completed_ms < p.p_end_ms
),
spt_groups AS (
  -- 'overall' pools every included stage, unknown-queue stages too.
  SELECT 'overall' AS grp, 0 AS grp_ord, TRUE AS always_shown,
         count(*) AS n, avg(hours_ms) AS avg_ms, percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_ms) AS med_ms,
         avg(hours_us) AS avg_us, percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_us) AS med_us
  FROM spt_period
  UNION ALL
  SELECT q.queue_id, q.queue_ord, TRUE, count(s.id), avg(s.hours_ms),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY s.hours_ms),
         avg(s.hours_us), percentile_cont(0.5) WITHIN GROUP (ORDER BY s.hours_us)
  FROM recognized_queues q LEFT JOIN spt_period s ON s.queue_id = q.queue_id
  GROUP BY q.queue_id, q.queue_ord
  UNION ALL
  SELECT 'unknown', 7, FALSE, count(*), avg(hours_ms),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_ms),
         avg(hours_us), percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_us)
  FROM spt_period WHERE NOT queue_recognized
),

-- ---------- 5-6. tracked terminal population (turnaround, approval rate) ----------
-- Every stage of every revision, per request.
stage_summary AS (
  SELECT request_id, count(*) AS n_stages,
         COALESCE(bool_or(status = 'active'), FALSE) AS any_active,
         COALESCE(bool_or(workflow_revision IS NULL OR stage_order IS NULL), FALSE) AS any_invalid_key
  FROM stg GROUP BY request_id
),
ranked AS (
  SELECT s.*, rank() OVER (PARTITION BY s.request_id
                           ORDER BY s.workflow_revision DESC NULLS LAST, s.stage_order DESC NULLS LAST) AS rk
  FROM stg s
),
-- The stage(s) at the highest (workflow_revision, stage_order) pair.
decisive AS (
  SELECT request_id, count(*) AS n_top,
         min(workflow_revision) AS d_revision, min(stage_order) AS d_order,
         min(status) AS d_status, bool_and(completed_valid) AS d_completed_valid,
         min(completed_ms) AS d_completed_ms
  FROM ranked WHERE rk = 1 GROUP BY request_id
),
-- Scope: approved, rejected, completed. Conditions in catalog order.
tt_class AS (
  SELECT r.*, COALESCE(ss.n_stages, 0) AS n_stages, d.n_top, d.d_revision, d.d_order,
         d.d_status, d.d_completed_ms AS decision_ms, CASE
      WHEN r.is_prototype THEN 'prototype_request'
      WHEN r.status NOT IN ('approved', 'rejected') THEN 'completed_status'
      WHEN NOT r.created_valid THEN 'invalid_created_at'
      WHEN COALESCE(ss.n_stages, 0) = 0 THEN 'untracked_terminal_request'
      WHEN ss.any_active THEN 'terminal_request_with_active_stage'
      WHEN ss.any_invalid_key OR d.n_top IS DISTINCT FROM 1
        OR d.d_status IS DISTINCT FROM 'completed' OR NOT COALESCE(d.d_completed_valid, FALSE)
        THEN 'terminal_stage_invalid'
      WHEN d.d_completed_ms < r.created_ms THEN 'decision_before_creation'
    END AS exclusion
  FROM req r
  LEFT JOIN stage_summary ss ON ss.request_id = r.id
  LEFT JOIN decisive d ON d.request_id = r.id
  WHERE r.status IN ('approved', 'rejected', 'completed')
),
-- Period anchor: T(r), the decisive stage's completed_at.
tt_period AS (
  SELECT t.*, (t.decision_ms - t.created_ms) / 3600000.0 AS tat_hours
  FROM tt_class t, params p
  WHERE t.exclusion IS NULL AND t.decision_ms >= p.p_start_ms AND t.decision_ms < p.p_end_ms
),
tt_stats AS (
  SELECT count(*) AS n, avg(tat_hours) AS avg_h,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY tat_hours) AS med_h,
         count(*) FILTER (WHERE status = 'approved') AS approved,
         count(*) FILTER (WHERE status = 'rejected') AS rejected
  FROM tt_period
),
-- Decisive-stage selection on every staged request, whatever its status.
-- Pending requests are outside the terminal population; this only shows the
-- ordering rule on real rows (stage_order alone would tie on amended rows).
decisive_check AS (
  SELECT count(*) AS staged_requests,
         count(*) FILTER (WHERE d.n_top = 1) AS unique_decisive,
         count(*) FILTER (WHERE d.n_top > 1) AS tied_highest_pair,
         (SELECT count(*) FROM stage_summary WHERE any_invalid_key) AS invalid_key_requests,
         (SELECT count(*) FROM (SELECT request_id FROM stg GROUP BY request_id
            HAVING count(*) FILTER (WHERE stage_order = (SELECT max(stage_order) FROM stg s2
                                                         WHERE s2.request_id = stg.request_id)) > 1) x
         ) AS would_tie_on_stage_order_alone
  FROM decisive d
),

-- ---------- 7. queue_throughput ----------
-- Scope: stages whose status is not 'active' (NULL status is in scope).
qt_class AS (
  SELECT s.*, CASE
      WHEN s.status IN ('skipped', 'cancelled') THEN 'skipped_or_cancelled_stage'
      WHEN s.status IS NULL OR s.status NOT IN ('active', 'completed', 'skipped', 'cancelled')
        THEN 'unrecognized_stage_status'
      WHEN s.status = 'completed' AND s.completed_at IS NULL THEN 'stage_missing_completed_at'
      WHEN NOT COALESCE(s.started_valid AND s.completed_valid AND s.completed_ms >= s.started_ms, FALSE)
        THEN 'invalid_stage_timestamps'
    END AS exclusion
  FROM stg s WHERE s.status IS DISTINCT FROM 'active'
),
qt_period AS (
  SELECT q.* FROM qt_class q, params p
  WHERE q.exclusion IS NULL AND q.completed_ms >= p.p_start_ms AND q.completed_ms < p.p_end_ms
),

-- ---------- Exclusion-code catalogue (catalog order per population) ----------
exclusion_codes(metric_id, ord, code) AS (
  VALUES
    ('request_volume', 1, 'prototype_request'),
    ('request_volume', 2, 'invalid_created_at'),
    ('active_queue_workload', 1, 'orphaned_active_stage'),
    ('active_queue_workload:pending_without_stage', 1, 'prototype_request'),
    ('stage_processing_time_*', 1, 'orphaned_active_stage'),
    ('stage_processing_time_*', 2, 'in_progress_stage'),
    ('stage_processing_time_*', 3, 'skipped_or_cancelled_stage'),
    ('stage_processing_time_*', 4, 'unrecognized_stage_status'),
    ('stage_processing_time_*', 5, 'stage_missing_completed_at'),
    ('stage_processing_time_*', 6, 'invalid_stage_timestamps'),
    ('tracked_terminal (turnaround_*, approval_rate)', 1, 'prototype_request'),
    ('tracked_terminal (turnaround_*, approval_rate)', 2, 'completed_status'),
    ('tracked_terminal (turnaround_*, approval_rate)', 3, 'invalid_created_at'),
    ('tracked_terminal (turnaround_*, approval_rate)', 4, 'untracked_terminal_request'),
    ('tracked_terminal (turnaround_*, approval_rate)', 5, 'terminal_request_with_active_stage'),
    ('tracked_terminal (turnaround_*, approval_rate)', 6, 'terminal_stage_invalid'),
    ('tracked_terminal (turnaround_*, approval_rate)', 7, 'decision_before_creation'),
    ('queue_throughput', 1, 'skipped_or_cancelled_stage'),
    ('queue_throughput', 2, 'unrecognized_stage_status'),
    ('queue_throughput', 3, 'stage_missing_completed_at'),
    ('queue_throughput', 4, 'invalid_stage_timestamps')
),
classified AS (
  SELECT 'request_volume' AS metric_id, exclusion FROM rv_class
  UNION ALL SELECT 'active_queue_workload', exclusion FROM aqw_class
  UNION ALL SELECT 'active_queue_workload:pending_without_stage', exclusion FROM pws_class
  UNION ALL SELECT 'stage_processing_time_*', exclusion FROM spt_class
  UNION ALL SELECT 'tracked_terminal (turnaround_*, approval_rate)', exclusion FROM tt_class
  UNION ALL SELECT 'queue_throughput', exclusion FROM qt_class
),
exclusion_counts AS (
  SELECT e.metric_id, e.ord, e.code, count(c.exclusion) AS n
  FROM exclusion_codes e
  LEFT JOIN classified c ON c.metric_id = e.metric_id AND c.exclusion = e.code
  GROUP BY e.metric_id, e.ord, e.code
),
-- Why an absent code is absent. Constraint-based entries are read live from
-- the catalog; trigger and write-path entries describe the current schema.
observability AS (
  SELECT x.code,
    CASE x.code
      WHEN 'prototype_request' THEN 'not observable in DB: prototypes are browser-only'
      WHEN 'unrecognized_stage_status' THEN CASE WHEN st.status_check AND st.keys_not_null
        THEN 'impossible: status CHECK validated, NOT NULL' ELSE 'absent: possible' END
      WHEN 'stage_missing_completed_at' THEN CASE WHEN st.status_completed_check
        THEN 'impossible: status/completed_at CHECK validated' ELSE 'absent: possible' END
      WHEN 'invalid_stage_timestamps' THEN 'absent: possible (+/-infinity or year > 9999 pass the CHECKs)'
      WHEN 'invalid_created_at' THEN 'absent: possible only on rows stored before 20261119120100 (client-supplied created_at kept; year > 9999 or BC storable; +/-infinity blocked by F4); since then database-assigned and immutable'
      WHEN 'orphaned_active_stage' THEN 'absent: possible via privileged stage writes (R4 blocks new decisions)'
      WHEN 'completed_status' THEN 'absent: possible via owner INSERT (R2 binds API roles only)'
      WHEN 'untracked_terminal_request' THEN 'absent: possible via privileged stage delete'
      WHEN 'terminal_request_with_active_stage' THEN 'absent: blocked by trigger R4 for decisions; privileged stage insert remains'
      WHEN 'terminal_stage_invalid' THEN CASE WHEN st.key_unique AND st.keys_not_null
        THEN 'absent: tie/invalid-key cases impossible (UNIQUE key, NOT NULL integer); non-completed decisive stage possible'
        ELSE 'absent: possible' END
      WHEN 'decision_before_creation' THEN 'absent: possible via privileged stage writes (completed_at directly writable); before 20261119120100 also via created_at changed after decision'
      ELSE 'absent: possible'
    END AS when_absent
  FROM (SELECT DISTINCT code FROM exclusion_codes) x CROSS JOIN structural st
),

-- ---------- Result rows ----------
-- period_bound: the row depends on the reporting period (audit applies only to the default period).
results(sort1, sort2, metric_id, measure, expected, audit, period_bound, note) AS (
  -- dataset
  SELECT 1, 1, 'dataset', 'financial_requests records', (SELECT count(*) FROM req)::text, '7', FALSE, NULL
  UNION ALL SELECT 1, 2, 'dataset', 'approval_stage_tracking records', (SELECT count(*) FROM stg)::text, '9', FALSE, NULL
  UNION ALL SELECT 1, 3, 'dataset', 'stages whose request is not stored', (SELECT count(*) FROM stg WHERE request_status IS NULL)::text, '0', FALSE,
    'would be stage_request_not_loaded (load integrity) for metrics reading both tables'

  -- 2. request_volume
  UNION ALL SELECT 2, 1, 'request_volume', 'value (requests, created_at in period)',
    (SELECT count(*) FROM rv_class r, params p WHERE r.exclusion IS NULL
       AND r.created_ms >= p.p_start_ms AND r.created_ms < p.p_end_ms)::text, '7', TRUE, 'empty result is 0'
  UNION ALL SELECT 2, 2, 'request_volume', 'population in scope / included',
    (SELECT count(*) || ' / ' || count(*) FILTER (WHERE exclusion IS NULL) FROM rv_class), '7 / 7', FALSE, 'full dataset'
  UNION ALL SELECT 2, 3, 'request_volume', 'probe: October 2026 UTC [10-01, 11-01)',
    (SELECT count(*) FROM rv_class WHERE exclusion IS NULL
       AND created_ms >= floor(extract(epoch FROM timestamptz '2026-10-01T00:00:00Z') * 1000)
       AND created_ms <  floor(extract(epoch FROM timestamptz '2026-11-01T00:00:00Z') * 1000))::text, '0', FALSE, 'fixed period'
  UNION ALL SELECT 2, 4, 'request_volume', 'probe: December 2026 UTC [12-01, 2027-01-01)',
    (SELECT count(*) FROM rv_class WHERE exclusion IS NULL
       AND created_ms >= floor(extract(epoch FROM timestamptz '2026-12-01T00:00:00Z') * 1000)
       AND created_ms <  floor(extract(epoch FROM timestamptz '2027-01-01T00:00:00Z') * 1000))::text, '0', FALSE, 'fixed period'
  UNION ALL SELECT 2, 5, 'request_volume', 'probe: custom range 2026-11-18..2026-11-18 America/New_York',
    (SELECT count(*) FROM rv_class WHERE exclusion IS NULL
       AND created_ms >= floor(extract(epoch FROM (date '2026-11-18')::timestamp AT TIME ZONE 'America/New_York') * 1000)
       AND created_ms <  floor(extract(epoch FROM (date '2026-11-19')::timestamp AT TIME ZONE 'America/New_York') * 1000))::text,
    '7', FALSE, '04:39Z on 11-19 is 23:39 Eastern on 11-18'
  UNION ALL SELECT 2, 6, 'request_volume', 'probe: custom range 2026-11-19..2026-11-19 America/New_York',
    (SELECT count(*) FROM rv_class WHERE exclusion IS NULL
       AND created_ms >= floor(extract(epoch FROM (date '2026-11-19')::timestamp AT TIME ZONE 'America/New_York') * 1000)
       AND created_ms <  floor(extract(epoch FROM (date '2026-11-20')::timestamp AT TIME ZONE 'America/New_York') * 1000))::text,
    '0', FALSE, 'fixed period'
  UNION ALL SELECT 2, 7, 'request_volume', 'flags', 'none defined', NULL, FALSE, NULL

  -- 3. active_queue_workload (snapshot: no period, no overall value)
  UNION ALL SELECT 3, q.queue_ord, 'active_queue_workload', 'queue ' || q.queue_id || ' (distinct requests)',
    (SELECT count(DISTINCT a.request_id) FROM aqw_included a WHERE a.queue_id = q.queue_id)::text,
    CASE q.queue_id WHEN 'department_budget' THEN '5' WHEN 'dean_office' THEN '1' ELSE '0' END, FALSE,
    'snapshot; empty recognized queue is 0'
  FROM recognized_queues q
  UNION ALL SELECT 3, 7, 'active_queue_workload', 'unknown group (distinct requests)',
    (SELECT CASE WHEN count(*) = 0 THEN 'absent' ELSE count(DISTINCT request_id)::text END
     FROM aqw_included WHERE NOT queue_recognized), 'absent', FALSE, 'shown only when populated'
  UNION ALL SELECT 3, 8, 'active_queue_workload', 'population in scope / included (active stages)',
    (SELECT count(*) || ' / ' || count(*) FILTER (WHERE exclusion IS NULL) FROM aqw_class), '6 / 6', FALSE, NULL
  UNION ALL SELECT 3, 9, 'active_queue_workload', 'flag duplicate_active_stages (requests)',
    (SELECT count(*) FROM (SELECT request_id FROM aqw_included GROUP BY request_id HAVING count(*) > 1) x)::text,
    '0', FALSE, (SELECT CASE WHEN single_active THEN 'impossible: unique partial index on active stages' ELSE 'absent: possible' END FROM structural)
  UNION ALL SELECT 3, 10, 'active_queue_workload', 'flag unknown_queue (stages)',
    (SELECT count(*) FROM aqw_included WHERE NOT queue_recognized)::text, '0', FALSE,
    (SELECT CASE WHEN queue_allowlist THEN 'impossible: queue allowlist CHECK validated' ELSE 'absent: possible' END FROM structural)
  UNION ALL SELECT 3, 11, 'active_queue_workload', 'separate report pending_without_stage',
    (SELECT count(*) FILTER (WHERE exclusion IS NULL) FROM pws_class)::text, '1', FALSE,
    'pending requests with no stage of any status: '
      || COALESCE((SELECT string_agg(left(id::text, 8), ', ' ORDER BY id) FROM pws_class WHERE exclusion IS NULL), 'none')
  UNION ALL SELECT 3, 12, 'active_queue_workload', 'overall value', 'not defined', NULL, FALSE,
    'catalog groups by queue only; a sum would double count'

  -- 4. stage_processing_time_average / _median
  UNION ALL SELECT 4, g.grp_ord * 2 + 1, 'stage_processing_time_average', g.grp || ' (n=' || g.n || ')',
    COALESCE(g.avg_ms::text, 'no-data'), 'no-data', TRUE,
    'ms-precision; microsecond value: ' || COALESCE(g.avg_us::text, 'no-data')
  FROM spt_groups g WHERE g.always_shown OR g.n > 0
  UNION ALL SELECT 4, g.grp_ord * 2 + 2, 'stage_processing_time_median', g.grp || ' (n=' || g.n || ')',
    COALESCE(g.med_ms::text, 'no-data'), 'no-data', TRUE,
    'ms-precision; microsecond value: ' || COALESCE(g.med_us::text, 'no-data')
  FROM spt_groups g WHERE g.always_shown OR g.n > 0
  UNION ALL SELECT 4, 20, 'stage_processing_time_*', 'unknown group',
    (SELECT CASE WHEN count(*) = 0 THEN 'absent' ELSE count(*)::text END FROM spt_period WHERE NOT queue_recognized),
    'absent', TRUE, NULL
  UNION ALL SELECT 4, 21, 'stage_processing_time_*', 'population in scope / included (full dataset)',
    (SELECT count(*) || ' / ' || count(*) FILTER (WHERE exclusion IS NULL) FROM spt_class), '9 / 0', FALSE, NULL
  UNION ALL SELECT 4, 22, 'stage_processing_time_*', 'flag unknown_queue (included stages, full dataset)',
    (SELECT count(*) FROM spt_class WHERE exclusion IS NULL AND NOT queue_recognized)::text, '0', FALSE,
    (SELECT CASE WHEN queue_allowlist THEN 'impossible: queue allowlist CHECK validated' ELSE 'absent: possible' END FROM structural)

  -- 5. request_turnaround_time_average / _median
  UNION ALL SELECT 5, 1, 'request_turnaround_time_average', 'value (hours, n=' || n || ')',
    COALESCE(avg_h::text, 'no-data'), 'no-data', TRUE, 'from original created_at to T(r)' FROM tt_stats
  UNION ALL SELECT 5, 2, 'request_turnaround_time_median', 'value (hours, n=' || n || ')',
    COALESCE(med_h::text, 'no-data'), 'no-data', TRUE, NULL FROM tt_stats
  UNION ALL SELECT 5, 3, 'tracked_terminal (turnaround_*, approval_rate)', 'population in scope / included (full dataset)',
    (SELECT count(*) || ' / ' || count(*) FILTER (WHERE exclusion IS NULL) FROM tt_class), '0 / 0', FALSE,
    'scope: approved, rejected, completed'
  UNION ALL SELECT 5, 4, 'tracked_terminal (turnaround_*, approval_rate)', 'decisive stage: staged requests / unique highest pair',
    (SELECT staged_requests || ' / ' || unique_decisive FROM decisive_check), '6 / 6', FALSE,
    'all statuses; pending requests are outside the population'
  UNION ALL SELECT 5, 5, 'tracked_terminal (turnaround_*, approval_rate)', 'decisive stage: ties at highest pair / invalid keys',
    (SELECT tied_highest_pair || ' / ' || invalid_key_requests FROM decisive_check), '0 / 0', FALSE, NULL
  UNION ALL SELECT 5, 6, 'tracked_terminal (turnaround_*, approval_rate)', 'requests that would tie on stage_order alone',
    (SELECT would_tie_on_stage_order_alone::text FROM decisive_check), '3', FALSE,
    'amended requests: rev 1 and rev 2 both have stage_order 1'
  UNION ALL SELECT 5, 7, 'request_turnaround_time_*', 'flags', 'none defined', NULL, FALSE, NULL

  -- 6. approval_rate
  UNION ALL SELECT 6, 1, 'approval_rate', 'approved (A)', approved::text, '0', TRUE, NULL FROM tt_stats
  UNION ALL SELECT 6, 2, 'approval_rate', 'rejected (R)', rejected::text, '0', TRUE, NULL FROM tt_stats
  UNION ALL SELECT 6, 3, 'approval_rate', 'denominator (A + R)', (approved + rejected)::text, '0', TRUE,
    'completed requests never count (completed_status)' FROM tt_stats
  UNION ALL SELECT 6, 4, 'approval_rate', 'value A / (A + R)',
    CASE WHEN approved + rejected = 0 THEN 'no-data' ELSE (approved::numeric / (approved + rejected))::text END,
    'no-data', TRUE, 'no-data when A + R = 0, never 0%' FROM tt_stats

  -- 7. queue_throughput
  UNION ALL SELECT 7, q.queue_ord, 'queue_throughput', 'queue ' || q.queue_id || ' (stage decisions)',
    (SELECT count(*) FROM qt_period t WHERE t.queue_id = q.queue_id)::text, '0', TRUE, 'empty is 0'
  FROM recognized_queues q
  UNION ALL SELECT 7, 7, 'queue_throughput', 'unknown group (stage decisions)',
    (SELECT CASE WHEN count(*) = 0 THEN 'absent' ELSE count(*)::text END FROM qt_period WHERE NOT queue_recognized),
    'absent', TRUE, NULL
  UNION ALL SELECT 7, 8, 'queue_throughput', 'overall total (stage records, not requests)',
    (SELECT count(*) FROM qt_period)::text, '0', TRUE,
    'distinct requests behind it: ' || (SELECT count(DISTINCT request_id) FROM qt_period)
  UNION ALL SELECT 7, 9, 'queue_throughput', 'population in scope / included (full dataset)',
    (SELECT count(*) || ' / ' || count(*) FILTER (WHERE exclusion IS NULL) FROM qt_class), '3 / 0', FALSE,
    'scope: status not active'
  UNION ALL SELECT 7, 10, 'queue_throughput', 'flag unknown_queue (included stages, full dataset)',
    (SELECT count(*) FROM qt_class WHERE exclusion IS NULL AND NOT queue_recognized)::text, '0', FALSE,
    (SELECT CASE WHEN queue_allowlist THEN 'impossible: queue allowlist CHECK validated' ELSE 'absent: possible' END FROM structural)

  -- 8. exclusion counts, full dataset, catalog order, with observability
  UNION ALL SELECT 8, row_number() OVER (ORDER BY
      CASE split_part(e.metric_id, ' ', 1) WHEN 'request_volume' THEN 1 WHEN 'active_queue_workload' THEN 2
        WHEN 'active_queue_workload:pending_without_stage' THEN 3 WHEN 'stage_processing_time_*' THEN 4
        WHEN 'tracked_terminal' THEN 5 ELSE 6 END, e.ord)::int,
    e.metric_id, e.ord || '. exclusion ' || e.code, e.n::text,
    CASE
      WHEN e.metric_id = 'stage_processing_time_*' AND e.code = 'in_progress_stage' THEN '6'
      WHEN e.code = 'skipped_or_cancelled_stage' THEN '3'
      ELSE '0' END,
    FALSE,
    CASE WHEN e.n > 0 THEN 'observed' ELSE o.when_absent END
  FROM exclusion_counts e JOIN observability o ON o.code = e.code
),
compared AS (
  SELECT r.*,
         CASE WHEN r.audit IS NULL THEN 'n/a'
              WHEN r.period_bound AND NOT p.audit_period THEN 'n/a (non-audit period)'
              WHEN r.expected = r.audit THEN 'yes' ELSE 'NO' END AS agrees
  FROM results r, params p
),
-- 9. Summary against the F19.5.1 audit: compared rows per result group.
summary AS (
  SELECT 9 AS sort1, min(sort1) AS sort2, metric_id,
         'SUMMARY: rows agreeing with F19.5.1' AS measure,
         count(*) FILTER (WHERE agrees = 'yes') || ' of '
           || count(*) FILTER (WHERE agrees IN ('yes', 'NO')) AS expected,
         NULL::text AS audit,
         CASE WHEN bool_or(agrees = 'NO') THEN 'DIFFERS'
              WHEN count(*) FILTER (WHERE agrees = 'yes') = 0 THEN 'n/a'
              ELSE 'yes' END AS agrees,
         CASE WHEN bool_or(agrees = 'NO')
              THEN 'differs: ' || string_agg(measure, '; ') FILTER (WHERE agrees = 'NO') END AS note
  FROM compared GROUP BY metric_id
  UNION ALL
  SELECT 9, 99, 'ALL', 'SUMMARY: rows agreeing with F19.5.1',
         count(*) FILTER (WHERE agrees = 'yes') || ' of '
           || count(*) FILTER (WHERE agrees IN ('yes', 'NO')),
         NULL,
         CASE WHEN bool_or(agrees = 'NO') THEN 'DIFFERS' ELSE 'yes' END,
         'TypeScript agreement is NOT claimed here (F19.5.3)'
  FROM compared
)
SELECT metric_id, measure, expected, audit, agrees, note
FROM (SELECT sort1, sort2, metric_id, measure, expected, audit, agrees, note FROM compared
      UNION ALL SELECT * FROM summary) AS o
ORDER BY sort1, sort2, metric_id, measure;

\echo
\echo 'Done. Rolling back (nothing was written).'
ROLLBACK;
