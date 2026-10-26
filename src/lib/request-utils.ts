import { z } from "zod";
import { logger } from "@/lib/logger";
import type { RoutingDecision } from "@/lib/routing/engine";
import type { FundingSource, Priority } from "@/lib/validation/request-schema";

/**
 * F4: Automated Metadata Generation
 *
 * Centralizes request number generation, funding-source reviewer lookup,
 * file-level metadata extraction, business-rule derived metadata, schema
 * validation, and user/record association checks.
 */

export const METADATA_SCHEMA_VERSION = "1.0" as const;

// ---------------------------------------------------------------------------
// F4.1: Define Metadata Requirements (F4.1.1, F4.1.2, F4.1.3)
// ---------------------------------------------------------------------------

/** F4.1.1: Required top-level metadata keys that every stored request must carry. */
export const REQUIRED_METADATA_FIELDS = [
  "schemaVersion",
  "source",
  "automation",
  "requestNumber",
  "userId",
  "requesterEmail",
  "department",
  "submittedAt",
  "attachmentCount",
  "attachments",
  "derived",
  "generationStatus",
] as const;

/** F4.1.2: Metadata fields extracted directly from the uploaded record or File objects. */
export const FILE_EXTRACTED_METADATA_FIELDS = [
  "fileName",
  "safeFileName",
  "extension",
  "contentType",
  "sizeBytes",
  "lastModifiedIso",
] as const;

/** F4.1.3: Metadata fields generated automatically by system clock, identifiers, and business rules. */
export const AUTO_GENERATED_METADATA_FIELDS = [
  "schemaVersion",
  "requestNumber",
  "submittedAt",
  "correlationId",
  "fiscalYear",
  "fiscalQuarter",
  "amountTier",
  "requiresGrantValidation",
  "requiresProgramOversight",
  "isExpedited",
  "totalAttachmentBytes",
] as const;

export type FundingSourceKey = "department" | "research" | "university";

export interface ReviewerAssignment {
  reviewer: string;
  routingKey: FundingSourceKey;
}

export const FUNDING_REVIEWERS: Record<FundingSourceKey, string> = {
  department: "Department Budget Reviewer",
  research: "Research Administration",
  university: "Provost Finance Office",
};

export type AmountTier = "standard" | "elevated" | "executive";

export const fileMetadataSchema = z.object({
  fileName: z.string().min(1).max(255),
  safeFileName: z.string().min(1).max(255),
  extension: z.string().max(32),
  contentType: z.string().min(1).max(128),
  sizeBytes: z.number().int().nonnegative(),
  lastModifiedIso: z.string().datetime({ offset: true }).or(z.string().min(10)),
});

export type FileAttachmentMetadata = z.infer<typeof fileMetadataSchema>;

export const derivedMetadataSchema = z.object({
  fiscalYear: z.string().regex(/^FY\d{4}$/, "Fiscal year must match FYyyyy"),
  fiscalQuarter: z.enum(["Q1", "Q2", "Q3", "Q4"]),
  amountTier: z.enum(["standard", "elevated", "executive"]),
  requiresGrantValidation: z.boolean(),
  requiresProgramOversight: z.boolean(),
  isExpedited: z.boolean(),
  totalAttachmentBytes: z.number().int().nonnegative(),
  attachmentContentTypes: z.array(z.string()),
});

export type DerivedRequestMetadata = z.infer<typeof derivedMetadataSchema>;

export const requestMetadataSchema = z
  .object({
    schemaVersion: z.string().min(1),
    source: z.literal("FinReq portal"),
    automation: z.literal("Power Automate"),
    requestNumber: z.string().regex(/^FR-\d{4}-[A-Z0-9]{6}$/),
    userId: z.string().uuid(),
    requesterEmail: z.string().email(),
    department: z.string().min(2).max(80),
    submittedAt: z.string().min(10),
    correlationId: z.string().min(8),
    attachmentCount: z.number().int().nonnegative(),
    attachments: z.array(fileMetadataSchema),
    derived: derivedMetadataSchema,
    routing: z.custom<RoutingDecision>().optional(),
    generationStatus: z.enum(["complete", "fallback"]),
    generationWarnings: z.array(z.string()).optional(),
  })
  .passthrough()
  .superRefine((meta, ctx) => {
    if (meta.attachmentCount !== meta.attachments.length) {
      ctx.addIssue({
        code: "custom",
        path: ["attachmentCount"],
        message: "attachmentCount must match the number of extracted attachment metadata entries.",
      });
    }
  });

