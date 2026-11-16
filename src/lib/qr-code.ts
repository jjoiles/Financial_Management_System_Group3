// Turns the TOTP QR code from Supabase MFA enrollment into an <img> source.
//
// Supabase returns `totp.qr_code` as "data:image/svg+xml;utf-8,<svg ...>"
// (older versions returned the raw SVG). Rendering it through an <img>
// instead of innerHTML means any script inside the SVG never runs.

const SVG_DATA_URL_PREFIX = /^data:image\/svg\+xml(;[a-z0-9=-]+)*,/i;

/**
 * Returns a properly encoded SVG data URL, or null when the value is not an
 * SVG (the caller then falls back to the manual key).
 */
export function toQrCodeImageSrc(qrCode: string | null | undefined): string | null {
  if (!qrCode) return null;
  const svg = qrCode.replace(SVG_DATA_URL_PREFIX, "").trim();
  if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
