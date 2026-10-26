# F4: Automated Metadata Generation

## Overview

Before F4, `src/routes/submit.tsx` generated request numbers inline and wrote an unvalidated metadata literal (`{ source: "FinReq portal", automation: "Power Automate", attachmentCount: files.length }`) directly from the UI (`DEBT_AND_RISK.md`, Data Integrity Risk — F4). File attributes were not captured in the metadata manifest, derived fiscal/tier fields did not exist, and nothing on the client or database verified that `metadata` stayed linked to the submitting user and request record.

F4 replaces inline metadata creation with:

1. **Defined metadata requirements & Zod schemas (`F4.1.1`–`F4.1.3`).** Explicit separation between required record fields, file-extracted fields, and system/business-rule derived fields.
2. **Automated metadata generation (`F4.2.1`–`F4.2.4`).** Pure functions in `src/lib/request-utils.ts` generate request numbers (`FR-YYYY-XXXXXX`), UTC timestamps, correlation IDs, sanitized file manifests, and Howard University fiscal year/quarter (`FYyyyy`, `Q1`–`Q4` starting July 1) and amount tiers (`standard`, `elevated`, `executive`).
3. **Validation, fallback handling, and backend enforcement (`F4.3.1`–`F4.3.3`).** `validateRequestMetadata()` checks the schema before save, `generateRequestMetadataSafe()` provides a logged fallback if source inputs are malformed, and a Supabase database trigger (`f4_enforce_request_metadata`) + `CHECK` constraint (`financial_requests_metadata_valid`) guarantee server-trusted fields and record linkage.
4. **Verification & unit tests (`F4.4.1`–`F4.4.3`).** `verifyMetadataAssociation()` and the Vitest suite in `src/lib/request-utils.test.ts` test normal records, missing/invalid source data, and user/record linkage.

---

## Metadata Requirements (`F4.1`)

| Category | Sub-issue | Fields | Source |
|---|---|---|---|
| **Required Record Metadata** | `F4.1.1` | `schemaVersion`, `source`, `automation`, `requestNumber`, `userId`, `requesterEmail`, `department`, `submittedAt`, `correlationId`, `attachmentCount`, `attachments`, `derived`, `generationStatus` | Enforced by `requestMetadataSchema` and `financial_requests_metadata_valid` |
| **File-Extracted Metadata** | `F4.1.2` | `fileName`, `safeFileName`, `extension`, `contentType`, `sizeBytes`, `lastModifiedIso` | Extracted per uploaded `File` by `extractFileMetadata()` (`F4.2.3`) |
| **System & Derived Metadata** | `F4.1.3` | `fiscalYear`, `fiscalQuarter`, `amountTier`, `requiresGrantValidation`, `requiresProgramOversight`, `isExpedited`, `totalAttachmentBytes`, `attachmentContentTypes`, `serverReceivedAt`, `serverUpdatedAt` | Computed by `generateDerivedMetadata()` (`F4.2.4`) and DB trigger `f4_enforce_request_metadata()` (`F4.2.1`) |

---

## What We Built

### 1. Metadata generator, validator & association checker (`src/lib/request-utils.ts`)

- **`createRequestNumber(date?)` (`F4.2.1`)**: Generates `FR-<YEAR>-<6-CHAR-ALPHANUMERIC>` and validates the input `Date`.
- **`extractFileMetadata(file)` & `extractAttachmentsMetadata(files)` (`F4.2.3`)**: Extracts original filename, path-sanitized filename (`sanitizeFileName`), lowercase extension, MIME type (with extension fallback), non-negative byte size, and ISO last-modified timestamp.
- **`deriveFiscalPeriod(date)` & `deriveAmountTier(amount)` & `generateDerivedMetadata(input)` (`F4.2.4`)**:
  - Computes Howard University's fiscal year (`FYyyyy`) and quarter (`Q1` = Jul–Sep, `Q2` = Oct–Dec, `Q3` = Jan–Mar, `Q4` = Apr–Jun).
  - Classifies request amount into `standard` (`< $10,000`), `elevated` (`$10,000–$49,999.99`), or `executive` (`>= $50,000`).
  - Sets `requiresGrantValidation` (`fundingSource === "research"`), `requiresProgramOversight` (`fundingSource === "university"`), `isExpedited`, `totalAttachmentBytes`, and unique `attachmentContentTypes`.
