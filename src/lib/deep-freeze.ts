/**
 * Recursively freezes plain data in place so it cannot be changed at runtime,
 * and returns the same value.
 *
 * Each object is visited once, so shared and circular references terminate
 * instead of recursing forever. Like Object.values(), only own enumerable
 * string-keyed properties are followed. Callers that need to reject cycles or
 * unexpected properties must check the data before freezing it (see
 * validateReportingPeriodConfig).
 *
 * This module has no imports so any module, including data-only modules, can
 * use it without creating a dependency cycle.
 */
export function deepFreeze<T>(value: T): T {
  freezeOnce(value, new WeakSet());
  return value;
}

function freezeOnce(value: unknown, visited: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  Object.values(value).forEach((child) => freezeOnce(child, visited));
  Object.freeze(value);
}
