# F2: Input Validation (`F2.1`–`F2.3`)

**Owner:** Ibrahim Osman (`Iosman172`)  
**Tasks:** `F2.1` (`F2.1.1`–`F2.1.3`), `F2.2` (`F2.2.1`–`F2.2.3`), `F2.3` (`F2.3.1`–`F2.3.3`)

---

## Overview

`F2` enforces multi-layer input validation and sanitization for all financial request submissions across:
- `src/lib/validation/request-schema.ts` (`requestSchema`, `LIMITS`, `HOWARD_EMAIL_DOMAIN`, `stripControlChars`, `cleanLine`, `cleanBlock`, `hasAtMostTwoDecimals`)
- `src/lib/validation/gateways.ts` (`validateSubmission`, `buildValidatedPayload`, `mapDatabaseValidationError`)
- `src/lib/validation/request-schema.test.ts` & `src/lib/requests/submission-service.test.ts`

---

## Subtask Mapping

| Task / Subtask | Implementation |
| :--- | :--- |
| **`F2.1.1`:** Define required fields, data types, and character length limits | `LIMITS` (`amountMax: 9,999,999.99`, `departmentMin: 2`, `departmentMax: 80`, `descriptionMax: 10,000`, `grantNumberMin: 3`, `grantNumberMax: 64`, `nameMax: 120`) in `src/lib/validation/request-schema.ts`. |
| **`F2.1.2`:** Define format and domain rules | Enforces `@howard.edu` requester email domain (`HOWARD_EMAIL_DOMAIN`), positive 2-decimal dollar amounts (`hasAtMostTwoDecimals`), `YYYY-MM-DD` non-past `neededBy` dates (`localToday`), and enum constraints on `fundingSource` and `priority`. |
| **`F2.1.3`:** Define clear field-level validation error messages | Field-specific validation error messages mapped to `FormErrors` (`Partial<Record<keyof RequestInput, string>>`) and rendered inline via `<ErrorText />`. |
| **`F2.2.1`:** Implement centralized Zod form and payload validation schema | `requestSchema` in `src/lib/validation/request-schema.ts` and `validateSubmission()` / `buildValidatedPayload()` in `src/lib/validation/gateways.ts`. |
| **`F2.2.2`:** Sanitize text inputs | `stripControlChars()`, `cleanLine()`, and `cleanBlock()` remove control characters, collapse repeated whitespace, and normalize CRLF line endings before validation and storage. |
| **`F2.2.3`:** Enforce validation gateways in form submission and database error mapping | `createSubmissionService()` in `src/lib/requests/submission-service.ts` blocks invalid inputs prior to persistence and maps database constraint rejections (`23514`) back to field errors via `mapDatabaseValidationError()`. |
| **`F2.3.1`–`F2.3.3`:** Verify valid inputs, invalid formats/bounds, and sanitization | Unit tests in `src/lib/validation/request-schema.test.ts` and `src/lib/requests/submission-service.test.ts`. |
