import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_BUSINESS_RULES,
  evaluateConditionalRules,
  getVisibleFieldsForFundingSource,
  SYSTEM_CONDITION_IDS,
} from "./conditional-logic";

describe("F1: Conditional Logic (F1.1, F1.2, F1.3)", () => {
  describe("F1.1 & F1.3.1: Individual condition definitions and evaluation", () => {
    it("defines all system conditions with unique precedence rankings (F1.1.1, F1.1.2, F1.1.3)", () => {
      expect(SYSTEM_CONDITION_IDS.length).toBeGreaterThanOrEqual(9);
      const precedences = SYSTEM_CONDITION_IDS.map(
        (id) => CONDITIONAL_BUSINESS_RULES[id].precedence,
      );
      expect(new Set(precedences).size).toBe(SYSTEM_CONDITION_IDS.length);
    });

    it("evaluates research funding condition and requires grantNumber + principalInvestigator (F1.3.1)", () => {
      const visible = getVisibleFieldsForFundingSource("research");
      expect(visible).toEqual({
        showGrantNumber: true,
        showPrincipalInvestigator: true,
        showUniversityProgram: false,
      });

      const validResearch = evaluateConditionalRules({
        fundingSource: "research",
        amount: 2500,
        priority: "medium",
        grantNumber: "NSF-2026-01",
        principalInvestigator: "Dr. Carter",
      });
      expect(validResearch.isValidInput).toBe(true);
      expect(validResearch.matchedConditions).toContain("FUNDING_RESEARCH");
      expect(validResearch.requiredFields).toEqual(
        expect.arrayContaining(["grantNumber", "principalInvestigator"]),
      );
      expect(validResearch.clearedHiddenFields).toContain("universityProgram");
      expect(validResearch.missingConditionalFields).toEqual([]);
    });

    it("evaluates university funding condition and requires universityProgram (F1.3.1)", () => {
      const visible = getVisibleFieldsForFundingSource("university");
      expect(visible).toEqual({
        showGrantNumber: false,
        showPrincipalInvestigator: false,
        showUniversityProgram: true,
      });

      const validUniversity = evaluateConditionalRules({
        fundingSource: "university",
        amount: 4200,
        priority: "low",
        universityProgram: "STEM Scholars Initiative",
      });
      expect(validUniversity.isValidInput).toBe(true);
      expect(validUniversity.matchedConditions).toContain("FUNDING_UNIVERSITY");
      expect(validUniversity.requiredFields).toContain("universityProgram");
      expect(validUniversity.clearedHiddenFields).toEqual(
        expect.arrayContaining(["grantNumber", "principalInvestigator"]),
      );
    });

    it("evaluates department funding condition and clears grant/program fields (F1.3.1)", () => {
      const visible = getVisibleFieldsForFundingSource("department");
      expect(visible).toEqual({
        showGrantNumber: false,
        showPrincipalInvestigator: false,
        showUniversityProgram: false,
      });

      const dept = evaluateConditionalRules({
        fundingSource: "department",
        amount: 950,
        priority: "low",
      });
      expect(dept.isValidInput).toBe(true);
      expect(dept.matchedConditions).toContain("FUNDING_DEPARTMENT");
      expect(dept.amountTier).toBe("standard");
      expect(dept.clearedHiddenFields).toEqual(
        expect.arrayContaining(["grantNumber", "principalInvestigator", "universityProgram"]),
      );
    });
  });

  describe("F1.1.3 & F1.3.2: Multi-condition combinations and precedence", () => {
    it("orders AMOUNT_EXECUTIVE_TIER above FUNDING_RESEARCH when both apply simultaneously (F1.1.3, F1.3.2)", () => {
      const result = evaluateConditionalRules({
        fundingSource: "research",
        amount: 75_000,
        priority: "high",
        neededBy: "2026-10-28",
        referenceDate: new Date("2026-10-25T12:00:00Z"),
        grantNumber: "NIH-8899",
        principalInvestigator: "Dr. Howard",
        attachmentCount: 0,
      });

      expect(result.isValidInput).toBe(true);
      expect(result.highestPrecedenceCondition).toBe("AMOUNT_EXECUTIVE_TIER");
      expect(result.matchedConditions[0]).toBe("AMOUNT_EXECUTIVE_TIER");
      expect(result.matchedConditions[1]).toBe("FUNDING_RESEARCH");
      expect(result.requiresExecutiveSignoff).toBe(true);
      expect(result.isExpedited).toBe(true);
      expect(result.hasMissingRecommendedAttachment).toBe(true);
    });

    it("combines elevated amount tier with urgent deadline within 7 days (F1.3.2)", () => {
      const result = evaluateConditionalRules({
        fundingSource: "university",
        amount: 15_000,
        priority: "medium",
        neededBy: "2026-10-30",
        referenceDate: new Date("2026-10-25T12:00:00Z"),
        universityProgram: "Provost Academic Innovation",
        attachmentCount: 2,
      });

      expect(result.amountTier).toBe("elevated");
      expect(result.highestPrecedenceCondition).toBe("FUNDING_UNIVERSITY");
      expect(result.matchedConditions).toContain("AMOUNT_ELEVATED_TIER");
      expect(result.matchedConditions).toContain("DEADLINE_URGENT_WITHIN_7_DAYS");
      expect(result.isExpedited).toBe(true);
      expect(result.hasMissingRecommendedAttachment).toBe(false);
    });
  });

  describe("F1.2.3 & F1.3.3: Boundary values and missing/invalid input handling", () => {
    it("evaluates exact amount tier boundaries ($9,999.99, $10,000, $49,999.99, $50,000) accurately (F1.3.3)", () => {
      expect(
        evaluateConditionalRules({ fundingSource: "department", amount: 9_999.99 }).amountTier,
      ).toBe("standard");
      expect(
        evaluateConditionalRules({ fundingSource: "department", amount: 10_000 }).amountTier,
      ).toBe("elevated");
      expect(
        evaluateConditionalRules({ fundingSource: "department", amount: 49_999.99 }).amountTier,
      ).toBe("elevated");
      expect(
        evaluateConditionalRules({ fundingSource: "department", amount: 50_000 }).amountTier,
      ).toBe("executive");
    });

    it("flags missing conditional required fields for research and university funding (F1.2.3, F1.3.3)", () => {
      const missingResearch = evaluateConditionalRules({
        fundingSource: "research",
        amount: 5000,
        grantNumber: "AB", // shorter than 3-char minimum
        principalInvestigator: "   ",
      });
      expect(missingResearch.isValidInput).toBe(false);
      expect(missingResearch.missingConditionalFields).toEqual([
        "grantNumber",
        "principalInvestigator",
      ]);

      const missingUniversity = evaluateConditionalRules({
        fundingSource: "university",
        amount: 5000,
        universityProgram: "",
      });
      expect(missingUniversity.isValidInput).toBe(false);
      expect(missingUniversity.missingConditionalFields).toEqual(["universityProgram"]);
    });

    it("handles null, undefined, or malformed inputs without throwing (F1.2.3, F1.3.3)", () => {
      const nullResult = evaluateConditionalRules(null);
      expect(nullResult.isValidInput).toBe(false);
      expect(nullResult.amountTier).toBe("standard");
      expect(nullResult.sanitizedWarnings.length).toBeGreaterThan(0);

      const corruptResult = evaluateConditionalRules({
        fundingSource: "crypto_fund",
        amount: "-999",
        priority: "super_urgent",
        requesterEmail: "external@gmail.com",
      });
      expect(corruptResult.isValidInput).toBe(false);
      expect(corruptResult.sanitizedWarnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("fundingSource"),
          expect.stringContaining("amount"),
          expect.stringContaining("priority"),
          expect.stringContaining("@howard.edu"),
        ]),
      );
    });
  });
});