- **`generateRequestMetadata(params)` & `generateRequestMetadataSafe(params)` (`F4.2.1`, `F4.2.2`, `F4.3.3`)**:
  - Builds and validates the complete `RequestMetadata` object linked to `userId` and `requestNumber`.
  - If any source field is missing or malformed, `generateRequestMetadataSafe` logs `metadata.generation_fallback` / `metadata.generated_with_fallback` via `src/lib/logger.ts` and returns a valid fallback metadata payload with `generationStatus: "fallback"`.
- **`validateRequestMetadata(candidate)` (`F4.3.1`)**: Runs `requestMetadataSchema.safeParse`, including a cross-field check that `attachmentCount === attachments.length`.
- **`verifyMetadataAssociation(metadata, record)` (`F4.4.3`)**: Verifies that `metadata.userId`, `metadata.requestNumber`, `metadata.requesterEmail`, `metadata.department`, and `metadata.attachmentCount` match the parent request row.

### 2. Database triggers & constraint (`supabase/migrations/20261016120000_f4_automated_metadata_generation.sql`)

| Object | Table | Purpose |
|---|---|---|
| `f4_enforce_request_metadata` | `financial_requests` (`BEFORE INSERT OR UPDATE`) | Generates `request_number` and timestamps if omitted, computes fiscal year/quarter and amount tier on the server, and stamps `userId`, `requestNumber`, `requesterEmail`, `department`, `serverReceivedAt`, and `serverUpdatedAt` into `NEW.metadata` so client payloads cannot spoof or mislink them. |
| `f4_sync_attachment_metadata` | `request_attachments` (`AFTER INSERT OR DELETE`) | Synchronizes `attachmentCount`, `verifiedAttachmentCount`, and `verifiedAttachmentBytes` in `financial_requests.metadata` whenever attachment rows are added or removed. |
| `financial_requests_metadata_valid` | `financial_requests` (`CHECK ... NOT VALID`) | Enforces that `metadata` is a JSON object with `schemaVersion`, `derived`, `attachments`, and `metadata.userId = user_id` / `metadata.requestNumber = request_number`. |

### 3. UI & Data Layer Integration

- **`src/routes/submit.tsx`**: Uses `createRequestNumber`, `generateRequestMetadataSafe`, `verifyMetadataAssociation`, and `sanitizeFileName` during submission.
- **`src/lib/requests-data.ts`**: Parses `metadata` via `readRequestMetadata(row.metadata)` onto `EnrichedRequest`.
- **`src/components/RequestDetailDialog.tsx`**: Displays the **Generated Metadata (F4)** panel showing Fiscal Period, Amount Tier, Schema Version, and the Extracted Attachment Manifest.

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/request-utils.ts` | New/Expanded. F4 schemas, file metadata extractor, derived business rules, generator, fallback handler, and association verifier |
| `src/lib/request-utils.test.ts` | New/Expanded. 26 unit tests covering `F4.1`–`F4.4` and VIBE refactor functions |
| `supabase/migrations/20261016120000_f4_automated_metadata_generation.sql` | New. Server-side metadata generation & attachment sync triggers + `CHECK` constraint |
| `src/routes/submit.tsx` | Integrated `createRequestNumber`, `generateRequestMetadataSafe`, `verifyMetadataAssociation`, and `sanitizeFileName` |
| `src/lib/requests-data.ts` | Exposed parsed `RequestMetadata` on `EnrichedRequest` |
| `src/components/RequestDetailDialog.tsx` | Added **Generated Metadata (F4)** detail panel |
| `docs/F4_Automated_Metadata_Generation.md` | New. Feature documentation |

---

## How to Test

1. Run the unit test suite:
   ```bash
   npx vitest run src/lib/request-utils.test.ts
   ```
2. Apply the migration in Supabase (`supabase/migrations/20261016120000_f4_automated_metadata_generation.sql`).
3. Submit a financial request with one or more file attachments on `/submit`, then open the request in **My Requests** (`/requests`) to inspect the **Generated Metadata (F4)** panel (Fiscal Period, Amount Tier, Schema Version, and Extracted Attachment Manifest).
