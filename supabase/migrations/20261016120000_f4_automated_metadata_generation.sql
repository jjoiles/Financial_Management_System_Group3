-- F4: Automated Metadata Generation
--
-- Remediation for DEBT_AND_RISK Item (F4):
--   "Metadata is created in UI code and includes simulated values that may be
--    incomplete or mislinked. Define a schema, generate trusted fields on the
--    backend, validate them, and test association."
--
-- 1. f4_enforce_request_metadata(): BEFORE INSERT OR UPDATE trigger on
--    public.financial_requests that generates/stamps trusted server-side
--    metadata fields, derives fiscal year/quarter and amount tier, and
--    guarantees metadata.userId and metadata.requestNumber match the row.
-- 2. f4_sync_attachment_metadata(): AFTER INSERT OR DELETE trigger on
--    public.request_attachments that keeps parent request metadata in sync
--    with actual stored attachment rows.
-- 3. financial_requests_metadata_valid CHECK constraint (added NOT VALID so
--    legacy prototype rows do not block migration) enforcing schema & record
--    association on every new write.

-- 1. Trusted backend metadata generation & association trigger ---------------

CREATE OR REPLACE FUNCTION public.f4_enforce_request_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ts TIMESTAMPTZ := COALESCE(NEW.created_at, now());
  cal_month INT := EXTRACT(MONTH FROM ts AT TIME ZONE 'UTC');
  cal_year INT := EXTRACT(YEAR FROM ts AT TIME ZONE 'UTC');
  fy_year INT;
  fy_quarter TEXT;
  amount_tier TEXT;
  derived_obj JSONB;
  attachments_arr JSONB;
