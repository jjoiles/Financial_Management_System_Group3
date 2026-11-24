import { describe, expect, it } from "vitest";
import { toQrCodeImageSrc } from "../qr-code";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h1v1H0z"/></svg>';
const decode = (src: string | null) =>
  decodeURIComponent((src ?? "").replace("data:image/svg+xml;charset=utf-8,", ""));

describe("toQrCodeImageSrc", () => {
  it("re-encodes the data URL Supabase returns", () => {
    const src = toQrCodeImageSrc(`data:image/svg+xml;utf-8,${svg}`);
    expect(src).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    expect(decode(src)).toBe(svg);
  });

  it("accepts a raw SVG string from older Supabase versions", () => {
    expect(decode(toQrCodeImageSrc(svg))).toBe(svg);
  });

  it("accepts an XML declaration before the SVG", () => {
    const withDecl = `<?xml version="1.0" encoding="UTF-8"?>${svg}`;
    expect(decode(toQrCodeImageSrc(withDecl))).toBe(withDecl);
  });

  it("encodes characters that would break an unencoded data URL", () => {
    const src = toQrCodeImageSrc('<svg fill="#000"><text>a&b</text></svg>');
    expect(src).not.toContain("#");
    expect(src).not.toContain("<");
  });

  it.each([
    undefined,
    null,
    "",
    "<img src=x onerror=alert(1)>",
    "javascript:alert(1)",
    "data:text/html,<svg>",
  ])("returns null for non-SVG input %s", (value) => {
    expect(toQrCodeImageSrc(value)).toBeNull();
  });
});
