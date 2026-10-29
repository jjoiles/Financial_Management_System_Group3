import type { FinancialRequest } from "./mock-data";

/** Only the seven fields already present in FinReq's analytics export are included. */
export type ExportableRequest = Pick<
  FinancialRequest,
  "id" | "requester" | "department" | "fundingType" | "amount" | "status" | "updatedAt"
>;

const HEADERS = [
  "Request ID", "Requester", "Department", "Funding Type", "Amount", "Status", "Updated At",
] as const;

/**
 * CSV quoting is not spreadsheet formula protection. A malicious requester name
 * can begin with =, +, -, or @, optionally after whitespace/control characters.
 * Only text is prefixed: a legitimate negative numeric amount stays numeric.
 */
export function escapeCsvCell(value: string | number): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError("CSV numeric values must be finite");
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError("CSV cells must be strings or finite numbers");
  }
  const text = String(value);
  const safe = typeof value === "string" && /^[\s\uFEFF\u200B\u0000-\u001F]*[=+\-@]/u.test(text)
    ? `'${text}`
    : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Pure serializer; does not grant authorization to export the provided records. */
export function buildFinancialReportCsv(requests: readonly ExportableRequest[]): string {
  if (!Array.isArray(requests)) throw new TypeError("Requests must be an array");
  const rows = requests.map((request, index) => {
    if (!request || typeof request !== "object") {
      throw new TypeError(`Invalid request at index ${index}`);
    }
    const fields = [
      request.id, request.requester, request.department, request.fundingType,
      request.amount, request.status, request.updatedAt,
    ];
    return fields.map(escapeCsvCell).join(",");
  });
  return [HEADERS.map(escapeCsvCell).join(","), ...rows].join("\r\n");
}
