export function formatCurrency(amount: number): string {
  if (isNaN(amount)) return "$0.00";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
