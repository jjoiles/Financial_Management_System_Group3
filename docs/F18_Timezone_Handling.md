# F18.3 – Timezone Handling

**Feature:** F18 Temporal Filtering (Academic Term/Month)
**Sub-issue:** F18.3 – Establish Timezone Handling
**Builds on:** F18.1 – Institutional reporting periods, F18.2 – Reporting Period Configuration

## 1. Purpose and scope

F18.3 makes the application's timezone rules explicit and gives later F18 work one reusable, browser-safe module for them, `src/lib/time-zones.ts`.

It does **not** change any F18.1 or F18.2 behavior: every reporting period, coverage result, public API and the configuration data stay the same, and `REPORTING_PERIOD_CONFIG_VERSION` is unchanged.

Out of scope:

| Topic                                                 | Where it belongs                                   |
| ----------------------------------------------------- | -------------------------------------------------- |
| Filtering requests by period, including custom ranges | F18.4                                              |
| Choosing the zone for F18.4 custom date ranges        | F18.4 (decided: `America/New_York`, see section 2) |
| Moving existing UI components to `formatInstant()`    | Not part of F18.3                                  |
| Existing date bugs outside F18 (section 7)            | Separate issues                                    |

## 2. Policy

There are three separate concerns. Each has one rule.

| Concern                     | Rule                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Storage and comparison      | Instants are stored in UTC (`TIMESTAMPTZ`) and compared as epoch milliseconds.                   |
| Reporting-period boundaries | Each period kind has a fixed zone (`REPORTING_PERIOD_TIME_ZONES`, below).                        |
| Display                     | The viewer's zone may change how an instant is **shown**, never which period or filter it is in. |

`REPORTING_PERIOD_TIME_ZONES` in `src/lib/reporting-periods.ts` (frozen):

| Kind             | Zone               | Why                                                                                              |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `fiscal`         | `UTC`              | `deriveFiscalPeriod()` and the `f4_enforce_request_metadata()` SQL trigger both use UTC months.  |
| `calendar-month` | `UTC`              | F18.1 defines calendar months in UTC.                                                            |
| `academic`       | `America/New_York` | Howard publishes its academic calendar as local dates in Eastern time (`INSTITUTION_TIME_ZONE`). |

The map **describes** existing behavior; fiscal and calendar-month code still computes from UTC fields, and tests check that every fiscal and month boundary is a UTC midnight and every academic boundary is an Eastern midnight.

**Custom date ranges (F18.4):** use the fixed institutional zone, `America/New_York` (`CUSTOM_DATE_RANGE_TIME_ZONE` in `src/lib/date-range-filter.ts`, equal to `INSTITUTION_TIME_ZONE`). Users do not choose a zone, and the viewer's zone never affects which rows match. A custom range is not a reporting-period kind, so it is not part of `REPORTING_PERIOD_TIME_ZONES`. See [F18_Cross_Period_Filtering.md](F18_Cross_Period_Filtering.md).

Because the zones differ, the same instant can fall in different periods. For example, 9 pm Eastern on August 31 is in the September calendar month (UTC) but still in August for the academic calendar.

## 3. Module layout and imports

| File                           | Role                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `src/lib/time-zones.ts`        | Zone constants, local-date and instant helpers, zone conversion, display formatting |
| `src/lib/reporting-periods.ts` | Period kinds and lookups, `REPORTING_PERIOD_TIME_ZONES`; re-exports moved helpers   |
| `src/lib/time-zones.test.ts`   | F18.3 tests                                                                         |

`time-zones.ts` has **no imports**, not even type imports. It is a leaf of the import graph, so any module can use it without creating a cycle. A test fails if an import is added.

```
reporting-period-config.ts ──▶ reporting-periods.ts ──▶ time-zones.ts   (no imports)
```

`REPORTING_PERIOD_TIME_ZONES` lives in `reporting-periods.ts`, next to `ReportingPeriodKind`, because putting it in `time-zones.ts` would require an import.

### Moved from `reporting-periods.ts`

These moved to `time-zones.ts` without changes and are re-exported from `reporting-periods.ts`, so existing imports keep working and refer to the **same** function objects:

- `isValidLocalDate`, `nextLocalDate`, `toValidInstant`, `zonedLocalMidnightToUtc`
- types `LocalDateRange`, `PeriodBounds`; `ReportingInstantInput` is now an alias of `InstantInput`

`ACADEMIC_TIME_ZONE` is now defined as `INSTITUTION_TIME_ZONE`; its value and literal type (`"America/New_York"`) are unchanged.

## 4. API (`src/lib/time-zones.ts`)

Error policy, as in F18.1: an invalid **instant** (bad data) returns `null`; an invalid **zone**, invalid local date or impossible range (a programming or configuration error) throws a `RangeError`.

Every new function takes an explicit zone. Only `zonedLocalMidnightToUtc` keeps its F18.1 default (`America/New_York`), for compatibility.

