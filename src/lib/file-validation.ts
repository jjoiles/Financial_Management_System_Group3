import { sanitizeFileName, type FileLike } from "./request-utils";

/**
 * F3: File Handling & Uploads (F3.1, F3.2, F3.3, F3.4)
 *
 * Centralizes supported file types/extensions (F3.1.1), file size limits (F3.1.2),
 * malformed/unsupported file rejection (F3.1.3), safe storage path generation (F3.2.2),
 * duplicate file detection (F3.2.4), and upload authorization / malicious path checks (F3.3).
 */

/** F3.1.1: Supported attachment file extensions for financial requests. */
export const SUPPORTED_FILE_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "xlsx",
  "xls",
  "csv",
  "docx",
  "doc",
  "txt",
] as const;

export type SupportedFileExtension = (typeof SUPPORTED_FILE_EXTENSIONS)[number];

/** F3.1.1: Supported MIME types for financial request attachments. */
export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
] as const;

/** F3.1.2: Per-file size limit (10 MB) and total batch size limit (25 MB). */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_BATCH_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_ATTACHMENTS_PER_REQUEST = 10;

const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "bat",
  "cmd",
  "sh",
  "ps1",
  "js",
  "mjs",
  "cjs",
  "vbs",
  "scr",
  "msi",
  "dll",
  "php",
  "py",
]);

const SUPPORTED_EXT_SET = new Set<string>(SUPPORTED_FILE_EXTENSIONS);
const SUPPORTED_MIME_SET = new Set<string>(SUPPORTED_MIME_TYPES);

export type FileValidationIssue = {
  fileName: string;
  code:
    | "MALFORMED_FILE"
    | "UNSUPPORTED_TYPE"
    | "MALICIOUS_FILE"
    | "EMPTY_FILE"
    | "FILE_TOO_LARGE"
    | "BATCH_TOO_LARGE"
    | "TOO_MANY_FILES"
    | "UNAUTHORIZED_UPLOAD";
  message: string;
};

export type FileValidationResult =
  | {
      ok: true;
      validFiles: FileLike[];
      deduplicatedCount: number;
      totalBytes: number;
    }
  | {
      ok: false;
      issues: FileValidationIssue[];
    };

function getExtension(name: string): string {
  const safe = sanitizeFileName(name);
  const dotIdx = safe.lastIndexOf(".");
  return dotIdx > 0 && dotIdx < safe.length - 1 ? safe.slice(dotIdx + 1).toLowerCase() : "";
}

/**
 * F3.1.1, F3.1.2, F3.1.3 & F3.3.3: Validates a single candidate file for
 * structural integrity, supported extension/MIME type, non-malicious filename,
 * and size bounds.
 */
export function validateSingleFile(file: unknown): FileValidationIssue | null {
  if (!file || typeof file !== "object") {
    return {
      fileName: "unknown",
      code: "MALFORMED_FILE",
      message: "File entry is missing or malformed.",
    };
  }

  const candidate = file as Partial<FileLike>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    return {
      fileName: "unnamed",
      code: "MALFORMED_FILE",
      message: "File must have a valid non-empty name.",
    };
  }

  const rawName = candidate.name.trim();
  const ext = getExtension(rawName);

  // Check for double extensions or executable extensions (F3.3.3)
  const parts = rawName.toLowerCase().split(".").slice(1);
  if (parts.some((p) => BLOCKED_EXTENSIONS.has(p))) {
    return {
      fileName: rawName,
      code: "MALICIOUS_FILE",
      message: `Executable or script file "${rawName}" is not permitted.`,
    };
  }

  const mime = typeof candidate.type === "string" ? candidate.type.trim().toLowerCase() : "";
  const extSupported = ext.length > 0 && SUPPORTED_EXT_SET.has(ext);
  const mimeSupported = mime.length > 0 && SUPPORTED_MIME_SET.has(mime);

  if (!extSupported && !mimeSupported) {
    return {
      fileName: rawName,
      code: "UNSUPPORTED_TYPE",
      message: `Unsupported file type for "${rawName}". Allowed types: PDF, PNG, JPG, XLSX, CSV, DOCX, TXT.`,
    };
  }

  if (typeof candidate.size !== "number" || !Number.isFinite(candidate.size) || candidate.size < 0) {
    return {
      fileName: rawName,
      code: "MALFORMED_FILE",
      message: `File "${rawName}" has an invalid file size.`,
    };
  }

  if (candidate.size === 0) {
    return {
      fileName: rawName,
      code: "EMPTY_FILE",
      message: `File "${rawName}" is empty (0 bytes).`,
    };
  }

  if (candidate.size > MAX_FILE_SIZE_BYTES) {
    return {
      fileName: rawName,
      code: "FILE_TOO_LARGE",
      message: `File "${rawName}" exceeds the 10 MB maximum file size limit.`,
    };
  }

  return null;
}

