import { useState } from "react";
import { submitFinancialRequest } from "@/lib/requests/browser-submission";
import type { SubmissionResult, SubmissionService } from "@/lib/requests/submission-types";
import type { FormErrors } from "@/lib/validation/request-schema";

/** Adapts use-case outcomes into React state; the service owns submission policy. */
export function useSubmitRequest(
  userId: string | null,
  service: SubmissionService = submitFinancialRequest,
) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState("");

  const clearFeedback = () => {
    setErrors({});
    setSubmitError("");
  };

  const submit = async (values: Record<string, unknown>, files: File[]) => {
    clearFeedback();
    setSubmitting(true);
    try {
      const outcome = await service({ userId, values, files });
      if (outcome.ok) setResult(outcome.result);
      else {
        setErrors(outcome.errors);
        setSubmitError(outcome.message);
      }
      return outcome.ok;
    } finally {
      setSubmitting(false);
    }
  };

  return {
    submitting,
    result,
    errors,
    submitError,
    submit,
    clearFeedback,
    clearResult: () => setResult(null),
  };
}
