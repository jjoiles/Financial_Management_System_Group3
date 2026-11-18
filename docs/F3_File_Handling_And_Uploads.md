# F3: File Handling & Uploads (`F3.1`–`F3.4`)

**Owner:** Ibrahim Osman (`Iosman172`)  
**Issues:** `#46` (`F3.1`: `#50`–`#52`), `#47` (`F3.2`: `#53`–`#56`), `#48` (`F3.3`: `#57`–`#59`), `#49` (`F3.4`: `#60`–`#62`)

---

## Overview

`F3` provides end-to-end attachment validation, upload processing, storage path security, and error recovery across:
- `src/lib/file-validation.ts` (`validateSingleFile`, `validateAttachmentBatch`, `deduplicateFiles`, `buildSafeStoragePath`)
- `src/lib/request-utils.ts` (`sanitizeFileName`, `extractFileMetadata`, `extractAttachmentsMetadata`)
- `src/lib/requests/submission-service.ts` & `src/lib/requests/browser-submission.ts` (storage bucket upload, `request_attachments` record linking, and fallback recovery)

---

## Subtask Mapping

| Task / Subtask | Implementation |
| :--- | :--- |
| **`F3.1.1` (`#50`):** Define supported file types | `SUPPORTED_FILE_EXTENSIONS` (`pdf`, `png`, `jpg`, `jpeg`, `xlsx`, `xls`, `csv`, `docx`, `doc`, `txt`) and `SUPPORTED_MIME_TYPES` in `src/lib/file-validation.ts`. |
| **`F3.1.2` (`#51`):** Validate file size | Enforces `MAX_FILE_SIZE_BYTES` (`10 MB` per file), non-zero size (`> 0` bytes), and `MAX_BATCH_SIZE_BYTES` (`25 MB` total across up to 10 attachments). |
| **`F3.1.3` (`#52`):** Reject unsupported or malformed files | `validateSingleFile()` rejects null/malformed objects, empty names, negative sizes, and unsupported extensions/MIME types. |
| **`F3.2.1` (`#53`):** Implement upload to storage/backend | `uploadAttachment` and `linkAttachment` in `src/lib/requests/browser-submission.ts` and `src/lib/requests/submission-service.ts`. |
| **`F3.2.2` (`#54`):** Generate safe/consistent file names & paths | `sanitizeFileName()` in `src/lib/request-utils.ts` and `buildSafeStoragePath()` (`{userId}/{requestId}/{timestamp}-{safeFileName}`) in `src/lib/file-validation.ts`. |
| **`F3.2.3` (`#55`):** Handle failed or interrupted uploads | Graceful per-file upload/link fallback and structured logging (`attachment.upload_failed`, `attachment.link_failed`, `attachment.storage_unavailable`) in `src/lib/requests/submission-service.ts`. |
| **`F3.2.4` (`#56`):** Prevent accidental duplicate uploads | `deduplicateFiles()` in `src/lib/file-validation.ts` removes duplicate `(safeFileName, size)` entries within the same batch, and `insertWithRetry()` recovers on duplicate request numbers (`23505`). |
| **`F3.3.1` (`#57`):** Verify users are authorized to upload | `createSubmissionService()` and `validateAttachmentBatch(..., { userId })` require a valid authenticated `userId` before any upload or persistence occurs. |
| **`F3.3.2` (`#58`):** Restrict access to uploaded files | Storage paths and `request_attachments` rows are scoped to `{userId}/{requestId}` and guarded by RLS policies. |
| **`F3.3.3` (`#59`):** Prevent unsafe file names & malicious uploads | `sanitizeFileName()` strips path traversal (`../`), slashes, and control characters; `validateSingleFile()` blocks executable/script extensions (`.exe`, `.bat`, `.ps1`, `.sh`, `.js`, etc.), including double extensions (`invoice.pdf.exe`). |
| **`F3.4.1`–`F3.4.3` (`#60`–`#62`):** Verify file handling | Automated unit tests in `src/lib/file-validation.test.ts`, `src/lib/requests/submission-service.test.ts`, and `src/lib/requests/browser-submission.test.ts`. |