export type RequestMetadata = z.infer<typeof requestMetadataSchema>;

/** Legacy compact metadata type preserved for backwards-compatibility. */
export interface BasicRequestMetadata {
  readonly source: "FinReq portal";
  readonly automation: "Power Automate equivalent";
  readonly attachmentCount: number;
}

// ---------------------------------------------------------------------------
// F4.2: Generate Metadata (F4.2.1, F4.2.2, F4.2.3, F4.2.4)
// ---------------------------------------------------------------------------

/**
 * F4.2.1: Generates a unique, human-readable financial request number in the
 * format `FR-<YEAR>-<6-CHAR-ALPHANUMERIC>`.
 */
export function createRequestNumber(date: Date = new Date()): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError("createRequestNumber received an invalid date");
  }
  const year = date.getFullYear();
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "0");
  return `FR-${year}-${suffix}`;
}

/**
 * Resolves the target reviewer queue for a given funding source.
 */
export function getReviewerForFunding(fundingSource: string): ReviewerAssignment {
  if (!Object.prototype.hasOwnProperty.call(FUNDING_REVIEWERS, fundingSource)) {
    throw new TypeError(`Unknown funding source "${fundingSource}"`);
  }
  const key = fundingSource as FundingSourceKey;
  return {
    reviewer: FUNDING_REVIEWERS[key],
    routingKey: key,
  };
}

/**
 * Builds the basic metadata payload attached to a newly submitted financial request.
 * Throws if `attachmentCount` is negative or non-finite.
 */
export function buildRequestMetadata(attachmentCount: number): BasicRequestMetadata {
  if (typeof attachmentCount !== "number" || !Number.isFinite(attachmentCount) || attachmentCount < 0) {
    throw new RangeError("attachmentCount must be a non-negative finite number");
  }
  return Object.freeze({
    source: "FinReq portal",
    automation: "Power Automate equivalent",
    attachmentCount: Math.floor(attachmentCount),
  });
}

/** Sanitizes an uploaded filename so path traversal and control characters are removed. */
export function sanitizeFileName(rawName: string | undefined | null): string {
  const base = String(rawName ?? "")
    .split(/[\\/]/)
    .pop()
    ?.trim() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "attachment.bin";
  }
  return cleaned.slice(0, 255);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
};

export type FileLike = {
  name?: string;
  size?: number;
  type?: string;
  lastModified?: number;
};

/**
 * F4.2.3: Extracts structured metadata directly from an uploaded File object.
 * Handles missing or partial browser File fields safely.
 */
export function extractFileMetadata(
  file: FileLike | null | undefined,
  fallbackNow: Date = new Date(),
): FileAttachmentMetadata {
  const rawName = typeof file?.name === "string" && file.name.trim().length > 0 ? file.name.trim() : "unnamed-attachment";
  const safeFileName = sanitizeFileName(rawName);
  const dotIndex = safeFileName.lastIndexOf(".");
  const extension = dotIndex > 0 && dotIndex < safeFileName.length - 1
    ? safeFileName.slice(dotIndex + 1).toLowerCase().slice(0, 32)
    : "";

  const rawType = typeof file?.type === "string" ? file.type.trim().toLowerCase() : "";
  const contentType = rawType || MIME_BY_EXTENSION[extension] || "application/octet-stream";

  const rawSize = typeof file?.size === "number" && Number.isFinite(file.size) ? Math.floor(file.size) : 0;
  const sizeBytes = Math.max(0, rawSize);

  const lastModMs =
    typeof file?.lastModified === "number" && Number.isFinite(file.lastModified) && file.lastModified > 0
      ? file.lastModified
      : fallbackNow.getTime();

  return {
    fileName: rawName.slice(0, 255),
    safeFileName,
    extension,
    contentType,
    sizeBytes,
    lastModifiedIso: new Date(lastModMs).toISOString(),
  };
}

