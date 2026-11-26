import { describe, expect, it } from "vitest";
import { buildValidatedPayload, mapDatabaseValidationError, validateSubmission } from "./gateways";

// F22.4: Verify Data Validation (#276). Cases come from the How to Test
// section of docs/F22_Data_Validation_Gateways.md.

const valid = {
  requesterEmail: "faculty@howard.edu",
  department: "Computer Science",
  fundingSource: "department",
  amount: "250.00",
  neededBy: "2099-01-15",
  priority: "medium",
  description: "Lab supplies.",
};

const context = {
  userId: "11111111-2222-4333-8444-555555555555",
  requestNumber: "FR-2026-ABC123",
};

describe("F22.4.1 (#333): invalid form inputs show field errors", () => {
  it.each([
    ["non-Howard email", { requesterEmail: "test@gmail.com" }, "requesterEmail", /howard\.edu/i],
    ["3-decimal amount", { amount: "10.555" }, "amount", /2 decimal places/],
    [
      "research with no grant number",
      { fundingSource: "research", principalInvestigator: "Ada" },
      "grantNumber",
      /Grant number is required/,
    ],
    [
      "university with no program",
      { fundingSource: "university" },
      "universityProgram",
      /Program name is required/,
    ],
  ] as const)("%s puts the error under the right field", (_label, change, field, message) => {
    const result = validateSubmission({ ...valid, ...change });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toMatch(message);
  });

  it("accepts the valid baseline so the cases above fail for their own reason", () => {
    expect(validateSubmission(valid).ok).toBe(true);
  });

  it("maps a database email-domain rejection back to the email field", () => {
    const errors = mapDatabaseValidationError({
      code: "23514",
      message:
        'new row for relation "financial_requests" violates check constraint "financial_requests_email_domain"',
    });
    expect(errors).toEqual({ requesterEmail: "Must be a Howard University email (@howard.edu)." });
  });

  it("ignores errors that are not validation errors", () => {
    expect(mapDatabaseValidationError({ code: "42501", message: "permission denied" })).toBeNull();
  });
});

describe("F22.4.3 (#335): conditional fields are cleared on save", () => {
  it("drops a stale grant number and PI after switching Research to Department", () => {
    // User picked Research, typed a grant, then switched to Department.
    const parsed = validateSubmission({
      ...valid,
      fundingSource: "department",
      grantNumber: "NSF-2041",
      principalInvestigator: "Ada Lovelace",
      universityProgram: "Old Program",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const payload = buildValidatedPayload(parsed.data, context);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    expect(payload.data.grant_number).toBeNull();
    expect(payload.data.principal_investigator).toBeNull();
    expect(payload.data.university_program).toBeNull();
  });

  it("keeps only the program for University funding", () => {
    const parsed = validateSubmission({
      ...valid,
      fundingSource: "university",
      universityProgram: "Honors Program",
      grantNumber: "NSF-2041",
    });
    if (!parsed.ok) throw new Error("expected valid input");
    const payload = buildValidatedPayload(parsed.data, context);
    if (!payload.ok) throw new Error("expected valid payload");
    expect(payload.data.university_program).toBe("Honors Program");
    expect(payload.data.grant_number).toBeNull();
  });

  it("keeps grant and PI for Research funding", () => {
    const parsed = validateSubmission({
      ...valid,
      fundingSource: "research",
      grantNumber: "NSF-2041",
      principalInvestigator: "Ada Lovelace",
      universityProgram: "Old Program",
    });
    if (!parsed.ok) throw new Error("expected valid input");
    const payload = buildValidatedPayload(parsed.data, context);
    if (!payload.ok) throw new Error("expected valid payload");
    expect(payload.data.grant_number).toBe("NSF-2041");
    expect(payload.data.principal_investigator).toBe("Dr. Ada Lovelace");
    expect(payload.data.university_program).toBeNull();
  });
});
