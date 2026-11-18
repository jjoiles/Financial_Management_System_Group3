# F18.4 – Cross-Period Filtering

**Feature:** F18 Temporal Filtering (Academic Term/Month)
**Sub-issue:** F18.4 – Test Cross-Period Filtering (#186)
**Builds on:** F18.1 – Institutional reporting periods, F18.2 – Reporting Period Configuration, F18.3 – Timezone Handling

## 1. Purpose and scope

F18.4 adds one pure, browser-safe module, `src/lib/date-range-filter.ts`, that:

- validates **custom date ranges** from untrusted input and converts them to UTC bounds, and
- filters rows by **any** reporting period or custom range with a single function, including ranges that cross fiscal, calendar-month and academic boundaries.

It is library-only. It does **not** change any F18.1, F18.2 or F18.3 behavior or public API, and `REPORTING_PERIOD_CONFIG_VERSION` is unchanged.

Out of scope:

| Topic                                                                  | Status                             |
| ---------------------------------------------------------------------- | ---------------------------------- |
| UI (date pickers, Requests or Analytics page changes)                  | Not part of F18.4                  |
| Database, SQL, migration or RLS changes                                | Not part of F18.4                  |
| Server-side date-range queries (e.g. `created_at` filters in Supabase) | Not part of F18.4                  |
| A user- or administrator-selected time zone                            | Not planned (section 3)            |
| A `"custom"` reporting-period kind                                     | Deliberately not added (section 2) |
| Maximum range length, blocking future dates                            | Not required; both are allowed     |
| Fixing `submittedAt` and other known issues in F18.3 section 7         | Separate issues                    |
| Changing analytics, request-list, export or display behavior           | Unchanged                          |

## 2. Module layout

| File                                | Role                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `src/lib/date-range-filter.ts`      | `CUSTOM_DATE_RANGE_TIME_ZONE`, `validateCustomDateRange`, `filterByPeriod` |
| `src/lib/date-range-filter.test.ts` | F18.4 tests                                                                |

```
date-range-filter.ts ──▶ reporting-periods.ts ──▶ time-zones.ts   (no imports)
          └──────────────────────────────────────▶ time-zones.ts
```

`time-zones.ts`, `reporting-periods.ts` and `reporting-period-config.ts` must not import `date-range-filter.ts`; a test checks this.

A custom range is a **range**, not an institutional reporting period. `"custom"` is therefore **not** added to `REPORTING_PERIOD_KINDS` or `REPORTING_PERIOD_TIME_ZONES`, and a test checks both are unchanged.

## 3. Time zone policy

- Custom date ranges use the fixed institutional zone, `CUSTOM_DATE_RANGE_TIME_ZONE` = `INSTITUTION_TIME_ZONE` = `America/New_York`.
- Users do not choose a zone. The viewer's zone (`resolveViewerTimeZone()`) never affects filtering; this module does not import it.
- `validateCustomDateRange()` still requires the zone **explicitly**. The application passes `CUSTOM_DATE_RANGE_TIME_ZONE`; tests pass other zones to check conversion edge cases. A missing zone is a validation error, never a silent default.
- Standard periods keep their own zones from `REPORTING_PERIOD_TIME_ZONES` (fiscal and calendar month: UTC; academic: `America/New_York`).

Because the zones differ, the same instant can fall inside an Eastern custom range and outside the UTC calendar month with the same dates. For example, 9 pm Eastern on August 31, 2026 (`2026-09-01T01:00Z`) is in the **September** calendar month but inside the Eastern custom range `2026-08-01..2026-08-31`. This is intended.

## 4. API (`src/lib/date-range-filter.ts`)

### `validateCustomDateRange(input)`

```ts
validateCustomDateRange({ startDate: unknown, endDate: unknown, timeZone: unknown })
  → { ok: true, range: CustomDateRange }
  | { ok: false, errors: CustomDateRangeError[] }
```

Never throws for invalid input. Results are frozen. The input is not changed, trimmed or normalized.

On success, `range` is:

| Field             | Example                                                 |
| ----------------- | ------------------------------------------------------- |
| `kind`            | `"custom"`                                              |
| `startDate`       | `"2026-01-01"` (inclusive local date)                   |
| `endDate`         | `"2026-03-31"` (inclusive local date)                   |
| `timeZone`        | `"America/New_York"` (as given)                         |
| `startUtc`        | `"2026-01-01T05:00:00.000Z"`                            |
| `endExclusiveUtc` | `"2026-04-01T04:00:00.000Z"`                            |
| `key`             | `"custom:2026-01-01..2026-03-31@America/New_York"`      |
| `label`           | `"January 1, 2026 – March 31, 2026 (America/New_York)"` |

`CustomDateRange` extends the existing `PeriodBounds` and `LocalDateRange` types, so the bounds use the established `startUtc` / `endExclusiveUtc` names. A single-day range has a label with one date, e.g. `"November 18, 2026 (America/New_York)"`.

The bounds come from `localDateRangeToUtcBounds()` (F18.3); no conversion logic is duplicated. Its expected `RangeError`s are converted into the error codes below. Any other failure would be a programming error and is not caught.

Each error is `{ field, code, message }`:

| Code                         | Field(s)                           | When                                                                                            |
| ---------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `required`                   | `startDate`, `endDate`, `timeZone` | Missing, `null`, empty or whitespace-only (also when the whole input is missing)                |
| `not-a-string`               | `startDate`, `endDate`, `timeZone` | Any non-string value (number, `Date`, object, array, boolean, …)                                |
| `invalid-format`             | `startDate`, `endDate`             | Not strictly `YYYY-MM-DD` (e.g. `2026-1-05`, `2026/01/05`, a timestamp, surrounding whitespace) |
| `invalid-date`               | `startDate`, `endDate`             | `YYYY-MM-DD` but not a real date (e.g. `2026-02-30`, `2025-02-29`, `2026-13-01`)                |
| `unsupported-time-zone`      | `timeZone`                         | Not accepted by the runtime's Intl                                                              |
| `start-after-end`            | `range`                            | Both dates valid, start after end                                                               |
| `nonexistent-local-midnight` | `startDate` or `endDate`           | Midnight at the start of `startDate`, or after `endDate`, does not exist in the zone            |
| `unsupported-end-date`       | `endDate`                          | `9999-12-31`: the next day cannot be written with a four-digit year                             |

Order of checks:

1. Each field is checked on its own; errors for all three fields are collected together, in the order `startDate`, `endDate`, `timeZone`.
2. `start-after-end` is checked only when both dates are valid (even if the zone is invalid).
3. `nonexistent-local-midnight` and `unsupported-end-date` are checked only when every earlier check passes. Both edges are reported if both midnights are missing.

There is no maximum range length and future dates are allowed.

`nonexistent-local-midnight` cannot happen with `America/New_York`, whose DST changes at 02:00. It exists for explicit zones that change at midnight, such as `America/Santiago` and `America/Havana`.

### `filterByPeriod(rows, bounds, getInstant?)`

```ts
filterByPeriod<T extends { createdAt?: unknown }>(rows, bounds): T[]
filterByPeriod<T>(rows, bounds, getInstant: (row: T) => InstantInput | null | undefined): T[]
```

- `bounds` is any `PeriodBounds`: fiscal years and quarters, calendar months, academic terms and Summer sessions, academic coverage, or a `CustomDateRange`. Standard periods and custom ranges use the same function.
- Built on `isWithinPeriod()` (F18.1): `startUtc <= instant < endExclusiveUtc`.
- By default each row's full `createdAt` timestamp is used. There is **no fallback to `submittedAt`**, even when `createdAt` is missing.
- Keeps input order, never mutates `rows`, and always returns a new array (also when nothing matches).

Standard period bounds come from the F18.1 APIs (`getFiscalYearPeriod`, `getFiscalQuarterPeriod`, `getCalendarMonthPeriod`, `getAcademicPeriodByKey`, …). Callers should never rebuild them.

## 5. Inclusive dates, half-open bounds

Custom range dates are **inclusive local dates**. They become **half-open UTC bounds**: from local midnight at the start of `startDate` up to, but excluding, local midnight at the start of the day after `endDate`.

For `2026-04-01..2026-04-30` in `America/New_York`:

| Instant                  | Included |
| ------------------------ | -------- |
| `startUtc` − 1 ms        | No       |
| `startUtc`               | Yes      |
| `endExclusiveUtc` − 1 ms | Yes      |
| `endExclusiveUtc`        | No       |

Adjacent periods and ranges share a boundary instant, and it belongs to the later one, as for every F18 period.

A custom range equals a standard period when its local dates and zone match that period's boundaries:

- An academic term built from its published `localStartDate`/`localEndDate` in `America/New_York` has the term's exact bounds and returns the same rows.
- A calendar month or fiscal quarter equals a custom range with the same dates **only in UTC**. The application's Eastern custom ranges are offset by four or five hours from them (section 3).

## 6. Daylight saving time

Bounds follow the zone's offsets, so days on which DST changes have their real length:

| Local day (America/New_York) | `startUtc`                 | `endExclusiveUtc`          | Length   |
| ---------------------------- | -------------------------- | -------------------------- | -------- |
| `2026-03-08` (DST starts)    | `2026-03-08T05:00:00.000Z` | `2026-03-09T04:00:00.000Z` | 23 hours |
| `2026-11-01` (DST ends)      | `2026-11-01T04:00:00.000Z` | `2026-11-02T05:00:00.000Z` | 25 hours |
| `2028-02-29` (leap day)      | `2028-02-29T05:00:00.000Z` | `2028-03-01T05:00:00.000Z` | 24 hours |

## 7. Invalid timestamps

Rows are matched by strict instant parsing (`toValidInstant`, F18.1/F18.3). A row is **excluded**, never assigned to any period or range, and never causes an exception when its timestamp is:

- missing, `undefined`, `null` or empty;
- not a timestamp (`"not a date"`), or an impossible one (`2026-08-32T…`);
- date-only (`"2026-08-15"`) or without an offset (`"2026-08-15T12:00:00"`);
- the Postgres text form (`"2026-08-15 12:00:00+00"`);
- an invalid `Date`, `NaN`, or another type.

A row with only `submittedAt` (for example the date-only mock requests) is excluded, even when `submittedAt` is a full timestamp. Supabase's `created_at` form (`"2026-11-18T12:34:56.123456+00:00"`), a valid `Date` and epoch milliseconds are accepted.

## 8. Testing

Run:

```sh
npx vitest run src/lib/date-range-filter.test.ts
npx vitest run
npx tsc --noEmit
```

`date-range-filter.test.ts` covers:

- **Module boundaries and policy:** allowed imports only, no import cycle, no `resolveViewerTimeZone` import, fixed institutional zone, no `"custom"` reporting-period kind.
- **Validation:** every error code; missing, `null`, empty and whitespace values; non-string values; malformed and impossible dates; unsupported zones; reversed ranges; missing midnights at either edge; `9999-12-31`; collected errors; frozen results; a no-throw sweep over many untrusted values.
- **Boundaries:** start − 1 ms, start, end − 1 ms, end; DST start and end days; leap day; a year-end range.
- **Cross-period filtering:** fiscal year (the July 1 UTC boundary) and quarters, calendar months, academic terms and a Summer session, academic coverage, the winter break between Fall and Spring, a custom range spanning fiscal quarters, months and academic terms, and custom ranges equal to an academic term (Eastern) and a calendar month and fiscal quarter (UTC).
- **Mixed zones:** the August 31, 9 pm Eastern example.
- **Invalid rows:** each case in section 7, with no `submittedAt` fallback.
- **Immutability:** frozen input is unchanged, input order is kept, and a new array is always returned.
- **Host independence:** the F18.3 approach, reloading modules under seven host `TZ` values and comparing every validation and filtering result with the UTC baseline, with a guard that the host zone really changed.

The F18.1, F18.2 and F18.3 test files are unchanged and must keep passing.

## 9. Known limitations

- The filter runs only on rows already loaded through RLS. No server-side query uses these bounds yet.
- No component uses this module yet. If UI is added later, it should pass `CUSTOM_DATE_RANGE_TIME_ZONE`, and should note that the displayed `submittedAt` is a UTC date (F18.3 section 7): a request made at 9 pm Eastern on March 31 matches a range ending March 31 but is shown as April 1.
- `sortRequests()` in `request-list.ts` parses timestamps leniently with `Date.parse`, while this filter is strict, so a row with a malformed `createdAt` can be sorted but never matched.
- A range's `key` and `label` use the zone exactly as given. Intl accepts case variants and legacy names (`US/Eastern`), which produce different keys for the same bounds. The application always passes `CUSTOM_DATE_RANGE_TIME_ZONE`.