BEGIN
  -- Ensure request_number is always present and formatted (F4.2.1)
  IF NEW.request_number IS NULL OR btrim(NEW.request_number) = '' THEN
    NEW.request_number := 'FR-' || to_char(ts AT TIME ZONE 'UTC', 'YYYY') || '-' ||
      upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  END IF;

  -- Ensure timestamps are trusted (F4.2.1)
  IF TG_OP = 'INSERT' AND NEW.created_at IS NULL THEN
    NEW.created_at := ts;
  END IF;
  NEW.updated_at := now();

  -- Fallback if metadata is null or not a JSON object (F4.3.3)
  IF NEW.metadata IS NULL OR jsonb_typeof(NEW.metadata) <> 'object' THEN
    NEW.metadata := '{}'::jsonb;
  END IF;

  -- Compute Howard University fiscal period (July 1 start) and amount tier (F4.2.4)
  IF cal_month >= 7 THEN
    fy_year := cal_year + 1;
  ELSE
    fy_year := cal_year;
  END IF;

  IF cal_month BETWEEN 7 AND 9 THEN
    fy_quarter := 'Q1';
  ELSIF cal_month BETWEEN 10 AND 12 THEN
    fy_quarter := 'Q2';
  ELSIF cal_month BETWEEN 1 AND 3 THEN
    fy_quarter := 'Q3';
  ELSE
    fy_quarter := 'Q4';
  END IF;

  IF NEW.amount >= 50000 THEN
    amount_tier := 'executive';
  ELSIF NEW.amount >= 10000 THEN
    amount_tier := 'elevated';
  ELSE
    amount_tier := 'standard';
  END IF;

  -- Ensure attachments array is well-formed (F4.2.3)
  IF jsonb_typeof(NEW.metadata -> 'attachments') = 'array' THEN
    attachments_arr := NEW.metadata -> 'attachments';
  ELSE
    attachments_arr := '[]'::jsonb;
  END IF;

  -- Merge derived business-rule metadata (F4.2.4)
  IF jsonb_typeof(NEW.metadata -> 'derived') = 'object' THEN
    derived_obj := NEW.metadata -> 'derived';
  ELSE
    derived_obj := '{}'::jsonb;
  END IF;

  derived_obj := derived_obj || jsonb_build_object(
    'fiscalYear', 'FY' || fy_year::text,
    'fiscalQuarter', fy_quarter,
    'amountTier', amount_tier,
    'requiresGrantValidation', (NEW.funding_source = 'research'),
    'requiresProgramOversight', (NEW.funding_source = 'university'),
    'isExpedited', COALESCE((derived_obj ->> 'isExpedited')::boolean, (NEW.priority = 'high'))
  );

  -- Stamp authoritative record-linked fields so metadata cannot be mislinked (F4.2.2, F4.3.2)
  NEW.metadata := NEW.metadata || jsonb_build_object(
    'schemaVersion', COALESCE(NEW.metadata ->> 'schemaVersion', '1.0'),
    'source', COALESCE(NEW.metadata ->> 'source', 'FinReq portal'),
    'automation', COALESCE(NEW.metadata ->> 'automation', 'Power Automate'),
    'requestNumber', NEW.request_number,
    'userId', NEW.user_id::text,
    'requesterEmail', lower(btrim(NEW.requester_email)),
    'department', btrim(NEW.department),
    'submittedAt', COALESCE(NEW.metadata ->> 'submittedAt', to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'serverReceivedAt', COALESCE(NEW.metadata ->> 'serverReceivedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'serverUpdatedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'attachmentCount', COALESCE((NEW.metadata ->> 'attachmentCount')::int, jsonb_array_length(attachments_arr)),
    'attachments', attachments_arr,
    'derived', derived_obj,
    'generationStatus', COALESCE(NEW.metadata ->> 'generationStatus', 'complete')
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS f4_enforce_request_metadata ON public.financial_requests;
CREATE TRIGGER f4_enforce_request_metadata
BEFORE INSERT OR UPDATE ON public.financial_requests
FOR EACH ROW EXECUTE FUNCTION public.f4_enforce_request_metadata();

-- 2. Keep parent metadata synchronized with request_attachments rows ---------

CREATE OR REPLACE FUNCTION public.f4_sync_attachment_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_request_id UUID := COALESCE(NEW.request_id, OLD.request_id);
  actual_count INT;
  actual_bytes BIGINT;
BEGIN
  SELECT count(*), COALESCE(sum(COALESCE(file_size, 0)), 0)
  INTO actual_count, actual_bytes
  FROM public.request_attachments
  WHERE request_id = target_request_id;

  BEGIN
    UPDATE public.financial_requests
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'attachmentCount', actual_count,
      'verifiedAttachmentCount', actual_count,
      'verifiedAttachmentBytes', actual_bytes
    )
    WHERE id = target_request_id;
  EXCEPTION WHEN check_violation OR raise_exception THEN
    -- Do not fail attachment insert/delete if a legacy parent row violates a newer F22 rule
    NULL;
  END;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS f4_sync_attachment_metadata ON public.request_attachments;
CREATE TRIGGER f4_sync_attachment_metadata
AFTER INSERT OR DELETE ON public.request_attachments
FOR EACH ROW EXECUTE FUNCTION public.f4_sync_attachment_metadata();

-- 3. Database-level validation & linkage constraint (F4.3.1, F4.3.2, F4.4.3) -

ALTER TABLE public.financial_requests
  ADD CONSTRAINT financial_requests_metadata_valid
    CHECK (
      jsonb_typeof(metadata) = 'object'
      AND (metadata ->> 'schemaVersion') IS NOT NULL
      AND (metadata ->> 'requestNumber') = request_number
      AND (metadata ->> 'userId') = user_id::text
      AND jsonb_typeof(metadata -> 'derived') = 'object'
      AND jsonb_typeof(metadata -> 'attachments') = 'array'
    ) NOT VALID;

REVOKE ALL ON FUNCTION public.f4_enforce_request_metadata() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.f4_sync_attachment_metadata() FROM PUBLIC, anon, authenticated;