/** F4.2.3: Extracts metadata for a list of uploaded files. */
export function extractAttachmentsMetadata(
  files: readonly (FileLike | null | undefined)[] | null | undefined,
  fallbackNow: Date = new Date(),
): FileAttachmentMetadata[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f): f is FileLike => f !== null && f !== undefined && typeof f === "object")
    .map((f) => extractFileMetadata(f, fallbackNow));
}

/**
 * F4.2.4: Computes Howard University's fiscal year (`FYyyyy`) and fiscal quarter (`Q1`–`Q4`).
 * Howard University's fiscal year begins July 1 (e.g. July 2026 is FY2027 Q1).
 */
export function deriveFiscalPeriod(date: Date = new Date()): {
  fiscalYear: string;
  fiscalQuarter: "Q1" | "Q2" | "Q3" | "Q4";
} {
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const month = validDate.getUTCMonth(); // 0 = Jan, 6 = Jul
  const calendarYear = validDate.getUTCFullYear();
  const fyYear = month >= 6 ? calendarYear + 1 : calendarYear;

  let fiscalQuarter: "Q1" | "Q2" | "Q3" | "Q4";
  if (month >= 6 && month <= 8) {
    fiscalQuarter = "Q1"; // Jul - Sep
  } else if (month >= 9 && month <= 11) {
    fiscalQuarter = "Q2"; // Oct - Dec
  } else if (month >= 0 && month <= 2) {
    fiscalQuarter = "Q3"; // Jan - Mar
  } else {
    fiscalQuarter = "Q4"; // Apr - Jun
  }

  return {
    fiscalYear: `FY${fyYear}`,
    fiscalQuarter,
  };
}

/**
 * F4.2.4: Classifies the dollar amount into a business-rule tier matching F8 routing thresholds:
 * - `standard`: < $10,000
 * - `elevated`: $10,000 – $49,999.99 (triggers Senior Finance Review)
 * - `executive`: >= $50,000 (triggers CFO Office Sign-off)
 */
export function deriveAmountTier(amount: number): AmountTier {
  if (!Number.isFinite(amount) || amount < 10_000) return "standard";
  if (amount < 50_000) return "elevated";
  return "executive";
}

export type GenerateDerivedInput = {
  amount: number;
  fundingSource: FundingSource;
  priority: Priority;
  neededBy?: string;
  attachments?: readonly FileAttachmentMetadata[];
  routing?: RoutingDecision | null;
  now?: Date;
};

/**
 * F4.2.4: Generates derived metadata fields from request attributes and attachments.
 */
export function generateDerivedMetadata(input: GenerateDerivedInput): DerivedRequestMetadata {
  const now = input.now ?? new Date();
  const { fiscalYear, fiscalQuarter } = deriveFiscalPeriod(now);
  const amountTier = deriveAmountTier(input.amount);
  const attachments = input.attachments ?? [];

  const totalAttachmentBytes = attachments.reduce(
    (sum, item) => sum + (Number.isFinite(item.sizeBytes) ? Math.max(0, item.sizeBytes) : 0),
    0,
  );
  const attachmentContentTypes = Array.from(
    new Set(attachments.map((a) => a.contentType).filter(Boolean)),
  );

  const isExpedited =
    input.routing?.flags.includes("expedited") ?? input.priority === "high";

  return {
    fiscalYear,
    fiscalQuarter,
    amountTier,
    requiresGrantValidation: input.fundingSource === "research",
    requiresProgramOversight: input.fundingSource === "university",
    isExpedited,
    totalAttachmentBytes,
    attachmentContentTypes,
  };
}

export type GenerateMetadataParams = {
  userId: string;
  requestNumber: string;
  requesterEmail: string;
  department: string;
  fundingSource: FundingSource;
  amount: number;
  priority: Priority;
  neededBy?: string;
  files?: readonly (FileLike | null | undefined)[];
  routing?: RoutingDecision;
  now?: Date;
  correlationId?: string;
};

