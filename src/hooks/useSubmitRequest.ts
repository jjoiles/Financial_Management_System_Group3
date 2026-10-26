import { useState } from "react";
import type { User } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import type { FormErrors } from "@/lib/validation/request-schema";
import { validateSubmission } from "@/lib/validation/gateways";
import {
  getSubmitErrorMessage,
  submitFinancialRequest,
  type SubmissionResult,
} from "@/services/request-submission";

/**
 * State and actions for the financial request form. The page renders; this
 * hook validates input, calls the submission service, and tracks the
 * loading, error, and result state.
 */
export function useSubmitRequest(user: User | null) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState("");

  /**
   * Validates and submits raw form values. `onSuccess` runs in the same tick
   * as the result update, while the form element is still mounted, so the
   * page can reset it.
   */
  const submit = async (raw: Record<string, unknown>, files: File[], onSuccess?: () => void) => {
    if (!user) {
      setSubmitError("Please sign in before submitting a financial request.");
      return;
    }

    // F22 gateway 1: form validation
    const parsed = validateSubmission(raw);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setSubmitError("");
      return;
    }

    setErrors({});
    setSubmitError("");
    setSubmitting(true);

    try {
      const outcome = await submitFinancialRequest({ input: parsed.data, userId: user.id, files });
      if (outcome.kind === "field_errors") {
        setErrors(outcome.errors);
        if (outcome.message) setSubmitError(outcome.message);
        return;
      }
      setResult(outcome.result);
      onSuccess?.();
    } catch (err) {
      logger.error("request.submit_failed", { error: err });
      setSubmitError(getSubmitErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  /** Clears validation and error messages, e.g. when the form is reset. */
  const clearFeedback = () => {
    setErrors({});
    setSubmitError("");
  };

  return {
    submitting,
    result,
    errors,
    submitError,
    submit,
    clearFeedback,
    dismissResult: () => setResult(null),
  };
}
