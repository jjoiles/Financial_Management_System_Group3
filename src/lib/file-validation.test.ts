import { describe, expect, it } from "vitest";
import {
  buildSafeStoragePath,
  deduplicateFiles,
  MAX_BATCH_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  SUPPORTED_FILE_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
  validateAttachmentBatch,
  validateSingleFile,
} from "./file-validation";

describe("F3: File Handling, Validation & Security (F3.1–F3.4)", () => {
  describe("F3.1 & F3.4.1: Supported file types and valid uploads", () => {
    it("exposes supported extensions and MIME types (F3.1.1)", () => {
      expect(SUPPORTED_FILE_EXTENSIONS).toContain("pdf");
      expect(SUPPORTED_FILE_EXTENSIONS).toContain("xlsx");
      expect(SUPPORTED_FILE_EXTENSIONS).toContain("png");
      expect(SUPPORTED_MIME_TYPES).toContain("application/pdf");
      expect(SUPPORTED_MIME_TYPES).toContain("text/csv");
    });

    it("accepts valid PDF, spreadsheet, and image attachments (F3.4.1)", () => {
      const files = [
        { name: "vendor-quote.pdf", size: 245_000, type: "application/pdf" },
        { name: "budget-breakdown.xlsx", size: 88_000, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        { name: "receipt.png", size: 120_000, type: "image/png" },
      ];

      const result = validateAttachmentBatch(files, {
        userId: "11111111-2222-4333-8444-555555555555",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.validFiles).toHaveLength(3);
        expect(result.deduplicatedCount).toBe(0);
        expect(result.totalBytes).toBe(453_000);
      }
    });
  });

  describe("F3.1.2, F3.1.3 & F3.4.2: Invalid file types, sizes, and malformed files", () => {
    it("rejects unsupported file extensions and MIME types (F3.1.3, F3.4.2)", () => {
      const issue = validateSingleFile({
        name: "archive.zip",
        size: 1024,
        type: "application/zip",
      });
      expect(issue).not.toBeNull();
      expect(issue?.code).toBe("UNSUPPORTED_TYPE");
    });

    it("rejects empty (0-byte) files and files exceeding 10 MB (F3.1.2, F3.4.2)", () => {
      const emptyIssue = validateSingleFile({
        name: "empty.pdf",
        size: 0,
        type: "application/pdf",
      });
      expect(emptyIssue?.code).toBe("EMPTY_FILE");

      const oversizedIssue = validateSingleFile({
        name: "huge-scan.pdf",
        size: MAX_FILE_SIZE_BYTES + 1,
        type: "application/pdf",
      });
      expect(oversizedIssue?.code).toBe("FILE_TOO_LARGE");
    });

    it("rejects malformed file objects with missing names or negative sizes (F3.1.3)", () => {
      expect(validateSingleFile(null)?.code).toBe("MALFORMED_FILE");
      expect(validateSingleFile({ name: "   ", size: 100 })?.code).toBe("MALFORMED_FILE");
      expect(
        validateSingleFile({ name: "invoice.pdf", size: -50, type: "application/pdf" })?.code,
      ).toBe("MALFORMED_FILE");
    });

    it("rejects batches whose total size exceeds 25 MB (F3.1.2, F3.4.2)", () => {
      const nineMb = 9 * 1024 * 1024;
      const result = validateAttachmentBatch([
        { name: "part1.pdf", size: nineMb, type: "application/pdf" },
        { name: "part2.pdf", size: nineMb, type: "application/pdf" },
        { name: "part3.pdf", size: nineMb, type: "application/pdf" },
      ]);
      expect(nineMb * 3).toBeGreaterThan(MAX_BATCH_SIZE_BYTES);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]?.code).toBe("BATCH_TOO_LARGE");
      }
    });
  });

  describe("F3.2.2, F3.2.4 & F3.3: Safe paths, duplicate prevention, and security", () => {
    it("deduplicates accidental duplicate files in the same batch (F3.2.4)", () => {
      const files = [
        { name: "Invoice.pdf", size: 4096, type: "application/pdf" },
        { name: "invoice.pdf", size: 4096, type: "application/pdf" },
        { name: "Invoice.pdf", size: 8192, type: "application/pdf" },
      ];
      const { unique, removedCount } = deduplicateFiles(files);
      expect(unique).toHaveLength(2);
      expect(removedCount).toBe(1);
    });

    it("blocks unauthorized uploads when userId is missing (F3.3.1)", () => {
      const result = validateAttachmentBatch(
        [{ name: "quote.pdf", size: 1024, type: "application/pdf" }],
        { userId: null },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]?.code).toBe("UNAUTHORIZED_UPLOAD");
      }
    });

    it("blocks malicious executable or double-extension files (F3.3.3)", () => {
      const issue = validateSingleFile({
        name: "invoice.pdf.exe",
        size: 2048,
        type: "application/pdf",
      });
      expect(issue?.code).toBe("MALICIOUS_FILE");
    });

    it("generates user- and request-scoped safe storage paths stripping traversal sequences (F3.2.2, F3.3.2, F3.3.3)", () => {
      const path = buildSafeStoragePath({
        userId: "user-123",
        requestId: "req-456",
        fileName: "../../etc/passwd/../../Receipt #1 (Final).pdf",
        timestampMs: 1700000000000,
      });
      expect(path).toBe("user-123/req-456/1700000000000-Receipt_1_Final_.pdf");
      expect(path).not.toContain("..");
    });
  });
});
