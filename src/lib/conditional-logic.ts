import {
  FUNDING_SOURCES,
  HOWARD_EMAIL_DOMAIN,
  LIMITS,
  PRIORITIES,
  type FundingSource,
  type Priority,
} from "./validation/request-schema";
import type { AmountTier } from "./request-utils";

/**
 * F1: Conditional Logic (F1.1, F1.2, F1.3)
 *
 * Centralizes all conditional business rules (F1.1.1), expected actions/outcomes
 * (F1.1.2), multi-condition precedence (F1.1.3), rule evaluation out of UI
 * components (F1.2.1 & F1.2.2), and resilient handling of missing, invalid, or
 * unexpected input values (F1.2.3).
 */

// ---------------------------------------------------------------------------
// F1.1: Define Business Rules (F1.1.1, F1.1.2, F1.1.3)
// ---------------------------------------------------------------------------

/** F1.1.1: All condition identifiers evaluated across financial request workflows. */
export const SYSTEM_CONDITION_IDS = [
  "FUNDING_RESEARCH",
  "FUNDING_UNIVERSITY",
  "FUNDING_DEPARTMENT",
  "AMOUNT_EXECUTIVE_TIER",
  "AMOUNT_ELEVATED_TIER",
  "AMOUNT_STANDARD_TIER",
  "PRIORITY_HIGH_EXPEDITED",
  "DEADLINE_URGENT_WITHIN_7_DAYS",
  "ATTACHMENTS_REQUIRED_HIGH_VALUE",
] as const;

export type SystemConditionId = (typeof SYSTEM_CONDITION_IDS)[number];

export type ConditionalRuleDefinition = {
  id: SystemConditionId;
  precedence: number; // Lower number = higher precedence (1 is highest)
  description: string;
  requiredFields: readonly string[];
  hiddenFieldsToClear: readonly string[];
  primaryApproverQueue: string;
  requiresExecutiveSignoff: boolean;
  requiresSupportingAttachment: boolean;
  isExpeditedSla: boolean;
};

/**
 * F1.1.1, F1.1.2 & F1.1.3: Complete catalog of conditional rules, their expected
 * actions/results, and explicit numeric precedence (1 = highest precedence).
 */
export const CONDITIONAL_BUSINESS_RULES: Readonly<
  Record<SystemConditionId, ConditionalRuleDefinition>
