import { describe, it, expect } from "vitest";
import {
  AUTO_GENERATED_METADATA_FIELDS,
  FILE_EXTRACTED_METADATA_FIELDS,
  METADATA_SCHEMA_VERSION,
  REQUIRED_METADATA_FIELDS,
  buildRequestMetadata,
  createRequestNumber,
  deriveAmountTier,
  deriveFiscalPeriod,
  extractAttachmentsMetadata,
  extractFileMetadata,
  generateDerivedMetadata,
  generateRequestMetadata,
  generateRequestMetadataSafe,
  getReviewerForFunding,
  readRequestMetadata,
  sanitizeFileName,
  validateRequestMetadata,
  verifyMetadataAssociation,
} from "./request-utils";

const TEST_USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555";

// ---------------------------------------------------------------------------
// createRequestNumber (F4.2.1)
// ---------------------------------------------------------------------------

describe("createRequestNumber", () => {
  it("returns a string matching the FR-YYYY-XXXXXX format", () => {
    const result = createRequestNumber();
    expect(result).toMatch(/^FR-\d{4}-[A-Z0-9]{6}$/);
  });

  it("uses the year from the provided date", () => {
    const result = createRequestNumber(new Date("2025-06-15"));
    expect(result).toMatch(/^FR-2025-[A-Z0-9]{6}$/);
  });

  it("defaults to the current year when no date is given", () => {
    const currentYear = new Date().getFullYear();
    const result = createRequestNumber();
    expect(result).toContain(`FR-${currentYear}-`);
  });

  it("generates unique suffixes on consecutive calls", () => {
    const results = new Set(Array.from({ length: 20 }, () => createRequestNumber()));
    // With 36^6 ≈ 2 billion possibilities, 20 calls should never collide
    expect(results.size).toBe(20);
  });

  it("throws RangeError for an invalid date", () => {
    expect(() => createRequestNumber(new Date("invalid"))).toThrow(RangeError);
    expect(() => createRequestNumber(new Date("invalid"))).toThrow("invalid date");
  });
});

// ---------------------------------------------------------------------------
// getReviewerForFunding
// ---------------------------------------------------------------------------

