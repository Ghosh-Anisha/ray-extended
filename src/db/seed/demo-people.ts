// The people and money around Leafy Bakes in the demo world (docs/ui-rebuild.md
// section 4). All fictional: names are made up, emails use example.com and
// phone numbers are not real. Everything here is plain data; demo.ts turns it
// into rows.

export const LEAFY = "m_leafy_bakes";
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const rupees = (r: number) => Math.round(r * 100);
// "2026-10-12T16:30" in IST.
export const ist = (iso: string) => Date.parse(`${iso.length === 16 ? `${iso}:00` : iso}+05:30`);

export type Person = { id: string; name: string; email: string; phone: string; country?: string };

// Customers who appear in cases that closed in the last 60 days. Phones run +91980000020x upward.
const NAMES = [
  "Ananya Rao", "Vikram Desai", "Pooja Nambiar", "Rohit Sethi", "Sneha Kulkarni", "Arjun Bhat", "Divya Menon", "Manish Joshi",
  "Ritu Agarwal", "Faisal Khan", "Tanvi Shah", "Nikhil Verma", "Isha Kapoor", "Harish Patel", "Lakshmi Iyer", "Gaurav Malhotra",
  "Sana Sheikh", "Amit Banerjee", "Kriti Singh", "Joseph D'Souza", "Rekha Pillai", "Siddharth Roy", "Meghna Bose", "Kabir Anand",
  "Nandini Rao", "Yash Thakkar", "Aarti Deshmukh", "Prakash Hegde", "Zoya Merchant", "Tarun Gupta",
];
const slug = (n: string) => n.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
export const HISTORY_PEOPLE: Person[] = NAMES.map((name, i) => ({
  id: `cus_h_${slug(name).replace(/\./g, "_")}`,
  name,
  email: `${slug(name)}@example.com`,
  phone: `+91980000${String(2000 + i).padStart(4, "0")}`,
}));

// Customers abroad.
export const ABROAD: Person[] = [
  { id: "cus_lb_emma", name: "Emma Clarke", email: "emma.clarke@example.com", phone: "", country: "US" },
  { id: "cus_lb_oliver", name: "Oliver Bennett", email: "oliver@example.co.uk", phone: "", country: "GB" },
  { id: "cus_lb_grace", name: "Grace Turner", email: "grace.turner@example.com", phone: "", country: "US" },
  { id: "cus_lb_daniel", name: "Daniel Whitfield", email: "daniel.whitfield@example.co.uk", phone: "", country: "GB" },
  { id: "cus_lb_hannah", name: "Hannah Weber", email: "hannah.weber@example.de", phone: "", country: "DE" },
  { id: "cus_lb_mei", name: "Mei Tan", email: "mei.tan@example.com", phone: "", country: "SG" },
];

// New Leafy customers for the open cases.
export const NEHA: Person = { id: "cus_lb_nehak", name: "Neha K", email: "neha.k@example.com", phone: "+919800000121" };
export const KARAN: Person = { id: "cus_lb_karan", name: "Karan Mehta", email: "karan.mehta@example.com", phone: "+919800000131" };

