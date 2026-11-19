# F1: Conditional Logic (`F1.1`–`F1.3`)

**Owner:** Ibrahim Osman (`Iosman172`)  
**Issues:** `#34` (`F1.1`: `#25`–`#27`), `#35` (`F1.2`: `#28`–`#30`), `#36` (`F1.3`: `#31`–`#33`)

---

## Overview

`F1` centralizes all conditional business rules, field visibility/requirement rules, multi-condition precedence, and safe invalid-input fallbacks into `src/lib/conditional-logic.ts` and `src/lib/validation/request-schema.ts`, backed by unit tests in `src/lib/conditional-logic.test.ts`.

---

## Subtask Mapping

| Task / Subtask | Implementation |
| :--- | :--- |
| **`F1.1.1` (`#25`):** Identify all conditions the system needs to evaluate | `SYSTEM_CONDITION_IDS` (`AMOUNT_EXECUTIVE_TIER`, `FUNDING_RESEARCH`, `FUNDING_UNIVERSITY`, `AMOUNT_ELEVATED_TIER`, `PRIORITY_HIGH_EXPEDITED`, `DEADLINE_URGENT_WITHIN_7_DAYS`, `ATTACHMENTS_REQUIRED_HIGH_VALUE`, `FUNDING_DEPARTMENT`, `AMOUNT_STANDARD_TIER`) in `src/lib/conditional-logic.ts`. |
| **`F1.1.2` (`#26`):** Define the expected action/result for each condition | `CONDITIONAL_BUSINESS_RULES` defines `requiredFields`, `hiddenFieldsToClear`, `primaryApproverQueue`, `requiresExecutiveSignoff`, `requiresSupportingAttachment`, and `isExpeditedSla` for each rule. |
| **`F1.1.3` (`#27`):** Define precedence when multiple conditions are true | Explicit `precedence` ranking (`1` = highest to `9` = lowest) in `CONDITIONAL_BUSINESS_RULES`; `evaluateConditionalRules()` sorts all matched conditions by ascending precedence and exposes `highestPrecedenceCondition`. |
| **`F1.2.1` (`#28`):** Centralize conditional rules out of UI components | `getVisibleFieldsForFundingSource()` and `evaluateConditionalRules()` in `src/lib/conditional-logic.ts` + `requestSchema` in `src/lib/validation/request-schema.ts`. |
| **`F1.2.2` (`#29`):** Implement rule evaluation | `evaluateConditionalRules()` evaluates funding source, amount tier, priority, 7-day urgent deadline window, and attachment presence simultaneously. |
| **`F1.2.3` (`#30`):** Handle missing, invalid, or unexpected values | `evaluateConditionalRules()` safely normalizes `null`, `undefined`, negative/non-numeric amounts, unknown funding sources/priorities, and non-Howard emails without throwing, returning `isValidInput: false`, `missingConditionalFields`, and `sanitizedWarnings`. |
| **`F1.3.1`–`F1.3.3` (`#31`–`#33`):** Test individual, combined, and boundary/failure cases | Unit tests in `src/lib/conditional-logic.test.ts` and `src/lib/requests/submission-service.test.ts`. |
