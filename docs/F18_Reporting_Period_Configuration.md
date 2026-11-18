# F18.2 – Reporting Period Configuration

**Feature:** F18 Temporal Filtering (Academic Term/Month)
**Sub-issue:** F18.2 – Implement Reporting Period Configuration (#184)
**Builds on:** F18.1 – Institutional reporting periods

## 1. Purpose and scope

F18.2 makes reporting period configuration explicit, versioned and safe to maintain:

- One versioned configuration object, `REPORTING_PERIOD_CONFIG`.
- Validation runs **as soon as the module is imported**, using the existing Zod schema, so invalid calendar data fails immediately and in CI rather than on the first lookup.
- The configuration is **deep-frozen**, so nothing can change it at runtime.
- Coverage helpers tell a date **outside the calendar data** apart from a **break between terms**.

Out of scope:

| Topic                                                  | Where it belongs          |
| ------------------------------------------------------ | ------------------------- |
| Time zone handling                                     | F18.3                     |
| Filtering requests by period, including across periods | F18.4                     |
| UI, analytics changes, database tables, admin editing  | Not part of F18.2         |
| Fiscal-year rules                                      | Unchanged (see section 3) |

## 2. Where the configuration lives

| File                                      | Role                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `src/lib/howard-academic-calendar.ts`     | Official Howard academic calendar **data** only                              |
| `src/lib/reporting-periods.ts`            | Period types, the Zod calendar schema, period lookups, coverage helpers      |
| `src/lib/reporting-period-config.ts`      | `REPORTING_PERIOD_CONFIG`, its version, schema and validate/define functions |
| `src/lib/deep-freeze.ts`                  | Shared `deepFreeze` utility; has no imports                                  |
| `src/lib/reporting-period-config.test.ts` | Imports the shipped configuration, so CI runs its import-time validation     |

Dependency direction (arrows point to the module being imported):

```
reporting-period-config.ts ──▶ reporting-periods.ts ──▶ howard-academic-calendar.ts ──▶ deep-freeze.ts
          │                            │
          ├──▶ howard-academic-calendar.ts        └──▶ request-utils.ts (deriveFiscalPeriod)
          └──▶ deep-freeze.ts
```

Rules that keep this free of import cycles:

- `howard-academic-calendar.ts` stays **data-only**. It may import types from `reporting-periods.ts` (`import type`), but never a value. A value import would create a runtime cycle: the calendar would run while the schema it needs does not exist yet, and the app would crash on load.
- `reporting-periods.ts` must **not** import `reporting-period-config.ts`. It keeps `HOWARD_ACADEMIC_CALENDAR` as its default calendar. The configuration holds that same object, so default lookups and lookups through the configuration share one cache.

## 3. Period kinds

| Kind           | Rules come from                                                                                                      | Configurable here? |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Fiscal         | `deriveFiscalPeriod()` in `request-utils.ts` and the `f4_enforce_request_metadata()` SQL trigger (July 1 start, UTC) | No                 |
| Calendar month | Fixed UTC calendar months                                                                                            | No                 |
| Academic       | Howard academic calendar data in `howard-academic-calendar.ts`                                                       | Yes                |

Fiscal rules are deliberately left out of the configuration. Copying them would add a third copy of a rule that must already stay in sync between TypeScript and SQL, and requests already store their fiscal labels. The configuration schema is strict, so a `fiscal` key is rejected.

## 4. Adding or correcting an academic year

1. **Find an official Howard source** that publishes that year's dates, such as the Howard calendars page or the published academic calendar PDF. Cite only a source that actually contains that year's dates.
2. **Pick the dates using the rules in the header of `howard-academic-calendar.ts`:**
   - Start: the event labeled "Formal Classes Begin".
   - End: the event labeled "Semester Ends" or "Summer Session … Ends".
   - When the event table and the summary list disagree, the labeled table event wins.
   - Summer belongs to the academic year that began the previous fall.
   - **Summer end (`summer.endDate`):** set it only when the calendar publishes a Summer semester end event (e.g. "Summer Semester Ends") on a date that differs from the session end dates. When it is set, it overrides the end derived from the sessions. When it is not set, the Summer term ends with its latest session.
   - **Summer start (`summer.startDate`):** set it only when the source explicitly publishes a Summer semester start event. Do not derive one from the sessions or from the end-date rule. When it is not set, the Summer term starts with its earliest session. The two fallbacks are independent.
3. **Declare the source** near the top of `howard-academic-calendar.ts`, following the existing convention:
   - One named `AcademicCalendarSource` constant per source document, e.g. `ACADEMIC_CALENDAR_2025_2026_PDF` or `HOWARD_CALENDARS_PAGE`.
   - A comment above the constant saying which academic year(s) that document contains, e.g. "Contains AY2025-2026 only (Fall 2025, Spring 2026, Summer 2026)" or "Shows the 2026-2027 academic calendar inline".
   - `url` (https), `publishedBy`, and `retrievedOn` (the date you checked the dates against that document).
   - If a document already declared there also contains the new year, reuse its constant and update its comment and `retrievedOn`, but only after confirming the document actually contains that year's dates.
4. **Add the year** to `HOWARD_ACADEMIC_CALENDAR` in `howard-academic-calendar.ts`:
   - `academicYear` as `AYyyyy-yyyy`.
   - `sources` listing the named source constant(s) for that year.
   - `fall`, `spring`, and `summer.sessions` (`summer-1`, `summer-2`, `summer-10wk`). All dates are inclusive local dates in Eastern time, as `YYYY-MM-DD`.
   - A comment beside each date quoting the published event text.
5. **Keep the years consecutive.** No academic year may be missing between the first and last years in the data. The order of the array does not matter.
6. **Bump the version** (section 7).
7. **Validate** (section 5).
8. **In the pull request description**, list the years added or corrected, their sources, and the new version.

Correcting a published date follows the same steps: update the date, its quoted comment and the source's `retrievedOn`, then bump the version.

## 5. Validating the configuration

Run:

```sh
npx vitest run src/lib/reporting-period-config.test.ts src/lib/reporting-periods.test.ts
npx vitest run
npx tsc --noEmit
```

What is checked, in this order (each check runs only if the previous one passed):

1. **Structure:** the configuration must be plain, acyclic data. Zod reads only the indexes of an array and ignores some kinds of property, so these are checked separately:
   - no circular references (sharing the same object in two places is allowed);
   - no array properties other than indexes (e.g. `calendar.note = …`);
   - no symbol-keyed, non-enumerable or getter/setter properties.
2. **`reportingPeriodConfigSchema`:**
   - `version` must be `YYYY-MM-DD.N`, where the date is a real calendar date and `N` is 1 or more without leading zeros;
   - no unknown keys are allowed;
   - `academicCalendar` must satisfy every F18.1 calendar rule: real dates, terms in the right calendar years, Summer sessions in order and inside Summer, no overlapping or duplicate years, at least one year, https sources.
3. **Coverage:** academic years must be consecutive.

Validation never changes or freezes its input. `defineReportingPeriodConfig()` freezes only after every check passes, so input that fails validation, including every nested year, is never frozen.

Errors use the format `path: message`, for example:

```
academicCalendar.note: unexpected array property
academicCalendar.0.summer.loop: circular reference
version: must match YYYY-MM-DD.N with a real date and N of 1 or more without leading zeros
academicCalendar.1.fall.endDate: must be a real calendar date in YYYY-MM-DD format
academicCalendar: Academic calendar years must be consecutive: AY2026-2027 is missing between AY2025-2026 and AY2027-2028
```

Because `REPORTING_PERIOD_CONFIG` is built with `defineReportingPeriodConfig()` when the module loads, invalid shipped data makes importing `reporting-period-config.ts` throw. The configuration test file imports it, so CI fails before the data reaches users.

API summary (`reporting-period-config.ts`):

- `validateReportingPeriodConfig(candidate)` returns `{ ok: true, data }` or `{ ok: false, errors }` and never throws. On success, `data` is the candidate object itself, not a copy.
- `defineReportingPeriodConfig(candidate)` validates, then deep-freezes the candidate **in place** and returns the same object. Throws an `Error` listing every message.

## 6. Coverage and coverage status

`getAcademicCalendarCoverage(calendar?)` returns the span the data covers: from the first Fall term's start to the end of the last Summer term. It is computed chronologically, so the order of years in the array does not matter. The bounds are half-open (`startUtc <= instant < endExclusiveUtc`) instants in UTC for local midnights in `America/New_York`, along with the inclusive local dates and the first and last academic years.

For the shipped calendar:

| Field             | Value                      |
| ----------------- | -------------------------- |
| `localStartDate`  | `2025-08-18`               |
| `localEndDate`    | `2027-07-24`               |
| `startUtc`        | `2025-08-18T04:00:00.000Z` |
| `endExclusiveUtc` | `2027-07-25T04:00:00.000Z` |

`getAcademicCoverageStatus(input, calendar?)` returns:

| Status            | Meaning                                                                            | Example (shipped calendar) |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| `invalid-date`    | Not a valid instant (see `toValidInstant`). Never throws.                          | `"2026-01-01"` (date only) |
| `before-coverage` | Before the first Fall start; no academic data exists                               | `2025-07-01T12:00:00Z`     |
| `in-term`         | Inside Fall, Spring or Summer (exactly when `getAcademicTermForDate` finds a term) | `2025-10-01T12:00:00Z`     |
| `between-terms`   | Inside the covered span, in a break between terms                                  | `2025-12-20T12:00:00Z`     |
| `after-coverage`  | At or after the end of the last Summer term; no academic data exists               | `2027-07-25T04:00:00Z`     |

Both functions throw an `Error` if the calendar is invalid or has a missing year. Coverage results are frozen and cached; a changed calendar that is not frozen gets a new result, never an outdated one.

**Note:** after `2027-07-24` (Eastern), every date is `after-coverage` until AY2027-2028 is added. Add the next academic year as soon as Howard publishes it.

## 7. Versioning

- `REPORTING_PERIOD_CONFIG_VERSION` in `reporting-period-config.ts` uses the `RULES_VERSION` format `YYYY-MM-DD.N`: the date of the change (a real calendar date), plus a sequence number starting at `1` (no leading zeros) for multiple changes on one day, e.g. `2026-11-18.1`, then `2026-11-18.2`.
- **Bump it by hand** whenever calendar data (dates, sources, years) or the configuration changes.
- **No automated check enforces the bump.** Reviewers must confirm a calendar change includes a version bump.

## 8. Known limitations

- Changing the calendar requires a code change and a deployment. There is no administrator editing or database-backed configuration.
- Modules that import only `reporting-periods.ts` still validate the calendar when first used; validation at import time happens only through `reporting-period-config.ts` (and in CI through its tests).
- A custom calendar that `buildAcademicPeriods()` first saw before it was frozen keeps being compared against its cached snapshot on later lookups (F18.1 caching behaviour). Results stay correct; only the shipped calendar, which is frozen before any lookup, skips that comparison.
- Time zone handling (F18.3) and filtering (F18.4) are not part of F18.2.
