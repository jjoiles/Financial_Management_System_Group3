import { describe, expect, it } from "vitest";

import type { ApprovalStageRow } from "./approval-stage-client";
import {
  RECENT_COMPLETED_LIMIT,
  buildDashboardStages,
  calculateQueuePerformance,
  formatDate,
  formatDuration,
  formatRemainingTime,
  getCompletedStageElapsedHours,
  indexRequestsById,
  summarizeDashboardStages,
  type SlaRequestSummary,
} from "./sla-dashboard";

const NOW = new Date("2026-11-18T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** ISO timestamp `hours` before NOW (negative = after NOW). */
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

let stageSeq = 0;

function stage(overrides: Partial<ApprovalStageRow> = {}): ApprovalStageRow {
  stageSeq += 1;
  return {
    id: `stage-${stageSeq}`,
    request_id: "req-1",
    workflow_revision: 1,
    stage_order: 1,
    queue_id: "department_budget",
    stage_name: "Department Budget Review",
    started_at: hoursAgo(10),
    deadline_at: hoursAgo(10 - 72),
    completed_at: null,
    duration_hours: 72,
    status: "active",
    ...overrides,
  };
}

function request(overrides: Partial<SlaRequestSummary> = {}): SlaRequestSummary {
  return {
    id: "req-1",
    request_number: "FR-2026-0001",
    title: "Lab equipment",
    department: "Biology",
    amount: 1200,
    status: "under_review",
    routed_to: "Department Budget",
    ...overrides,
  };
}

/** Active stage with the given remaining hours against NOW (72h SLA). */
const activeWithRemaining = (remaining: number, overrides: Partial<ApprovalStageRow> = {}) =>
  stage({ started_at: hoursAgo(72 - remaining), ...overrides });

/** Completed stage that finished `hoursAgoCompleted` before NOW after `elapsed` hours. */
const completedStage = (
  hoursAgoCompleted: number,
  elapsed: number,
  overrides: Partial<ApprovalStageRow> = {},
) =>
  stage({
    status: "completed",
    started_at: hoursAgo(hoursAgoCompleted + elapsed),
    completed_at: hoursAgo(hoursAgoCompleted),
    ...overrides,
  });

const summarize = (rows: ApprovalStageRow[]) =>
  summarizeDashboardStages(buildDashboardStages(rows, {}, NOW));

describe("indexRequestsById", () => {
  it("maps requests by id", () => {
    const a = request({ id: "a" });
    const b = request({ id: "b" });

    expect(indexRequestsById([a, b])).toEqual({ a, b });
  });

  it("keeps the last row when an id repeats", () => {
    const first = request({ id: "a", title: "First" });
    const last = request({ id: "a", title: "Last" });

    expect(indexRequestsById([first, last]).a.title).toBe("Last");
  });

  it("returns an empty map for no rows", () => {
    expect(indexRequestsById([])).toEqual({});
  });
});

describe("buildDashboardStages", () => {
  it("attaches the matching request and leaves missing requests undefined", () => {
    const known = stage({ request_id: "req-1" });
    const missing = stage({ request_id: "req-unknown" });
    const requests = indexRequestsById([request({ id: "req-1" })]);

    const [withRequest, withoutRequest] = buildDashboardStages([known, missing], requests, NOW);

    expect(withRequest.request?.request_number).toBe("FR-2026-0001");
    expect(withoutRequest.request).toBeUndefined();
    expect(withoutRequest.id).toBe(missing.id);
  });

  it("measures an active stage without completed_at against now", () => {
    const [result] = buildDashboardStages([stage({ started_at: hoursAgo(10) })], {}, NOW);

    expect(result.sla.status).toBe("on_track");
    expect(result.sla.elapsedHours).toBe(10);
    expect(result.sla.remainingHours).toBe(62);
  });

  it("falls back to started_at for a non-active stage without completed_at", () => {
    const [result] = buildDashboardStages(
      [stage({ status: "skipped", completed_at: null, started_at: hoursAgo(100) })],
      {},
      NOW,
    );

    expect(result.sla.status).toBe("completed");
    expect(result.sla.elapsedHours).toBe(0);
    expect(result.sla.remainingHours).toBe(72);
  });

  it("uses completed_at for a non-active stage when present", () => {
    const [result] = buildDashboardStages([completedStage(5, 30)], {}, NOW);

    expect(result.sla.status).toBe("completed");
    expect(result.sla.elapsedHours).toBe(30);
  });

  it("treats an active stage that has completed_at as completed", () => {
    const [result] = buildDashboardStages(
      [stage({ status: "active", started_at: hoursAgo(10), completed_at: hoursAgo(4) })],
      {},
      NOW,
    );

    expect(result.sla.status).toBe("completed");
    expect(result.sla.elapsedHours).toBe(6);
  });

  it("preserves input order, copies row fields and does not mutate input", () => {
    const rows = [stage(), stage(), stage()];
    const snapshot = structuredClone(rows);

    const result = buildDashboardStages(rows, {}, NOW);

    expect(result.map((s) => s.id)).toEqual(rows.map((s) => s.id));
    expect(result[0]).toMatchObject(rows[0]);
    expect(rows).toEqual(snapshot);
  });

  it("throws when a stage has an invalid start date", () => {
    expect(() => buildDashboardStages([stage({ started_at: "not-a-date" })], {}, NOW)).toThrow(
      "Invalid stage start date.",
    );
  });

  it("returns an empty array for no stages", () => {
    expect(buildDashboardStages([], {}, NOW)).toEqual([]);
  });
});

describe("summarizeDashboardStages", () => {
  it("groups active stages by SLA status using the approaching threshold", () => {
    const onTrack = activeWithRemaining(48);
    const atThreshold = activeWithRemaining(24);
    const approaching = activeWithRemaining(5);
    const overdue = activeWithRemaining(-8);

    const summary = summarize([onTrack, atThreshold, approaching, overdue]);

    expect(summary.activeStages).toHaveLength(4);
    expect(summary.onTrackStages.map((s) => s.id)).toEqual([onTrack.id]);
    expect(summary.approachingStages.map((s) => s.id)).toEqual([atThreshold.id, approaching.id]);
    expect(summary.overdueStages.map((s) => s.id)).toEqual([overdue.id]);
  });

  it("counts skipped and cancelled stages only in the total", () => {
    const summary = summarize([
      activeWithRemaining(48),
      completedStage(1, 10),
      stage({ status: "skipped" }),
      stage({ status: "cancelled" }),
    ]);

    expect(summary.totalStages).toBe(4);
    expect(summary.activeStages).toHaveLength(1);
    expect(summary.completedStages).toHaveLength(1);
  });

  it("counts an active stage with completed_at as active but in no SLA bucket", () => {
    const summary = summarize([
      activeWithRemaining(48),
      stage({ status: "active", started_at: hoursAgo(10), completed_at: hoursAgo(4) }),
    ]);

    expect(summary.activeStages).toHaveLength(2);
    expect(
      summary.onTrackStages.length +
        summary.approachingStages.length +
        summary.overdueStages.length,
    ).toBe(1);
  });

  it("sorts active stages by ascending remaining time, overdue first", () => {
    const a = activeWithRemaining(30);
    const b = activeWithRemaining(-2);
    const c = activeWithRemaining(10);

    const summary = summarize([a, b, c]);

    expect(summary.activeSorted.map((s) => s.id)).toEqual([b.id, c.id, a.id]);
    expect(summary.activeStages.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it("keeps only the most recent completed stages, newest first", () => {
    const rows = Array.from({ length: 12 }, (_, i) => completedStage(i + 1, 5));

    const summary = summarize(rows);

    expect(RECENT_COMPLETED_LIMIT).toBe(10);
    expect(summary.completedStages).toHaveLength(12);
    expect(summary.recentCompleted).toHaveLength(10);
    expect(summary.recentCompleted.map((s) => s.id)).toEqual(rows.slice(0, 10).map((s) => s.id));
  });

  it("orders recent completed stages by completed_at regardless of input order", () => {
    const older = completedStage(20, 5);
    const newest = completedStage(1, 5);
    const middle = completedStage(10, 5);

    const summary = summarize([older, newest, middle]);

    expect(summary.recentCompleted.map((s) => s.id)).toEqual([newest.id, middle.id, older.id]);
  });

  it("sorts a completed stage without completed_at by its started_at", () => {
    const finishedEarlier = completedStage(10, 5);
    const noCompletion = stage({
      status: "completed",
      completed_at: null,
      started_at: hoursAgo(3),
    });
    const finishedLatest = completedStage(1, 5);

    const summary = summarize([finishedEarlier, noCompletion, finishedLatest]);

    expect(summary.recentCompleted.map((s) => s.id)).toEqual([
      finishedLatest.id,
      noCompletion.id,
      finishedEarlier.id,
    ]);
  });

  it("keeps input order for completed stages with the same timestamp", () => {
    const first = completedStage(2, 5);
    const second = completedStage(2, 5);

    const summary = summarize([first, second]);

    expect(summary.recentCompleted.map((s) => s.id)).toEqual([first.id, second.id]);
  });

  it("reports total stages and unique request count", () => {
    const summary = summarize([
      stage({ request_id: "r1" }),
      stage({ request_id: "r1", status: "completed", completed_at: hoursAgo(1) }),
      stage({ request_id: "r2" }),
    ]);

    expect(summary.totalStages).toBe(3);
    expect(summary.requestCount).toBe(2);
  });

  it("includes queue performance for all completed stages", () => {
    const rows = Array.from({ length: 12 }, (_, i) => completedStage(i + 1, 4));

    const [queue] = summarize(rows).queuePerformance;

    expect(queue.count).toBe(12);
    expect(queue.averageHours).toBe(4);
  });

  it("does not mutate the input array when sorting", () => {
    const built = buildDashboardStages(
      [
        activeWithRemaining(30),
        activeWithRemaining(-2),
        completedStage(10, 5),
        completedStage(1, 5),
      ],
      {},
      NOW,
    );
    const ids = built.map((s) => s.id);

    summarizeDashboardStages(Object.freeze([...built]));
    summarizeDashboardStages(built);

    expect(built.map((s) => s.id)).toEqual(ids);
  });

  it("returns empty groups and zero counts for no stages", () => {
    expect(summarizeDashboardStages([])).toEqual({
      activeStages: [],
      onTrackStages: [],
      approachingStages: [],
      overdueStages: [],
      completedStages: [],
      activeSorted: [],
      recentCompleted: [],
      queuePerformance: [],
      totalStages: 0,
      requestCount: 0,
    });
  });
});

describe("calculateQueuePerformance", () => {
  it("averages processing time per queue in first-seen order", () => {
    const result = calculateQueuePerformance([
      completedStage(1, 10, { queue_id: "cfo_office", stage_name: "CFO Review" }),
      completedStage(2, 4, { queue_id: "department_budget", stage_name: "Department Review" }),
      completedStage(3, 20, { queue_id: "cfo_office", stage_name: "CFO Review" }),
    ]);

    expect(result).toEqual([
      { queueId: "cfo_office", name: "CFO Review", count: 2, averageHours: 15 },
      { queueId: "department_budget", name: "Department Review", count: 1, averageHours: 4 },
    ]);
  });

  it("names each queue after the first stage seen for it", () => {
    const [queue] = calculateQueuePerformance([
      completedStage(1, 2, { queue_id: "q", stage_name: "First Name" }),
      completedStage(2, 2, { queue_id: "q", stage_name: "Later Name" }),
    ]);

    expect(queue.name).toBe("First Name");
  });

  it("excludes stages without completed_at", () => {
    const result = calculateQueuePerformance([
      completedStage(1, 6),
      stage({ status: "completed", completed_at: null }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(1);
    expect(result[0].averageHours).toBe(6);
  });

  it("excludes negative durations", () => {
    const result = calculateQueuePerformance([
      completedStage(1, 6),
      stage({ status: "completed", started_at: hoursAgo(1), completed_at: hoursAgo(5) }),
    ]);

    expect(result[0].count).toBe(1);
    expect(result[0].averageHours).toBe(6);
  });

  it("excludes non-finite durations", () => {
    const result = calculateQueuePerformance([
      completedStage(1, 6),
      stage({ status: "completed", completed_at: "not-a-date" }),
    ]);

    expect(result[0].count).toBe(1);
    expect(result[0].averageHours).toBe(6);
  });

  it("omits a queue whose stages were all excluded", () => {
    const result = calculateQueuePerformance([
      stage({ queue_id: "empty", status: "completed", completed_at: null }),
      stage({ queue_id: "empty", status: "completed", completed_at: "not-a-date" }),
    ]);

    expect(result).toEqual([]);
  });

  it("does not mutate its input", () => {
    const rows = [completedStage(1, 6), completedStage(2, 8)];
    const snapshot = structuredClone(rows);

    calculateQueuePerformance(rows);

    expect(rows).toEqual(snapshot);
  });
});

describe("getCompletedStageElapsedHours", () => {
  it("returns hours between start and completion", () => {
    expect(getCompletedStageElapsedHours(completedStage(2, 30))).toBe(30);
  });

  it("returns 0 when completed_at is missing", () => {
    expect(getCompletedStageElapsedHours({ started_at: hoursAgo(5), completed_at: null })).toBe(0);
  });

  it("returns a negative duration unchanged", () => {
    expect(
      getCompletedStageElapsedHours({ started_at: hoursAgo(1), completed_at: hoursAgo(5) }),
    ).toBe(-4);
  });

  it("returns NaN for an invalid completion date", () => {
    expect(
      getCompletedStageElapsedHours({ started_at: hoursAgo(1), completed_at: "not-a-date" }),
    ).toBeNaN();
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "Less than 1 minute"],
    [0.001, "Less than 1 minute"],
    [0.5, "30m"],
    [1.5, "1h 30m"],
    [5, "5h"],
    [24, "1d"],
    [49.75, "2d 1h"],
    [-2.5, "2h 30m"],
    [-30, "1d 6h"],
  ])("formats %s hours as %s", (hours, expected) => {
    expect(formatDuration(hours)).toBe(expected);
  });
});

describe("formatRemainingTime", () => {
  it("labels negative remaining time as overdue", () => {
    expect(formatRemainingTime(-2)).toBe("Overdue by 2h");
  });

  it("treats zero remaining time as not overdue", () => {
    expect(formatRemainingTime(0)).toBe("Less than 1 minute left");
  });

  it("labels positive remaining time as time left", () => {
    expect(formatRemainingTime(26.5)).toBe("1d 2h left");
  });
});

describe("formatDate", () => {
  it("returns a dash for null or empty values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
  });

  it("returns Invalid date for unparseable values", () => {
    expect(formatDate("not-a-date")).toBe("Invalid date");
  });

  it("uses the runtime locale for valid dates", () => {
    const value = "2026-11-18T12:00:00.000Z";

    expect(formatDate(value)).toBe(new Date(value).toLocaleString());
  });
});