function generateCorrelationId(now: Date): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `meta-${now.getTime().toString(36)}-${rand}`;
}

/**
 * F4.2.1 & F4.2.2: Generates the full, schema-compliant `RequestMetadata` object
 * and associates it with the submitting user and request number.
 */
export function generateRequestMetadata(params: GenerateMetadataParams): RequestMetadata {
  const now = params.now && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
  const attachments = extractAttachmentsMetadata(params.files ?? [], now);
  const derived = generateDerivedMetadata({
    amount: params.amount,
    fundingSource: params.fundingSource,
    priority: params.priority,
    neededBy: params.neededBy,
    attachments,
    routing: params.routing,
    now,
  });

  const metadata: RequestMetadata = {
    schemaVersion: METADATA_SCHEMA_VERSION,
    source: "FinReq portal",
    automation: "Power Automate",
    requestNumber: params.requestNumber,
    userId: params.userId,
    requesterEmail: params.requesterEmail.trim().toLowerCase(),
    department: params.department.trim(),
    submittedAt: now.toISOString(),
    correlationId: params.correlationId ?? generateCorrelationId(now),
    attachmentCount: attachments.length,
    attachments,
    derived,
    ...(params.routing ? { routing: params.routing } : {}),
    generationStatus: "complete",
  };

  const validation = validateRequestMetadata(metadata);
  if (!validation.ok) {
    throw new Error(`Invalid request metadata: ${validation.errors.join("; ")}`);
  }

  return validation.data;
}

// ---------------------------------------------------------------------------
// F4.3: Validate & Store Metadata (F4.3.1, F4.3.2, F4.3.3)
// ---------------------------------------------------------------------------

export type MetadataValidationResult =
  | { ok: true; data: RequestMetadata }
  | { ok: false; errors: string[] };

/**
 * F4.3.1: Validates generated metadata against `requestMetadataSchema` before saving.
 */
export function validateRequestMetadata(candidate: unknown): MetadataValidationResult {
  const parsed = requestMetadataSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "metadata"}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

const FALLBACK_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * F4.3.3: Safe wrapper around `generateRequestMetadata` that handles missing,
 * corrupt, or failed metadata inputs without crashing request submission.
 * Logs structured warnings via F5's logger and returns a schema-valid fallback.
 */
export function generateRequestMetadataSafe(
  params: Partial<GenerateMetadataParams> & {
    userId?: string;
    requestNumber?: string;
  },
): RequestMetadata {
  const now = params.now && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
  const warnings: string[] = [];

  try {
    if (
      params.userId &&
      params.requestNumber &&
      params.requesterEmail &&
      params.department &&
      params.fundingSource &&
      typeof params.amount === "number" &&
      params.priority
    ) {
      return generateRequestMetadata({
        userId: params.userId,
        requestNumber: params.requestNumber,
        requesterEmail: params.requesterEmail,
        department: params.department,
        fundingSource: params.fundingSource,
        amount: params.amount,
        priority: params.priority,
        neededBy: params.neededBy,
        files: params.files,
        routing: params.routing,
        now,
        correlationId: params.correlationId,
      });
    }
    warnings.push("One or more required source fields were missing; applied fallback defaults.");
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Primary metadata generation failed.");
    logger.warn("metadata.generation_fallback", {
      requestNumber: params.requestNumber,
      userId: params.userId,
      error,
    });
  }

  const safeUserId = z.string().uuid().safeParse(params.userId).success
    ? params.userId!
    : FALLBACK_UUID;
  const safeRequestNumber =
    params.requestNumber && /^FR-\d{4}-[A-Z0-9]{6}$/.test(params.requestNumber)
      ? params.requestNumber
      : createRequestNumber(now);
  const safeEmail =
    params.requesterEmail && z.string().email().safeParse(params.requesterEmail.trim()).success
      ? params.requesterEmail.trim().toLowerCase()
      : "unknown@howard.edu";
  const safeDepartment =
    params.department && params.department.trim().length >= 2
      ? params.department.trim().slice(0, 80)
      : "Unassigned Department";
  const safeFunding: FundingSource =
    params.fundingSource === "department" ||
    params.fundingSource === "research" ||
    params.fundingSource === "university"
      ? params.fundingSource
      : "university";
  const safePriority: Priority =
    params.priority === "low" || params.priority === "medium" || params.priority === "high"
      ? params.priority
      : "medium";
  const safeAmount =
    typeof params.amount === "number" && Number.isFinite(params.amount) && params.amount > 0
      ? params.amount
      : 0.01;

  const attachments = extractAttachmentsMetadata(params.files ?? [], now);
  const derived = generateDerivedMetadata({
    amount: safeAmount,
    fundingSource: safeFunding,
    priority: safePriority,
    neededBy: params.neededBy,
    attachments,
    routing: params.routing,
    now,
  });

  logger.warn("metadata.generated_with_fallback", {
    requestNumber: safeRequestNumber,
    userId: safeUserId,
    warnings,
  });

  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    source: "FinReq portal",
    automation: "Power Automate",
    requestNumber: safeRequestNumber,
    userId: safeUserId,
    requesterEmail: safeEmail,
    department: safeDepartment,
    submittedAt: now.toISOString(),
    correlationId: params.correlationId ?? generateCorrelationId(now),
    attachmentCount: attachments.length,
    attachments,
    derived,
    ...(params.routing ? { routing: params.routing } : {}),
    generationStatus: "fallback",
    generationWarnings: warnings,
  };
}