| Function                                                                            | Returns                | Notes                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isValidTimeZone(value)`                                                            | `boolean`              | True for a non-empty string the runtime's Intl accepts. Never throws.                                                                                                                |
| `toZonedLocalDate(instant, timeZone)`                                               | `YYYY-MM-DD` or `null` | The local date an instant falls on. Inverse of `zonedLocalMidnightToUtc`. `null` for an invalid instant, or one within a day of the year 0001–9999 limits.                           |
| `zonedToday(timeZone, now?)`                                                        | `YYYY-MM-DD`           | Today's date in the zone. Throws for an invalid `now`; never falls back to another time.                                                                                             |
| `localDateRangeToUtcBounds(range, timeZone)`                                        | `PeriodBounds`         | Inclusive local dates to half-open UTC bounds. Zone is **required**. Throws for an invalid zone or date, start after end, an end of `9999-12-31`, or a midnight that does not exist. |
| `zonedLocalMidnightToUtc(localDate, timeZone?)`                                     | `Date`                 | Moved from F18.1, unchanged.                                                                                                                                                         |
| `toValidInstant(input)`                                                             | `Date` or `null`       | Moved from F18.1, unchanged: date-only strings and timestamps without an offset are rejected.                                                                                        |
| `resolveViewerTimeZone(fallback?)`                                                  | zone string            | **Display only.** The runtime's zone, or `fallback` (default `America/New_York`) when it is missing or invalid.                                                                      |
| `formatInstant(instant, { timeZone, locale?, includeTime?, includeTimeZoneName? })` | `string` or `null`     | **Display only.** E.g. `"Nov 17, 2026, 8:00 PM EST"`. Locale defaults to `en-US` so output never depends on the host. Not yet used by any component.                                 |

### Rules for callers

- **Filtering** (F18.4 and later): use period bounds from `reporting-periods.ts`, or `localDateRangeToUtcBounds()` with a zone from `REPORTING_PERIOD_TIME_ZONES`. For custom date ranges, use `validateCustomDateRange()` with `CUSTOM_DATE_RANGE_TIME_ZONE`, and filter with `filterByPeriod()` (both in `date-range-filter.ts`). Never pass `resolveViewerTimeZone()` into anything that decides which rows match.
- **Instants**: pass a request's full `createdAt` timestamp, never the date-only `submittedAt`, which `toValidInstant` rejects.
- **Display**: call `resolveViewerTimeZone()` in the browser. On the server (Cloudflare Workers) the runtime zone is usually `UTC`, so a server render would show UTC times.
- **Zone names**: Intl also accepts case variants, legacy links (`US/Eastern`) and fixed offsets (`+05:00`). `"EST"` is a fixed UTC−5 zone **without** daylight saving time; use `America/New_York` for Eastern time. The runtime may report a legacy ID for the viewer's zone (e.g. `Asia/Calcutta` for `Asia/Kolkata`); both are valid.

## 5. Daylight saving time and other edge cases

- **America/New_York** changes at 02:00, so local midnight always exists. A boundary is 05:00Z in standard time and 04:00Z in daylight time. The day DST starts is 23 hours long and the day it ends is 25 hours long; bounds follow this automatically.
- **Zones that change at midnight** (e.g. `America/Santiago`, `America/Havana`) have days with no local midnight. `zonedLocalMidnightToUtc` and `localDateRangeToUtcBounds` throw a `RangeError` for those days instead of guessing.
- **Half-hour and quarter-hour offsets** (`Asia/Kolkata`, `Asia/Kathmandu`), **±14 hours** (`Pacific/Kiritimati`) and **30-minute DST shifts** (`Australia/Lord_Howe`) are tested.
- **Year limits**: local dates use four-digit years. Intl reports year 0 as year 1, so `toZonedLocalDate` returns `null` within a day of the 0001–9999 limits rather than a wrong date.
- **Formatting** text comes from the runtime's ICU data; the space before AM/PM differs between ICU versions (U+0020 or U+202F).

## 6. Testing

Run:

```sh
npx vitest run src/lib/time-zones.test.ts src/lib/reporting-periods.test.ts src/lib/reporting-period-config.test.ts
npx vitest run
npx tsc --noEmit
```

`time-zones.test.ts` covers:

- **Module boundaries**: no imports in `time-zones.ts`; re-exports are the same functions; re-exported types are identical.
- **Conversions**: DST start and end days, leap days, year boundaries, unusual offsets, midnights that do not exist, invalid zones, dates and instants.
- **Round trip**: every date from 2024 through 2028 in seven zones converts to local midnight and back, and the millisecond before midnight is the previous date.
- **Policy**: fiscal (FY2025–FY2029) and calendar-month (2025–2028) boundaries are UTC midnights; every shipped academic period and the coverage are reproduced exactly by `localDateRangeToUtcBounds()` in `America/New_York`.
- **Host independence**: the test changes `process.env.TZ` at runtime across seven host zones, reloads the modules each time, and checks that every result matches the UTC baseline. A guard checks that the host zone really changed, so the test cannot pass without testing anything. Only `resolveViewerTimeZone()` follows the host zone.

The existing F18.1 and F18.2 test files are unchanged and must keep passing.

## 7. Known issues outside F18.3

These use time zones inconsistently but belong to other features. F18.3 documents them and does not change them.

| Area                               | Issue                                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needed-by date (F22, submit form)  | The date picker's minimum uses the UTC date, browser validation uses the viewer's local date, and the database trigger uses the Eastern date, so they can disagree late in the evening. |
| `submittedAt` (`requests-data.ts`) | It is `created_at` cut to its UTC date, so a request made in the evening Eastern time shows the next day.                                                                               |
| Request number year (F4)           | The client uses the host's local year; the SQL trigger uses the UTC year. They can differ around New Year.                                                                              |
| Routing (`daysUntil`)              | Uses host-local midnight, so the "expedited" flag can depend on where routing runs.                                                                                                     |
| Timestamp displays                 | Several components use `toLocaleString()` with no fixed locale or zone label. `formatInstant()` is available for a future migration.                                                    |

## 8. Known limitations

- The policy is fixed in code. There is no per-user or administrator zone setting, by design: filtering must not depend on the viewer.
- F18.4 custom date ranges use the fixed institutional zone, `America/New_York` (section 2). `localDateRangeToUtcBounds()` and `validateCustomDateRange()` still require the zone explicitly, so no caller can inherit a different one by default.
- Time zone rules come from the runtime's IANA data (ICU). A future rule change by a government takes effect when browsers and Node update their data.