describe("getReviewerForFunding", () => {
  it('returns "Department Budget Reviewer" for department funding', () => {
    const result = getReviewerForFunding("department");
    expect(result.reviewer).toBe("Department Budget Reviewer");
    expect(result.routingKey).toBe("department");
  });

  it('returns "Research Administration" for research funding', () => {
    const result = getReviewerForFunding("research");
    expect(result.reviewer).toBe("Research Administration");
    expect(result.routingKey).toBe("research");
  });

  it('returns "Provost Finance Office" for university funding', () => {
    const result = getReviewerForFunding("university");
    expect(result.reviewer).toBe("Provost Finance Office");
    expect(result.routingKey).toBe("university");
  });

  it("throws TypeError for an unrecognised funding source", () => {
    expect(() => getReviewerForFunding("external")).toThrow(TypeError);
    expect(() => getReviewerForFunding("external")).toThrow('Unknown funding source "external"');
  });

  it("throws TypeError for an empty string", () => {
    expect(() => getReviewerForFunding("")).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// buildRequestMetadata
// ---------------------------------------------------------------------------

describe("buildRequestMetadata", () => {
  it("returns the correct metadata shape with zero attachments", () => {
    const result = buildRequestMetadata(0);
    expect(result).toEqual({
      source: "FinReq portal",
      automation: "Power Automate equivalent",
      attachmentCount: 0,
    });
  });

  it("returns the correct metadata with a positive attachment count", () => {
    const result = buildRequestMetadata(5);
    expect(result.attachmentCount).toBe(5);
    expect(result.source).toBe("FinReq portal");
  });

  it("floors fractional attachment counts", () => {
    const result = buildRequestMetadata(3.7);
    expect(result.attachmentCount).toBe(3);
  });

  it("returns a frozen object to prevent accidental mutation", () => {
    const result = buildRequestMetadata(1);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("throws RangeError for a negative count", () => {
    expect(() => buildRequestMetadata(-1)).toThrow(RangeError);
    expect(() => buildRequestMetadata(-1)).toThrow("non-negative");
  });

  it("throws RangeError for NaN", () => {
    expect(() => buildRequestMetadata(NaN)).toThrow(RangeError);
  });

  it("throws RangeError for Infinity", () => {
    expect(() => buildRequestMetadata(Infinity)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// F4.1 & F4.2: File Metadata Extraction & Business-Rule Derived Metadata
// ---------------------------------------------------------------------------

describe("F4.1 & F4.2: Metadata requirements, file extraction, and derived rules", () => {
  it("defines required, file-extracted, and auto-generated metadata field lists (F4.1.1-F4.1.3)", () => {
    expect(REQUIRED_METADATA_FIELDS).toContain("requestNumber");
    expect(REQUIRED_METADATA_FIELDS).toContain("userId");
    expect(REQUIRED_METADATA_FIELDS).toContain("derived");
    expect(FILE_EXTRACTED_METADATA_FIELDS).toEqual([
      "fileName",
      "safeFileName",
      "extension",
      "contentType",
      "sizeBytes",
      "lastModifiedIso",
    ]);
    expect(AUTO_GENERATED_METADATA_FIELDS).toContain("fiscalYear");
    expect(AUTO_GENERATED_METADATA_FIELDS).toContain("amountTier");
  });

  it("extracts metadata directly from uploaded files and sanitizes paths (F4.2.3)", () => {
    const fixedDate = new Date("2026-10-16T12:00:00.000Z");
    const file = {
      name: "../invoices/Lab Quote #1 (Final).PDF",
      size: 48_250,
      type: "",
      lastModified: fixedDate.getTime(),
    };

    const extracted = extractFileMetadata(file, fixedDate);
    expect(extracted.fileName).toBe("../invoices/Lab Quote #1 (Final).PDF");
    expect(extracted.safeFileName).toBe("Lab_Quote_1_Final_.PDF");
    expect(extracted.extension).toBe("pdf");
    expect(extracted.contentType).toBe("application/pdf");
    expect(extracted.sizeBytes).toBe(48_250);
    expect(extracted.lastModifiedIso).toBe("2026-10-16T12:00:00.000Z");
  });

  it("computes Howard University fiscal year and quarter starting July 1 (F4.2.4)", () => {
    expect(deriveFiscalPeriod(new Date("2026-07-01T00:00:00Z"))).toEqual({
      fiscalYear: "FY2027",
      fiscalQuarter: "Q1",
    });
    expect(deriveFiscalPeriod(new Date("2026-10-16T00:00:00Z"))).toEqual({
      fiscalYear: "FY2027",
      fiscalQuarter: "Q2",
    });
    expect(deriveFiscalPeriod(new Date("2026-02-15T00:00:00Z"))).toEqual({
      fiscalYear: "FY2026",
      fiscalQuarter: "Q3",
    });
    expect(deriveFiscalPeriod(new Date("2026-05-20T00:00:00Z"))).toEqual({
      fiscalYear: "FY2026",
      fiscalQuarter: "Q4",
    });
  });

  it("derives amount tiers and funding flags according to business rules (F4.2.4)", () => {
    expect(deriveAmountTier(2_500)).toBe("standard");
    expect(deriveAmountTier(10_000)).toBe("elevated");
    expect(deriveAmountTier(75_000)).toBe("executive");

    const derived = generateDerivedMetadata({
      amount: 18_500,
      fundingSource: "research",
      priority: "high",
      now: new Date("2026-10-16T14:00:00Z"),
    });
    expect(derived.fiscalYear).toBe("FY2027");
    expect(derived.fiscalQuarter).toBe("Q2");
    expect(derived.amountTier).toBe("elevated");
    expect(derived.requiresGrantValidation).toBe(true);
    expect(derived.requiresProgramOversight).toBe(false);
    expect(derived.isExpedited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F4.4.1: Test metadata generation for normal records
// ---------------------------------------------------------------------------

describe("F4.4.1: Normal record metadata generation", () => {
  it("generates complete, schema-validated metadata for a normal request with attachments", () => {
    const now = new Date("2026-10-16T15:30:00.000Z");
    const requestNumber = createRequestNumber(now);
    const files = [
      { name: "vendor_quote.pdf", size: 120_000, type: "application/pdf", lastModified: now.getTime() },
      { name: "budget.xlsx", size: 35_400, type: "", lastModified: now.getTime() },
    ];

    const metadata = generateRequestMetadata({
      userId: TEST_USER_ID,
      requestNumber,
      requesterEmail: "Ada.Lovelace@howard.edu",
      department: "Computer Science",
      fundingSource: "research",
      amount: 24_500,
      priority: "medium",
      neededBy: "2026-11-15",
      files,
      now,
    });

    expect(metadata.schemaVersion).toBe(METADATA_SCHEMA_VERSION);
    expect(metadata.source).toBe("FinReq portal");
    expect(metadata.automation).toBe("Power Automate");
    expect(metadata.requestNumber).toBe(requestNumber);
    expect(metadata.userId).toBe(TEST_USER_ID);
    expect(metadata.requesterEmail).toBe("ada.lovelace@howard.edu");
    expect(metadata.department).toBe("Computer Science");
    expect(metadata.submittedAt).toBe("2026-10-16T15:30:00.000Z");
    expect(metadata.attachmentCount).toBe(2);
    expect(metadata.derived.totalAttachmentBytes).toBe(155_400);
    expect(metadata.derived.amountTier).toBe("elevated");
    expect(metadata.derived.requiresGrantValidation).toBe(true);
    expect(metadata.generationStatus).toBe("complete");

    const check = validateRequestMetadata(metadata);
    expect(check.ok).toBe(true);
    expect(readRequestMetadata(metadata)).toEqual(metadata);
  });
});

// ---------------------------------------------------------------------------
// F4.4.2: Test missing or invalid source information & fallback handling
// ---------------------------------------------------------------------------

describe("F4.4.2: Missing or invalid source information and safe fallback", () => {
  it("handles missing or malformed file attributes safely without throwing", () => {
    const fallbackNow = new Date("2026-10-16T12:00:00.000Z");
    const attachments = extractAttachmentsMetadata(
      [
        null,
        undefined,
        { name: "", size: -500, type: "", lastModified: NaN },
        { name: "../../..//", size: Number.NaN },
      ],
      fallbackNow,
    );

    expect(attachments).toHaveLength(2);
    expect(attachments[0].fileName).toBe("unnamed-attachment");
    expect(attachments[0].sizeBytes).toBe(0);
    expect(attachments[0].contentType).toBe("application/octet-stream");
    expect(attachments[1].safeFileName).toBe("attachment.bin");
    expect( sanitizeFileName("..\\..\\secret.pdf")).toBe("secret.pdf");
  });

  it("rejects tampered or incomplete metadata in validateRequestMetadata (F4.3.1)", () => {
    const result = validateRequestMetadata({
      schemaVersion: "1.0",
      source: "FinReq portal",
      automation: "Power Automate",
      requestNumber: "INVALID-ID",
      userId: "not-a-uuid",
      attachmentCount: 3,
      attachments: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("requestNumber"))).toBe(true);
      expect(result.errors.some((e) => e.includes("userId"))).toBe(true);
    }
  });

  it("produces a valid fallback metadata object when source fields are missing or invalid (F4.3.3)", () => {
    const fallback = generateRequestMetadataSafe({
      userId: "malformed-user-id",
      requestNumber: "bad-number",
      requesterEmail: "not-an-email",
      department: "",
      amount: Number.NaN,
    });

    expect(fallback.generationStatus).toBe("fallback");
    expect(fallback.generationWarnings?.length).toBeGreaterThan(0);
    expect(fallback.requestNumber).toMatch(/^FR-\d{4}-[A-Z0-9]{6}$/);
    expect(validateRequestMetadata(fallback).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F4.4.3: Verify metadata remains linked to the correct record
// ---------------------------------------------------------------------------

describe("F4.4.3: Verify metadata association with user and request record", () => {
  it("confirms linkage when metadata matches the parent record's userId, requestNumber, email, and attachmentCount", () => {
    const requestNumber = "FR-2026-AB12CD";
    const metadata = generateRequestMetadata({
      userId: TEST_USER_ID,
      requestNumber,
      requesterEmail: "researcher@howard.edu",
      department: "Biology",
      fundingSource: "department",
      amount: 1_200,
      priority: "low",
      files: [{ name: "receipt.png", size: 2048, type: "image/png" }],
    });

    const verification = verifyMetadataAssociation(metadata, {
      userId: TEST_USER_ID,
      requestNumber,
      requesterEmail: "Researcher@howard.edu",
      department: "Biology",
      attachmentCount: 1,
    });

    expect(verification.linked).toBe(true);
    expect(verification.mismatches).toEqual([]);
  });

  it("detects mislinked userId, requestNumber, email, department, or attachmentCount", () => {
    const requestNumber = "FR-2026-AB12CD";
    const metadata = generateRequestMetadata({
      userId: TEST_USER_ID,
      requestNumber,
      requesterEmail: "researcher@howard.edu",
      department: "Biology",
      fundingSource: "department",
      amount: 1_200,
      priority: "low",
      files: [],
    });

    const checkWrongUser = verifyMetadataAssociation(metadata, {
      userId: OTHER_USER_ID,
      requestNumber: "FR-2026-999999",
      requesterEmail: "other@howard.edu",
      department: "Chemistry",
      attachmentCount: 2,
    });

    expect(checkWrongUser.linked).toBe(false);
    expect(checkWrongUser.mismatches).toHaveLength(5);
    expect(checkWrongUser.mismatches[0]).toContain("userId mismatch");
    expect(checkWrongUser.mismatches[1]).toContain("requestNumber mismatch");
  });
});