> = {
  AMOUNT_EXECUTIVE_TIER: {
    id: "AMOUNT_EXECUTIVE_TIER",
    precedence: 1,
    description: "Requests >= $50,000 require executive Provost/CFO sign-off and supporting quotes.",
    requiredFields: ["requesterEmail", "department", "fundingSource", "amount", "neededBy", "priority", "description"],
    hiddenFieldsToClear: [],
    primaryApproverQueue: "Executive Finance & Provost Approval",
    requiresExecutiveSignoff: true,
    requiresSupportingAttachment: true,
    isExpeditedSla: false,
  },
  FUNDING_RESEARCH: {
    id: "FUNDING_RESEARCH",
    precedence: 2,
    description: "Research-funded requests require Grant Number and Principal Investigator and route to Research Administration.",
    requiredFields: ["grantNumber", "principalInvestigator"],
    hiddenFieldsToClear: ["universityProgram"],
    primaryApproverQueue: "Research Administration",
    requiresExecutiveSignoff: false,
    requiresSupportingAttachment: false,
    isExpeditedSla: false,
  },
  FUNDING_UNIVERSITY: {
    id: "FUNDING_UNIVERSITY",
    precedence: 3,
    description: "University-funded requests require a University Program Name and route to Provost Finance Office.",
    requiredFields: ["universityProgram"],
    hiddenFieldsToClear: ["grantNumber", "principalInvestigator"],
    primaryApproverQueue: "Provost Finance Office",
    requiresExecutiveSignoff: false,
    requiresSupportingAttachment: false,
    isExpeditedSla: false,
  },
  AMOUNT_ELEVATED_TIER: {
    id: "AMOUNT_ELEVATED_TIER",
    precedence: 4,
    description: "Requests between $10,000 and $49,999.99 trigger elevated budget review and attachment checks.",
    requiredFields: [],
    hiddenFieldsToClear: [],
    primaryApproverQueue: "Senior Budget Officer",
    requiresExecutiveSignoff: false,
    requiresSupportingAttachment: true,
    isExpeditedSla: false,
  },
  PRIORITY_HIGH_EXPEDITED: {
    id: "PRIORITY_HIGH_EXPEDITED",
    precedence: 5,
    description: "High-priority requests activate expedited SLA tracking.",
    requiredFields: [],
    hiddenFieldsToClear: [],
    primaryApproverQueue: "Department Budget Reviewer",
    requiresExecutiveSignoff: false,
    requiresSupportingAttachment: false,
    isExpeditedSla: true,
  },
  DEADLINE_URGENT_WITHIN_7_DAYS: {
    id: "DEADLINE_URGENT_WITHIN_7_DAYS",
    precedence: 6,
    description: "Requests needed within 7 calendar days activate expedited SLA tracking.",
    requiredFields: [],
    hiddenFieldsToClear: [],
    primaryApproverQueue: "Department Budget Reviewer",
    requiresExecutiveSignoff: false,
    requiresSupportingAttachment: false,
    isExpeditedSla: true,
  },
  ATTACHMENTS_REQUIRED_HIGH_VALUE: {
    id: "ATTACHMENTS_REQUIRED_HIGH_VALUE",
    precedence: 7,
    description: "Requests >= $10,000 without attachments generate an advisory documentation warning.",
    requiredFields: [],
    hiddenFieldsToClear: [],
    primaryApproverQueue: "Department Budget Reviewer",
    requiresExecutiveSignoff: false,
    requiresSupportingAttachment: true,
    isExpeditedSla: false,
  },
  FUNDING_DEPARTMENT: {
    id: "FUNDING_DEPARTMENT",
    precedence: 8,
    description: "Department-funded requests clear external grant/program fields and route to Department Budget Reviewer.",
    requiredFields: [],
    hiddenFieldsToClear: ["grantNumber", "principalInvestigator", "universityProgram"],
    primaryApproverQueue: "Department Budget Reviewer",
    requiresExecutiveSignoff: false,
    requiresSupportingAttachment: false,
    isExpeditedSla: false,
  },
  AMOUNT_STANDARD_TIER: {
    id: "AMOUNT_STANDARD_TIER",
    precedence: 9,
    description: "Requests under $10,000 follow standard single-stage review.",
    requiredFields: [],
    hiddenFieldsToClear: [],
    primaryApproverQueue: "Department Budget Reviewer",
    requiresExecutiveSignoff: false,
    requiresSupportingAttachment: false,
    isExpeditedSla: false,
  },
} as const;

// ---------------------------------------------------------------------------
// F1.2: Implement Conditional Logic (F1.2.1, F1.2.2, F1.2.3)
// ---------------------------------------------------------------------------

export type ConditionalEvaluationInput = {
  fundingSource?: unknown;
  amount?: unknown;
  priority?: unknown;
  neededBy?: unknown;
  requesterEmail?: unknown;
  grantNumber?: unknown;
  principalInvestigator?: unknown;
  universityProgram?: unknown;
  attachmentCount?: unknown;
  referenceDate?: Date;
};

export type VisibleConditionalFields = {
  showGrantNumber: boolean;
  showPrincipalInvestigator: boolean;
  showUniversityProgram: boolean;
};

export type ConditionalEvaluationResult = {
  isValidInput: boolean;
  matchedConditions: SystemConditionId[];
  highestPrecedenceCondition: SystemConditionId;
  amountTier: AmountTier;
  visibleFields: VisibleConditionalFields;
  requiredFields: string[];
  clearedHiddenFields: string[];
  missingConditionalFields: string[];
  requiresExecutiveSignoff: boolean;
  requiresSupportingAttachment: boolean;
  hasMissingRecommendedAttachment: boolean;
  isExpedited: boolean;
  sanitizedWarnings: string[];
};

