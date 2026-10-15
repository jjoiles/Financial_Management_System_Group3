import { z } from "zod";
import {
  FUNDING_SOURCES,
  HOWARD_EMAIL_DOMAIN,
  LIMITS,
  PRIORITIES,
  hasAtMostTwoDecimals,
  requestSchema,
  type FormErrors,
  type RequestInput,
} from "./request-schema";

// F22: Data Validation Gateways
//
// A request passes three gateways before it is stored:
//   1. Form gateway      validateSubmission()     user-facing field errors
//   2. Payload gateway   buildValidatedPayload()  normalizes the DB row and
//                                                 rejects anything the form
//                                                 gateway should have caught
//   3. Database gateway  CHECK constraints + trigger in the F22 migration;
//                         mapDatabaseValidationError() turns its errors back
//                         into field errors
//
// Gateway 3 is the one that cannot be bypassed by calling Supabase directly.

export type GatewayResult<T> = { ok: true; data: T } | { ok: false; errors: FormErrors };

const toFieldErrors = (issues: z.ZodIssue[]): FormErrors => {
  const errors: FormErrors = {};
  for (const issue of issues) {
    const field = issue.path[0] as keyof RequestInput | undefined;
    // Keep the first error per field so messages do not pile up.
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
};

// Gateway 1
export function validateSubmission(raw: Record<string, unknown>): GatewayResult<RequestInput> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: toFieldErrors(parsed.error.issues) };
  return { ok: true, data: parsed.data };
}

// Shape of the financial_requests row this app writes.
const payloadSchema = z
  .object({
    user_id: z.string().uuid(),
    request_number: z.string().regex(/^FR-\d{4}-[A-Z0-9]{6}$/),
    title: z.string().min(1).max(LIMITS.titleMax),
    requester_email: z
      .string()
      .email()
      .refine((email) => email.endsWith(HOWARD_EMAIL_DOMAIN)),
    department: z.string().min(LIMITS.departmentMin).max(LIMITS.departmentMax),
    funding_source: z.enum(FUNDING_SOURCES),
    amount: z.number().positive().max(LIMITS.amountMax).refine(hasAtMostTwoDecimals),
    needed_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    priority: z.enum(PRIORITIES),
    description: z.string().min(1).max(LIMITS.descriptionMax),
    grant_number: z.string().max(LIMITS.grantNumberMax).nullable(),
    principal_investigator: z.string().max(LIMITS.nameMax).nullable(),
    university_program: z.string().max(LIMITS.nameMax).nullable(),
    status: z.literal("submitted"),
  })
  .passthrough()
  .superRefine((row, ctx) => {
    if (row.funding_source === "research" && (!row.grant_number || !row.principal_investigator)) {
      ctx.addIssue({
        code: "custom",
        path: ["grant_number"],
        message: "Research requests need a grant number and PI.",
      });
    }
    if (row.funding_source === "university" && !row.university_program) {
      ctx.addIssue({
        code: "custom",
        path: ["university_program"],
        message: "University requests need a program.",
      });
    }
  });

export type RequestPayload = z.infer<typeof payloadSchema>;

const payloadFieldToFormField: Record<string, keyof RequestInput> = {
  requester_email: "requesterEmail",
  department: "department",
  funding_source: "fundingSource",
  amount: "amount",
  needed_by: "neededBy",
  priority: "priority",
  description: "description",
  title: "description",
  grant_number: "grantNumber",
  principal_investigator: "principalInvestigator",
  university_program: "universityProgram",
};

// Gateway 2: builds the row from validated input. Fields that do not apply to
// the chosen funding source are forced to null so stale hidden-field values
// can never be stored.
export function buildValidatedPayload(
  input: RequestInput,
  context: { userId: string; requestNumber: string },
  extra: Record<string, unknown> = {},
): GatewayResult<RequestPayload> {
  const isResearch = input.fundingSource === "research";
  const isUniversity = input.fundingSource === "university";

  const candidate = {
    ...extra,
    user_id: context.userId,
    request_number: context.requestNumber,
    title: input.description.split("\n")[0].slice(0, LIMITS.titleMax).trim() || "Financial request",
    requester_email: input.requesterEmail,
    department: input.department,
    funding_source: input.fundingSource,
    amount: Math.round(input.amount * 100) / 100,
    needed_by: input.neededBy,
    priority: input.priority,
    description: input.description,
    grant_number: isResearch ? (input.grantNumber ?? null) : null,
    principal_investigator: isResearch ? (input.principalInvestigator ?? null) : null,
    university_program: isUniversity ? (input.universityProgram ?? null) : null,
    status: "submitted" as const,
  };

  const parsed = payloadSchema.safeParse(candidate);
  if (!parsed.success) {
    const errors: FormErrors = {};
    for (const issue of parsed.error.issues) {
      const field = payloadFieldToFormField[String(issue.path[0])];
      if (field && !errors[field]) errors[field] = issue.message || "This value was rejected.";
    }
    if (Object.keys(errors).length === 0)
      errors.description = "The request could not be prepared. Please retry.";
    return { ok: false, errors };
  }
  return { ok: true, data: parsed.data };
}

// Gateway 3 error mapping. Postgres raises 23514 for CHECK violations and the
// F22 trigger raises P0001 with the constraint-style name in `hint`.
const constraintToField: Record<string, keyof RequestInput> = {
  financial_requests_amount_range: "amount",
  financial_requests_amount_precision: "amount",
  financial_requests_email_domain: "requesterEmail",
  financial_requests_department_length: "department",
  financial_requests_description_length: "description",
  financial_requests_title_length: "description",
  financial_requests_research_fields: "grantNumber",
  financial_requests_university_fields: "universityProgram",
  financial_requests_grant_number_length: "grantNumber",
  financial_requests_needed_by_not_past: "neededBy",
};

const constraintMessages: Partial<Record<keyof RequestInput, string>> = {
  amount: "Amount must be between $0.01 and $9,999,999.99.",
  requesterEmail: "Must be a Howard University email (@howard.edu).",
  department: "Department must be 2 to 80 characters.",
  description: "Business justification is missing or too long.",
  grantNumber: "Research requests need a valid grant number and PI.",
  universityProgram: "University requests need a program name.",
  neededBy: "Choose today or a future date.",
};

type DbError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

export const isDatabaseValidationError = (error: unknown) => {
  const code = (error as DbError | null)?.code;
  return code === "23514" || code === "P0001" || code === "22P02";
};

export function mapDatabaseValidationError(error: unknown): FormErrors | null {
  if (!isDatabaseValidationError(error)) return null;
  const e = error as DbError;
  const haystack = `${e.hint ?? ""} ${e.message ?? ""} ${e.details ?? ""}`;
  for (const [constraint, field] of Object.entries(constraintToField)) {
    if (haystack.includes(constraint)) {
      return {
        [field]: e.code === "P0001" && e.message ? e.message : constraintMessages[field],
      };
    }
  }
  return {
    description: "The server rejected this request as invalid. Review the fields and try again.",
  };
}
