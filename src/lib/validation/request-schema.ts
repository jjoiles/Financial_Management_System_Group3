import { z } from "zod";

// Gateway 1: the form schema. Runs in the browser before anything is sent.
// Limits here must match the database constraints in
// supabase/migrations/20261015120000_f22_data_validation_gateways.sql.

export const FUNDING_SOURCES = ["department", "research", "university"] as const;
export const PRIORITIES = ["low", "medium", "high"] as const;

export type FundingSource = (typeof FUNDING_SOURCES)[number];
export type Priority = (typeof PRIORITIES)[number];

export const LIMITS = {
  amountMax: 9_999_999.99,
  departmentMin: 2,
  departmentMax: 80,
  descriptionMax: 10_000,
  grantNumberMin: 3,
  grantNumberMax: 64,
  nameMax: 120,
  titleMax: 120,
} as const;

export const HOWARD_EMAIL_DOMAIN = "@howard.edu";

// Removes control characters (except tab and newline) that can break CSV
// exports, Power Automate payloads, and emails.
export const stripControlChars = (value: string) =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

// For single-line fields: strip control chars, collapse runs of whitespace.
export const cleanLine = (value: string) => stripControlChars(value).replace(/\s+/g, " ").trim();

// For multi-line fields: strip control chars, normalize line endings.
export const cleanBlock = (value: string) =>
  stripControlChars(value.replace(/\r\n?/g, "\n")).trim();

const optionalLine = (max: number, label: string) =>
  z
    .string()
    .optional()
    .transform((val) => (val ? cleanLine(val) : undefined))
    .pipe(z.string().max(max, `${label} must be ${max} characters or fewer.`).optional());

export const hasAtMostTwoDecimals = (value: number) =>
  Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

export const localToday = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
};

export const requestSchema = z
  .object({
    requesterEmail: z
      .string()
      .transform(cleanLine)
      .pipe(
        z
          .string()
          .toLowerCase()
          .email("Enter a valid email address.")
          .refine((email) => email.endsWith(HOWARD_EMAIL_DOMAIN), {
            message: "Must be a Howard University email (@howard.edu).",
          }),
      ),
    department: z
      .string()
      .transform(cleanLine)
      .pipe(
        z
          .string()
          .min(LIMITS.departmentMin, "Department is required.")
          .max(
            LIMITS.departmentMax,
            `Department must be ${LIMITS.departmentMax} characters or fewer.`,
          ),
      ),
    fundingSource: z.enum(FUNDING_SOURCES, {
      required_error: "Select a funding source.",
      invalid_type_error: "Select a funding source.",
    }),
    amount: z.coerce
      .number({ invalid_type_error: "Enter an amount." })
      .positive("Amount must be greater than zero.")
      .max(LIMITS.amountMax, "Amount is too large.")
      .refine(hasAtMostTwoDecimals, "Amount can have at most 2 decimal places."),
    neededBy: z
      .string()
      .min(1, "Needed-by date is required.")
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date."),
    priority: z.enum(PRIORITIES, { required_error: "Select a priority." }),
    description: z
      .string()
      .transform(cleanBlock)
      .pipe(
        z
          .string()
          .min(1, "Business justification is required.")
          .max(LIMITS.descriptionMax, "Business justification is too long."),
      ),
    grantNumber: optionalLine(LIMITS.grantNumberMax, "Grant number"),
    principalInvestigator: optionalLine(LIMITS.nameMax, "PI name").transform((val) => {
      if (!val) return val;
      return /^dr\.?\s/i.test(val) ? val : `Dr. ${val}`;
    }),
    universityProgram: optionalLine(LIMITS.nameMax, "Program name"),
  })
  .superRefine((data, ctx) => {
    const neededBy = new Date(`${data.neededBy}T00:00:00`);
    if (Number.isNaN(neededBy.getTime())) {
      ctx.addIssue({
        code: "custom",
        path: ["neededBy"],
        message: "Enter a valid date.",
      });
    } else if (neededBy < localToday()) {
      ctx.addIssue({
        code: "custom",
        path: ["neededBy"],
        message: "Choose today or a future date.",
      });
    }
    if (data.fundingSource === "research") {
      if (!data.grantNumber) {
        ctx.addIssue({
          code: "custom",
          path: ["grantNumber"],
          message: "Grant number is required for research funding.",
        });
      } else if (data.grantNumber.length < LIMITS.grantNumberMin) {
        ctx.addIssue({
          code: "custom",
          path: ["grantNumber"],
          message: "Grant number must be at least 3 characters.",
        });
      }
      if (!data.principalInvestigator)
        ctx.addIssue({
          code: "custom",
          path: ["principalInvestigator"],
          message: "PI name is required for research funding.",
        });
    }
    if (data.fundingSource === "university" && !data.universityProgram) {
      ctx.addIssue({
        code: "custom",
        path: ["universityProgram"],
        message: "Program name is required for university funding.",
      });
    }
  });

export type RequestInput = z.infer<typeof requestSchema>;
export type FormErrors = Partial<Record<keyof RequestInput, string>>;
