/**
 * Formats an amount in US dollars for display, e.g. 12500 -> "$12,500.00".
 *
 * The locale is fixed to "en-US" so the server render (Cloudflare Workers)
 * and the browser render always produce the same string, whatever language
 * the viewer's machine uses. All FinReq amounts are USD.
 *
 * Invalid input (NaN) displays as "$0.00" instead of "$NaN".
 */
export function formatCurrency(amount: number): string {
  if (isNaN(amount)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
