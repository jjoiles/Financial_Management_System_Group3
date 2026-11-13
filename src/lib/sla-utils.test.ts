import { describe, expect, it } from "vitest";
import { calculateStageSla } from "./sla-utils";

describe("calculateStageSla", () => {
  const start = "2026-11-13T09:00:00.000Z";

  it("identifies a stage that is on track", () => {
    const result = calculateStageSla(
      {
        stageName: "Department Review",
        startedAt: start,
        durationHours: 48,
      },
      new Date("2026-11-13T12:00:00.000Z"),
    );

    expect(result.status).toBe("on_track");
    expect(result.elapsedHours).toBe(3);
    expect(result.remainingHours).toBe(45);
  });

  it("identifies a stage approaching its deadline", () => {
    const result = calculateStageSla(
      {
        stageName: "Department Review",
        startedAt: start,
        durationHours: 48,
      },
      new Date("2026-11-14T10:00:00.000Z"),
    );

    expect(result.status).toBe("approaching");
    expect(result.remainingHours).toBe(23);
  });

  it("identifies an overdue stage", () => {
    const result = calculateStageSla(
      {
        stageName: "Department Review",
        startedAt: start,
        durationHours: 24,
      },
      new Date("2026-11-14T10:00:00.000Z"),
    );

    expect(result.status).toBe("overdue");
    expect(result.remainingHours).toBe(-1);
  });

  it("marks a completed stage as completed", () => {
    const result = calculateStageSla(
      {
        stageName: "Department Review",
        startedAt: start,
        durationHours: 24,
        completedAt: "2026-11-14T10:00:00.000Z",
      },
      new Date("2026-11-15T10:00:00.000Z"),
    );

    expect(result.status).toBe("completed");
    expect(result.elapsedHours).toBe(25);
  });

  it("calculates the exact deadline correctly", () => {
    const result = calculateStageSla(
      {
        stageName: "Department Review",
        startedAt: start,
        durationHours: 24,
      },
      new Date("2026-11-14T09:00:00.000Z"),
    );

    expect(result.status).toBe("approaching");
    expect(result.remainingHours).toBe(0);
  });

  it("uses a configurable approaching threshold", () => {
    const result = calculateStageSla(
      {
        stageName: "Department Review",
        startedAt: start,
        durationHours: 48,
      },
      new Date("2026-11-14T00:00:00.000Z"),
      12,
    );

    expect(result.status).toBe("on_track");
  });

  it("rejects negative SLA durations", () => {
    expect(() =>
      calculateStageSla(
        {
          stageName: "Department Review",
          startedAt: start,
          durationHours: -1,
        },
        new Date("2026-11-13T12:00:00.000Z"),
      ),
    ).toThrow("SLA durations and thresholds cannot be negative.");
  });

  it("rejects invalid start dates", () => {
    expect(() =>
      calculateStageSla({
        stageName: "Department Review",
        startedAt: "invalid-date",
        durationHours: 24,
      }),
    ).toThrow("Invalid stage start date.");
  });
});