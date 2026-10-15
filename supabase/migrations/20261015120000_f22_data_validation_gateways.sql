-- F22: Data Validation Gateways (database gateway)
--
-- The client validates with Zod, but anyone holding the publishable key can
-- call Supabase directly. These rules make the database the final gateway.
-- Limits match src/lib/validation/request-schema.ts.
--
-- Constraints are added NOT VALID so existing prototype rows do not block the
-- migration; they are still enforced for every new INSERT and UPDATE.
-- After cleaning old data, run:
--   ALTER TABLE public.financial_requests VALIDATE CONSTRAINT <name>;

-- 1. Normalize input before constraints run --------------------------------

CREATE OR REPLACE FUNCTION public.f22_normalize_financial_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  today_et DATE := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  NEW.requester_email := lower(btrim(NEW.requester_email));
  NEW.department := regexp_replace(btrim(NEW.department), '\s+', ' ', 'g');
  NEW.title := btrim(NEW.title);
  NEW.description := btrim(NEW.description);
  NEW.grant_number := nullif(btrim(NEW.grant_number), '');
  NEW.principal_investigator := nullif(btrim(NEW.principal_investigator), '');
  NEW.university_program := nullif(btrim(NEW.university_program), '');

  -- Fields that do not belong to the chosen funding source are cleared.
  IF NEW.funding_source <> 'research' THEN
    NEW.grant_number := NULL;
    NEW.principal_investigator := NULL;
  END IF;
  IF NEW.funding_source <> 'university' THEN
    NEW.university_program := NULL;
  END IF;

  -- Needed-by date cannot be in the past. Only checked when the date is set
  -- or changed, so old requests can still move through review.
  IF (TG_OP = 'INSERT' OR NEW.needed_by IS DISTINCT FROM OLD.needed_by)
     AND NEW.needed_by < today_et THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Choose today or a future date.',
      HINT = 'financial_requests_needed_by_not_past';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS f22_normalize_financial_request ON public.financial_requests;
CREATE TRIGGER f22_normalize_financial_request
BEFORE INSERT OR UPDATE ON public.financial_requests
FOR EACH ROW EXECUTE FUNCTION public.f22_normalize_financial_request();

-- 2. Field rules -------------------------------------------------------------

ALTER TABLE public.financial_requests
  ADD CONSTRAINT financial_requests_amount_range
    CHECK (amount > 0 AND amount <= 9999999.99) NOT VALID,
  ADD CONSTRAINT financial_requests_amount_precision
    CHECK (amount = round(amount, 2)) NOT VALID,
  ADD CONSTRAINT financial_requests_email_domain
    CHECK (requester_email ~ '^[^@\s]+@howard\.edu$') NOT VALID,
  ADD CONSTRAINT financial_requests_department_length
    CHECK (char_length(department) BETWEEN 2 AND 80) NOT VALID,
  ADD CONSTRAINT financial_requests_title_length
    CHECK (char_length(title) BETWEEN 1 AND 120) NOT VALID,
  ADD CONSTRAINT financial_requests_description_length
    CHECK (char_length(description) BETWEEN 1 AND 10000) NOT VALID,
  ADD CONSTRAINT financial_requests_grant_number_length
    CHECK (grant_number IS NULL OR char_length(grant_number) BETWEEN 3 AND 64) NOT VALID;

-- 3. Conditional rules by funding source ------------------------------------

ALTER TABLE public.financial_requests
  ADD CONSTRAINT financial_requests_research_fields
    CHECK (
      funding_source <> 'research'
      OR (grant_number IS NOT NULL AND principal_investigator IS NOT NULL)
    ) NOT VALID,
  ADD CONSTRAINT financial_requests_university_fields
    CHECK (
      funding_source <> 'university' OR university_program IS NOT NULL
    ) NOT VALID;

-- 4. Attachment manifest rules ----------------------------------------------

ALTER TABLE public.request_attachments
  ADD CONSTRAINT request_attachments_file_name_length
    CHECK (char_length(file_name) BETWEEN 1 AND 255) NOT VALID,
  ADD CONSTRAINT request_attachments_file_size_positive
    CHECK (file_size IS NULL OR file_size >= 0) NOT VALID,
  ADD CONSTRAINT request_attachments_path_scoped
    CHECK (file_path NOT LIKE '%..%') NOT VALID;
