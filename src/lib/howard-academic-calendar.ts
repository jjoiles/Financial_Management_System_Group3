import type { AcademicCalendar, AcademicCalendarSource } from "@/lib/reporting-periods";

/**
 * F18.1: Official Howard University academic calendar dates for academic
 * reporting periods.
 *
 * Dates are local dates in Eastern time (America/New_York);
 * reporting-periods.ts converts them to UTC instants. Every end date is
 * inclusive: the period ends at the next local midnight.
 *
 * Which published date is used
 * - Start: the event labeled "Formal Classes Begin".
 * - End: the event labeled "Semester Ends" or "Summer Session ... Ends".
 * - Where a calendar's event table and its summary list disagree, the
 *   labeled event in the table wins. A summary date is used only when the
 *   table has no labeled event for that boundary.
 * - Summer belongs to the academic year that began the previous fall
 *   (Summer 2026 is part of AY2025-2026).
 * - The Summer parent period has its own end date only when the calendar
 *   publishes a semester-level end event that differs from the sessions'
 *   end dates. A missing parent start or end falls back to the earliest
 *   session start or latest session end.
 *
 * Only add dates that appear in an official Howard source, and cite only
 * sources that actually contain that year's dates. F18.2 will provide the
 * mechanism for maintaining this data; until then, calendar changes are code
 * changes reviewed like any other.
 */

/** Recursively freezes calendar data so it cannot be changed at runtime. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Contains AY2025-2026 only (Fall 2025, Spring 2026, Summer 2026).
 * `retrievedOn` is the date the dates were verified against this document.
 */
const ACADEMIC_CALENDAR_2025_2026_PDF: AcademicCalendarSource = {
  url: "https://admission.howard.edu/sites/admission.howard.edu/files/2026-04/2025-2026%20Academic%20Calendar%204.22.26docx.pdf",
  publishedBy: "Howard University",
  retrievedOn: "2026-11-18",
};

/** Shows the 2026-2027 academic calendar inline. */
const HOWARD_CALENDARS_PAGE: AcademicCalendarSource = {
  url: "https://howard.edu/calendars",
  publishedBy: "Howard University",
  retrievedOn: "2026-11-18",
};

export const HOWARD_ACADEMIC_CALENDAR: AcademicCalendar = deepFreeze([
  {
    academicYear: "AY2025-2026",
    sources: [ACADEMIC_CALENDAR_2025_2026_PDF],
    // Fall: "Monday August 18 – Formal Classes Begin"; "Tuesday December 16 – Fall (First) 2025 Semester Ends".
    fall: { startDate: "2025-08-18", endDate: "2025-12-16" },
    // Spring: "Monday January 12 – Formal Classes Begin"; "Friday May 8 – Second Semester Ends".
    spring: { startDate: "2026-01-12", endDate: "2026-05-08" },
    summer: {
      // "Saturday July 25 – Summer Semester Ends". No separate Summer start
      // event is published, so the parent starts with the earliest session.
      endDate: "2026-07-25",
      sessions: {
        // Begins "Monday May 18 – Summer Session I, Summer 10-Week Session: Formal Classes Begin".
        // Ends "Sunday June 21 – Summer Session I Ends" (the summary list says June 20).
        "summer-1": { startDate: "2026-05-18", endDate: "2026-06-21" },
        // Begins in the "Sunday June 21" row: "Summer Session II: Formal Classes Begin"
        // (the summary list says June 22). The table has no Session II end event,
        // so the end is the summary list's "Summer Session II: June 22 – July 24".
        "summer-2": { startDate: "2026-06-21", endDate: "2026-07-24" },
        // Begins May 18 (see Session I). The table has no 10-Week end event, so the
        // end is the summary list's "Summer 10-Week Session: May 18 – July 24".
        "summer-10wk": { startDate: "2026-05-18", endDate: "2026-07-24" },
      },
    },
  },
  {
    academicYear: "AY2026-2027",
    sources: [HOWARD_CALENDARS_PAGE],
    // Fall: "CLASSES BEGIN" Monday August 17 ("Formal classes begin for Fall 2026");
    // "FALL SEMESTER ENDS; OFFICIAL GRADUATION DATE" Wednesday December 16.
    fall: { startDate: "2026-08-17", endDate: "2026-12-16" },
    // Spring: "CLASSES BEGIN" Monday January 11 ("Formal Classes Begin"); "SEMESTER ENDS" Friday May 7.
    spring: { startDate: "2027-01-11", endDate: "2027-05-07" },
    summer: {
      // "SUMMER SESSION ENDS; OFFICIAL GRADUATION DATE" Saturday July 24 is the
      // same day the sessions end, so the parent spans its sessions.
      sessions: {
        // "SUMMER SESSION I & 10-WEEK BEGIN" Monday May 17; "SUMMER SESSION I ENDS" Sunday June 20.
        "summer-1": { startDate: "2027-05-17", endDate: "2027-06-20" },
        // "SUMMER SESSION II BEGINS" Monday June 21; "SUMMER SESSION ENDS" Saturday July 24.
        "summer-2": { startDate: "2027-06-21", endDate: "2027-07-24" },
        // Begins May 17 (see Session I); "Summer 10-Week Session: May 17 – July 24".
        "summer-10wk": { startDate: "2027-05-17", endDate: "2027-07-24" },
      },
    },
  },
]);
