import { describe, expect, it } from "vitest";
import {
  cleanBlock,
  cleanLine,
  hasAtMostTwoDecimals,
  LIMITS,
  requestSchema,
  stripControlChars,
} from "./request-schema";

describe("F2: Input Validation (F2.1, F2.2, F2.3)", () => {
  const validFutureDate = "2027-05-15";

  describe("F2.1 & F2.3.1: Valid request inputs across funding sources", () => {
    it("accepts a valid department-funded request and normalizes email and whitespace (F2.3.1)", () => {
      const parsed = requestSchema.safeParse({
        requesterEmail: "  Faculty.Member@Howard.edu ",
        department: "  Computer   Science ",
        fundingSource: "department",
        amount: "1450.75",
        neededBy: validFutureDate,
        priority: "medium",
        description: "  Lab GPU workstation replacement.\r\nIncludes warranty.  ",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.requesterEmail).toBe("faculty.member@howard.edu");
        expect(parsed.data.department).toBe("Computer Science");
        expect(parsed.data.amount).toBe(1450.75);
        expect(parsed.data.description).toBe(
          "Lab GPU workstation replacement.\nIncludes warranty.",
        );
      }
    });

    it("accepts a valid research-funded request and normalizes PI prefix (F2.3.1)", () => {
      const parsed = requestSchema.safeParse({
        requesterEmail: "researcher@howard.edu",
        department: "Biology",
        fundingSource: "research",
        amount: 25000,
        neededBy: validFutureDate,
        priority: "high",
        description: "Sequencing reagents for NSF grant.",
        grantNumber: "NSF-2026-884",
        principalInvestigator: "Sarah Chen",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.principalInvestigator).toBe("Dr. Sarah Chen");
      }
    });
  });

  describe("F2.1.2, F2.1.3 & F2.3.2: Invalid emails, amounts, dates, and lengths", () => {
    it("rejects non-Howard email addresses with a clear error message (F2.1.2, F2.3.2)", () => {
      const parsed = requestSchema.safeParse({
        requesterEmail: "user@gmail.com",
        department: "Chemistry",
        fundingSource: "department",
        amount: 500,
        neededBy: validFutureDate,
        priority: "low",
        description: "Chemicals",
      });

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.flatten().fieldErrors.requesterEmail?.[0]).toContain("@howard.edu");
      }
    });

    it("rejects zero, negative, oversized, and 3-decimal amounts (F2.1.2, F2.3.2)", () => {
      expect(hasAtMostTwoDecimals(12.34)).toBe(true);
      expect(hasAtMostTwoDecimals(12.345)).toBe(false);

      for (const badAmount of [0, -50, LIMITS.amountMax + 1, 99.999]) {
        const parsed = requestSchema.safeParse({
          requesterEmail: "faculty@howard.edu",
          department: "Physics",
          fundingSource: "department",
          amount: badAmount,
          neededBy: validFutureDate,
          priority: "medium",
          description: "Spectrometer calibration.",
        });
        expect(parsed.success).toBe(false);
      }
    });

    it("rejects past needed-by dates and malformed date strings (F2.1.2, F2.3.2)", () => {
      for (const badDate of ["2020-01-01", "not-a-date", ""]) {
        const parsed = requestSchema.safeParse({
          requesterEmail: "faculty@howard.edu",
          department: "History",
          fundingSource: "department",
          amount: 200,
          neededBy: badDate,
          priority: "low",
          description: "Archive access fee.",
        });
        expect(parsed.success).toBe(false);
      }
    });
  });

  describe("F2.2.2 & F2.3.3: Input sanitization and control-character stripping", () => {
    it("strips ASCII control characters while preserving tabs and newlines in blocks (F2.2.2, F2.3.3)", () => {
      const dirty = "Budget\u0000\u0007 line\u001F item";
      expect(stripControlChars(dirty)).toBe("Budget line item");
      expect(cleanLine("  Multiple   spaces\u0000 here  ")).toBe("Multiple spaces here");
      expect(cleanBlock("Line 1\r\nLine 2\u0000\rLine 3")).toBe("Line 1\nLine 2\nLine 3");
    });
  });
});