const VALID_FUNDING_SET = new Set<string>(FUNDING_SOURCES);
const VALID_PRIORITY_SET = new Set<string>(PRIORITIES);

/**
 * F1.2.1: Pure helper for UI components to determine which conditional fields
 * should be rendered for the selected funding source.
 */
export function getVisibleFieldsForFundingSource(fundingSource: unknown): VisibleConditionalFields {
  const normalized =
    typeof fundingSource === "string" ? fundingSource.trim().toLowerCase() : "";
  return {
    showGrantNumber: normalized === "research",
    showPrincipalInvestigator: normalized === "research",
    showUniversityProgram: normalized === "university",
  };
}

/**
 * F1.2.2 & F1.2.3: Evaluates all applicable conditions for a financial request,
 * sorts matched rules by precedence (F1.1.3), and safely handles missing,
 * malformed, or unexpected input values without throwing.
 */
export function evaluateConditionalRules(
  input: ConditionalEvaluationInput | null | undefined,
): ConditionalEvaluationResult {
  const safeInput = input && typeof input === "object" ? input : {};
  const warnings: string[] = [];

  // F1.2.3: Normalize and validate fundingSource with safe fallback
  const rawFunding =
    typeof safeInput.fundingSource === "string"
      ? safeInput.fundingSource.trim().toLowerCase()
      : "";
  const hasValidFunding = VALID_FUNDING_SET.has(rawFunding);
  const fundingSource: FundingSource = hasValidFunding
    ? (rawFunding as FundingSource)
    : "department";
  if (!hasValidFunding) {
    warnings.push("Missing or unrecognized fundingSource; defaulted to department rule set.");
  }

  // F1.2.3: Normalize and validate numeric amount
  const parsedAmount =
    typeof safeInput.amount === "number"
      ? safeInput.amount
      : typeof safeInput.amount === "string" && safeInput.amount.trim().length > 0
        ? Number(safeInput.amount)
        : NaN;
  const hasValidAmount =
    Number.isFinite(parsedAmount) && parsedAmount > 0 && parsedAmount <= LIMITS.amountMax;
  const amount = hasValidAmount ? parsedAmount : 0;
  if (!hasValidAmount) {
    warnings.push("Missing, non-positive, or out-of-range amount; evaluated as standard tier.");
  }

  // F1.2.3: Normalize priority
  const rawPriority =
    typeof safeInput.priority === "string" ? safeInput.priority.trim().toLowerCase() : "";
  const hasValidPriority = VALID_PRIORITY_SET.has(rawPriority);
  const priority: Priority = hasValidPriority ? (rawPriority as Priority) : "medium";
  if (!hasValidPriority && safeInput.priority !== undefined) {
    warnings.push("Unrecognized priority value; defaulted to medium.");
  }

  // F1.2.3: Normalize email check if provided
  if (typeof safeInput.requesterEmail === "string" && safeInput.requesterEmail.trim().length > 0) {
    const cleanEmail = safeInput.requesterEmail.trim().toLowerCase();
    if (!cleanEmail.endsWith(HOWARD_EMAIL_DOMAIN)) {
      warnings.push(`Requester email must end with ${HOWARD_EMAIL_DOMAIN}.`);
    }
  }

  const attachmentCount =
    typeof safeInput.attachmentCount === "number" &&
    Number.isFinite(safeInput.attachmentCount) &&
    safeInput.attachmentCount >= 0
      ? Math.trunc(safeInput.attachmentCount)
      : 0;

  const matched: SystemConditionId[] = [];

  // Funding source branch
  if (fundingSource === "research") {
    matched.push("FUNDING_RESEARCH");
  } else if (fundingSource === "university") {
    matched.push("FUNDING_UNIVERSITY");
  } else {
    matched.push("FUNDING_DEPARTMENT");
  }

  // Amount tier branch
  let amountTier: AmountTier = "standard";
  if (amount >= 50_000) {
    amountTier = "executive";
    matched.push("AMOUNT_EXECUTIVE_TIER");
  } else if (amount >= 10_000) {
    amountTier = "elevated";
    matched.push("AMOUNT_ELEVATED_TIER");
  } else {
    matched.push("AMOUNT_STANDARD_TIER");
  }

  // Priority & deadline branch
  let isUrgentDeadline = false;
  if (typeof safeInput.neededBy === "string" && /^\d{4}-\d{2}-\d{2}$/.test(safeInput.neededBy)) {
    const refDate =
      safeInput.referenceDate instanceof Date && !Number.isNaN(safeInput.referenceDate.getTime())
        ? safeInput.referenceDate
        : new Date();
    const target = new Date(`${safeInput.neededBy}T00:00:00Z`);
    if (!Number.isNaN(target.getTime())) {
      const diffDays = (target.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays >= -1 && diffDays <= 7) {
        isUrgentDeadline = true;
      }
    }
  }

  if (priority === "high") {
    matched.push("PRIORITY_HIGH_EXPEDITED");
  }
  if (isUrgentDeadline) {
    matched.push("DEADLINE_URGENT_WITHIN_7_DAYS");
  }

  if (amount >= 10_000 && attachmentCount === 0) {
    matched.push("ATTACHMENTS_REQUIRED_HIGH_VALUE");
  }

  // F1.1.3: Sort matched conditions by numeric precedence (ascending: 1 is highest)
  const sortedMatched = [...matched].sort(
    (a, b) => CONDITIONAL_BUSINESS_RULES[a].precedence - CONDITIONAL_BUSINESS_RULES[b].precedence,
  );

  const highestPrecedenceCondition = sortedMatched[0] ?? "FUNDING_DEPARTMENT";
  const visibleFields = getVisibleFieldsForFundingSource(fundingSource);

  const requiredSet = new Set<string>();
  const clearedSet = new Set<string>();
  let requiresExecutiveSignoff = false;
  let requiresSupportingAttachment = false;
  let isExpedited = false;

  for (const condId of sortedMatched) {
    const rule = CONDITIONAL_BUSINESS_RULES[condId];
    for (const reqField of rule.requiredFields) requiredSet.add(reqField);
    for (const clearField of rule.hiddenFieldsToClear) clearedSet.add(clearField);
    if (rule.requiresExecutiveSignoff) requiresExecutiveSignoff = true;
    if (rule.requiresSupportingAttachment) requiresSupportingAttachment = true;
    if (rule.isExpeditedSla) isExpedited = true;
  }

  // Check whether conditional required fields are present in input
  const missingConditionalFields: string[] = [];
  if (fundingSource === "research") {
    const grant =
      typeof safeInput.grantNumber === "string" ? safeInput.grantNumber.trim() : "";
    const pi =
      typeof safeInput.principalInvestigator === "string"
        ? safeInput.principalInvestigator.trim()
        : "";
    if (grant.length < LIMITS.grantNumberMin) {
      missingConditionalFields.push("grantNumber");
    }
    if (pi.length === 0) {
      missingConditionalFields.push("principalInvestigator");
    }
  } else if (fundingSource === "university") {
    const prog =
      typeof safeInput.universityProgram === "string"
        ? safeInput.universityProgram.trim()
        : "";
    if (prog.length === 0) {
      missingConditionalFields.push("universityProgram");
    }
  }

  return {
    isValidInput: hasValidFunding && hasValidAmount && missingConditionalFields.length === 0,
    matchedConditions: sortedMatched,
    highestPrecedenceCondition,
    amountTier,
    visibleFields,
    requiredFields: [...requiredSet],
    clearedHiddenFields: [...clearedSet],
    missingConditionalFields,
    requiresExecutiveSignoff,
    requiresSupportingAttachment,
    hasMissingRecommendedAttachment: requiresSupportingAttachment && attachmentCount === 0,
    isExpedited,
    sanitizedWarnings: warnings,
  };
}