/**
 * F3.2.4: Deduplicates identical files in the same upload batch by normalized
 * name + byte size so accidental double selections are prevented.
 */
export function deduplicateFiles<T extends FileLike>(files: readonly T[]): {
  unique: T[];
  removedCount: number;
} {
  const seen = new Set<string>();
  const unique: T[] = [];
  let removedCount = 0;

  for (const file of files) {
    if (!file || typeof file.name !== "string") continue;
    const key = `${sanitizeFileName(file.name).toLowerCase()}::${file.size ?? -1}`;
    if (seen.has(key)) {
      removedCount += 1;
      continue;
    }
    seen.add(key);
    unique.push(file);
  }

  return { unique, removedCount };
}

/**
 * F3.2.2 & F3.3.2: Generates a safe, user- and request-scoped storage path
 * that prevents path traversal and cross-user collisions.
 */
export function buildSafeStoragePath(params: {
  userId: string;
  requestId: string;
  fileName: string;
  timestampMs: number;
}): string {
  const cleanUser = params.userId.replace(/[^a-zA-Z0-9-]/g, "");
  const cleanRequest = params.requestId.replace(/[^a-zA-Z0-9-_]/g, "");
  const safeName = sanitizeFileName(params.fileName);
  if (!cleanUser || !cleanRequest) {
    throw new Error("Authorized userId and requestId are required to build a storage path.");
  }
  return `${cleanUser}/${cleanRequest}/${Math.trunc(params.timestampMs)}-${safeName}`;
}

/**
 * F3.1, F3.2.4 & F3.3.1: Validates an entire batch of uploaded files, verifying
 * user authorization, deduplicating accidental repeats, and checking individual
 * and aggregate size/type constraints.
 */
export function validateAttachmentBatch(
  files: readonly unknown[],
  options?: { userId?: string | null },
): FileValidationResult {
  if (options && "userId" in options && (!options.userId || !options.userId.trim())) {
    return {
      ok: false,
      issues: [
        {
          fileName: "batch",
          code: "UNAUTHORIZED_UPLOAD",
          message: "You must be signed in to upload financial request attachments.",
        },
      ],
    };
  }

  if (!Array.isArray(files) || files.length === 0) {
    return { ok: true, validFiles: [], deduplicatedCount: 0, totalBytes: 0 };
  }

  const issues: FileValidationIssue[] = [];
  const structurallyValid: FileLike[] = [];

  for (const item of files) {
    const issue = validateSingleFile(item);
    if (issue) {
      issues.push(issue);
    } else {
      structurallyValid.push(item as FileLike);
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const { unique, removedCount } = deduplicateFiles(structurallyValid);

  if (unique.length > MAX_ATTACHMENTS_PER_REQUEST) {
    return {
      ok: false,
      issues: [
        {
          fileName: "batch",
          code: "TOO_MANY_FILES",
          message: `Cannot upload more than ${MAX_ATTACHMENTS_PER_REQUEST} attachments per request.`,
        },
      ],
    };
  }

  const totalBytes = unique.reduce((sum, f) => sum + (f.size ?? 0), 0);
  if (totalBytes > MAX_BATCH_SIZE_BYTES) {
    return {
      ok: false,
      issues: [
        {
          fileName: "batch",
          code: "BATCH_TOO_LARGE",
          message: "Total attachment size exceeds the 25 MB per-request limit.",
        },
      ],
    };
  }

  return {
    ok: true,
    validFiles: unique,
    deduplicatedCount: removedCount,
    totalBytes,
  };
}
