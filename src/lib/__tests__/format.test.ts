import { describe, expect, it } from "vitest";
import { formatCurrency } from "../format";

describe("formatCurrency", () => {
  it("formats whole dollars with cents", () => {
    expect(formatCurrency(12500)).toBe("$12,500.00");
  });

  it("rounds to two decimal places", () => {
    expect(formatCurrency(1234.567)).toBe("$1,234.57");
  });

  it("formats zero", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("shows $0.00 for an invalid amount instead of $NaN", () => {
    expect(formatCurrency(Number("not a number"))).toBe("$0.00");
  });
});