// Corporate gifting buyers. The first five owe money (₹6.1 lakh together).
export type BuyerSeed = {
  id: string; name: string; contact: string; email: string; phone: string; avgLate: number; history: string; tds: number; key: boolean;
};
export const BUYERS: BuyerSeed[] = [
  { id: "buy_lb_acme", name: "Acme Corporate Gifts", contact: "Meenal Pawar", email: "accounts@acmegifts.example.com", phone: "+919800000401", avgLate: 6, history: "Usually pays a week after the due date once reminded. Promises a day and keeps it.", tds: 2, key: true },
  { id: "buy_lb_sunrise", name: "Sunrise Hotels", contact: "Rajiv Kamath", email: "accounts@sunrisehotels.example.com", phone: "+919800000402", avgLate: 14, history: "Pays in two to three weeks. One gentle reminder is normally enough.", tds: 2, key: false },
  { id: "buy_lb_brew", name: "Brew & Bloom Cafés", contact: "Anita Fernandes", email: "accounts@brewbloom.example.com", phone: "+919800000403", avgLate: 9, history: "Pays after the second reminder, in full.", tds: 1, key: false },
  { id: "buy_lb_orchid", name: "Orchid Events", contact: "Saurabh Mittal", email: "accounts@orchidevents.example.com", phone: "+919800000404", avgLate: 12, history: "Pays in parts, often clubs several invoices into one transfer.", tds: 2, key: false },
  { id: "buy_lb_metro", name: "Metro Realty Facilities", contact: "Charu Lal", email: "accounts@metrorealty.example.com", phone: "+919800000405", avgLate: 31, history: "Slow payer. Often promises a date and misses it.", tds: 2, key: false },
  { id: "buy_lb_greenfield", name: "Greenfield Hospitality", contact: "Dev Parikh", email: "accounts@greenfield.example.com", phone: "+919800000406", avgLate: 4, history: "Pays within a few days of the due date.", tds: 2, key: false },
];

export type InvoiceSeed = { id: string; buyer: string; no: number; amount: number; dueIso: string; status: "open" | "paid"; paidIso?: string };
// Overdue on Tue 13 Oct 2026: 48,000 + 1,12,000 + 1,35,000 + 95,000 + 60,000 + 1,00,000 + 60,000 = ₹6,10,000.
export const INVOICES: InvoiceSeed[] = [
  { id: "inv_LB_118", buyer: "buy_lb_acme", no: 118, amount: 48_000, dueIso: "2026-10-03T10:00", status: "open" },
  { id: "inv_LB_112", buyer: "buy_lb_sunrise", no: 112, amount: 112_000, dueIso: "2026-09-28T10:00", status: "open" },
  { id: "inv_LB_115", buyer: "buy_lb_brew", no: 115, amount: 135_000, dueIso: "2026-10-01T10:00", status: "open" },
  { id: "inv_LB_109", buyer: "buy_lb_orchid", no: 109, amount: 95_000, dueIso: "2026-09-24T10:00", status: "open" },
  { id: "inv_LB_113", buyer: "buy_lb_orchid", no: 113, amount: 60_000, dueIso: "2026-09-29T10:00", status: "open" },
  { id: "inv_LB_104", buyer: "buy_lb_metro", no: 104, amount: 100_000, dueIso: "2026-09-18T10:00", status: "open" },
  { id: "inv_LB_110", buyer: "buy_lb_metro", no: 110, amount: 60_000, dueIso: "2026-09-25T10:00", status: "open" },
  // Not due yet.
  { id: "inv_LB_121", buyer: "buy_lb_greenfield", no: 121, amount: 72_000, dueIso: "2026-10-20T10:00", status: "open" },
  { id: "inv_LB_122", buyer: "buy_lb_acme", no: 122, amount: 36_000, dueIso: "2026-10-28T10:00", status: "open" },
  // Paid in the last 30 days: the three Invoice overdue cases that closed.
  { id: "inv_LB_098", buyer: "buy_lb_brew", no: 98, amount: 52_000, dueIso: "2026-09-12T10:00", status: "paid", paidIso: "2026-09-26T12:20" },
  { id: "inv_LB_101", buyer: "buy_lb_orchid", no: 101, amount: 41_500, dueIso: "2026-09-16T10:00", status: "paid", paidIso: "2026-10-02T15:05" },
  { id: "inv_LB_096", buyer: "buy_lb_greenfield", no: 96, amount: 38_500, dueIso: "2026-09-20T10:00", status: "paid", paidIso: "2026-10-08T11:40" },
  // Paid earlier: the month before.
  { id: "inv_LB_083", buyer: "buy_lb_metro", no: 83, amount: 70_000, dueIso: "2026-08-10T10:00", status: "paid", paidIso: "2026-08-28T16:10" },
  { id: "inv_LB_087", buyer: "buy_lb_acme", no: 87, amount: 45_000, dueIso: "2026-08-18T10:00", status: "paid", paidIso: "2026-08-30T10:30" },
];
