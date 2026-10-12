// Numbers, dates and times the way design language section 1 shows them.
// Money is in minor units; times are epoch ms shown in IST.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SYMBOL: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€" };

// Indian grouping: 1,299 · 14,20,000.
export function groupIndian(n: number): string {
  const [int, dec] = String(n).split(".");
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (rest ? `${rest},${last3}` : last3) + (dec ? `.${dec}` : "");
}

const trim = (n: number) => String(Number(n.toFixed(2)));

// ₹1,299 · ₹14.2 lakh above ₹1 lakh · ₹1.5 crore · $49.
export function formatMoney(minor: number, currency = "INR"): string {
  const major = minor / 100;
  const sym = SYMBOL[currency] ?? `${currency} `;
  if (currency !== "INR") return `${sym}${major.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (major >= 10_000_000) return `₹${trim(Number((major / 10_000_000).toFixed(1)))} crore`;
  if (major >= 100_000) return `₹${trim(Number((major / 100_000).toFixed(1)))} lakh`;
  return `₹${groupIndian(Number(trim(major)))}`;
}

const ist = (ms: number) => new Date(ms + IST_OFFSET_MS);

// 7:52 PM
export function formatTime(ms: number): string {
  const d = ist(ms);
  const h = d.getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// 6 Oct
export function formatDate(ms: number): string {
  const d = ist(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// UTR ending 4821
export const last4 = (v: string) => v.slice(-4);