// ---------------------------------------------------------------------------
// F4.4: Verify Metadata Generation & Record Linkage (F4.4.3)
// ---------------------------------------------------------------------------

export type RecordAssociationTarget = {
  userId: string;
  requestNumber: string;
  requesterEmail?: string;
  department?: string;
  attachmentCount?: number;
};

export type AssociationCheckResult = {
  linked: boolean;
  mismatches: string[];
};

/**
 * F4.4.3: Verifies that a metadata object is validly structured and remains
 * linked to the exact user, request number, email, department, and attachment
 * count of its parent `financial_requests` record.
 */
export function verifyMetadataAssociation(
  metadata: Record<string, unknown> | null | undefined,
  record: RecordAssociationTarget,
): AssociationCheckResult {
  const mismatches: string[] = [];
  if (!metadata || typeof metadata !== "object") {
    return { linked: false, mismatches: ["metadata is missing or not an object"] };
  }

  if (metadata.userId !== record.userId) {
    mismatches.push(`userId mismatch: metadata has "${String(metadata.userId)}", record has "${record.userId}"`);
  }
  if (metadata.requestNumber !== record.requestNumber) {
    mismatches.push(
      `requestNumber mismatch: metadata has "${String(metadata.requestNumber)}", record has "${record.requestNumber}"`,
    );
  }
  if (
    record.requesterEmail &&
    typeof metadata.requesterEmail === "string" &&
    metadata.requesterEmail.toLowerCase() !== record.requesterEmail.trim().toLowerCase()
  ) {
    mismatches.push(
      `requesterEmail mismatch: metadata has "${metadata.requesterEmail}", record has "${record.requesterEmail}"`,
    );
  }
  if (
    record.department &&
    typeof metadata.department === "string" &&
    metadata.department.trim() !== record.department.trim()
  ) {
    mismatches.push(
      `department mismatch: metadata has "${metadata.department}", record has "${record.department}"`,
    );
  }
  if (
    typeof record.attachmentCount === "number" &&
    typeof metadata.attachmentCount === "number" &&
    metadata.attachmentCount !== record.attachmentCount
  ) {
    mismatches.push(
      `attachmentCount mismatch: metadata has ${metadata.attachmentCount}, record has ${record.attachmentCount}`,
    );
  }

  return {
    linked: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Reads structured F4 metadata from a database row's `metadata` column.
 * Returns null for legacy rows created before F4.
 */
export function readRequestMetadata(
  raw: Record<string, unknown> | null | undefined,
): RequestMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = requestMetadataSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
