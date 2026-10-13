// The money matcher (Step 11, "Match money"), all code. The model only reads
// remark and advice text into invoice numbers and amounts (advice.ts); this
// file decides what a bank credit pays, and how sure RAY is.
//
//   Exact (pay link, the buyer's own UTR)  amount fits exactly          Sure
//   Remittance advice                      agrees with the credit       Sure
//   One transfer, several invoices         subset-sum, one fit          Sure; several fits Likely
//   Short by TDS                           buyer's usual rate on taxable value  Likely, ask for the certificate
//   Part payment                           oldest first unless the advice says otherwise  Likely
//   No match                               the closest options          Unsure (asks)
import type { Invoice } from "./stages";

export type Allocation = { invoice_id: string; amount: number };
export type OpenInvoice = Pick<Invoice, "id" | "number" | "due_date" | "amount"> & { outstanding: number; taxable: number };
export type MatchKind = "exact" | "advice" | "subset" | "tds" | "part" | "none";

export type MatchResult = {
  kind: MatchKind;
  confidence: "sure" | "likely" | "unsure";
  // The allocation RAY would post (the first option when there are several).
  options: Allocation[][];
  // Short by TDS: per invoice, the amount held back as TDS.
  tds: Allocation[];
  // No match: the open invoices closest to the credit, for the question.
  closest: OpenInvoice[];
  reason: string;
};

export type MatchInput = {
  amount: number;
  invoices: OpenInvoice[];
  // The buyer's usual TDS rate, in percent (0 when they don't deduct).
  tdsRate: number;
  // Invoices an exact reference points at (a pay link, a UTR the buyer gave).
  exact?: string[];
  // What a remittance advice says the credit pays, invoice by invoice.
  advice?: Allocation[] | null;
  // Invoices the bank remark names: tried first, on their own.
  named?: string[];
};

// Up to this many open invoices are searched for subset-sum (2^18 subsets).
export const SUBSET_LIMIT = 18;
// Rounding on TDS: a rupee either way per invoice.
export const TDS_TOLERANCE = 100;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const byOldest = (xs: OpenInvoice[]) => [...xs].sort((a, b) => a.due_date - b.due_date || a.number.localeCompare(b.number));

export const tdsOn = (inv: Pick<OpenInvoice, "taxable">, rate: number) => Math.round((inv.taxable * rate) / 100);

// Every subset of the invoices whose values add up to the target (within
// a tolerance per invoice), stopping after `cap` fits.
export function subsetsSummingTo(values: number[], target: number, tolerancePer = 0, cap = 3): number[][] {
  const n = Math.min(values.length, SUBSET_LIMIT);
  const out: number[][] = [];
  const pick: number[] = [];
  const walk = (i: number, total: number) => {
    if (out.length >= cap) return;
    if (pick.length && Math.abs(total - target) <= tolerancePer * pick.length) out.push([...pick]);
    if (i >= n || total > target + tolerancePer * n) return;
    for (let j = i; j < n && out.length < cap; j++) {
      pick.push(j);
      walk(j + 1, total + values[j]);
      pick.pop();
    }
  };
  walk(0, 0);
  return out;
}

export function matchCredit(input: MatchInput): MatchResult {
  // The invoices the remark names, on their own first: a fit there beats
  // any other set that happens to add up.
  if (input.named?.length) {
    const named = input.invoices.filter((i) => input.named!.includes(i.id));
    if (named.length) {
      const r = matchCredit({ ...input, invoices: named, named: undefined });
      if (r.kind === "subset" || r.kind === "tds" || r.kind === "exact" || r.kind === "advice") return { ...r, reason: `${r.reason} The bank remark names the invoice.` };
    }
  }
  const invoices = byOldest(input.invoices.filter((i) => i.outstanding > 0));
  const none = (reason: string): MatchResult => ({
    kind: "none",
    confidence: "unsure",
    options: [],
    tds: [],
    closest: [...invoices].sort((a, b) => Math.abs(a.outstanding - input.amount) - Math.abs(b.outstanding - input.amount)).slice(0, 3),
    reason,
  });
  if (!invoices.length) return none("This buyer has no open invoices.");
  const byId = new Map(invoices.map((i) => [i.id, i]));

  // Exact reference.
  if (input.exact?.length) {
    const named = input.exact.map((id) => byId.get(id)).filter((x): x is OpenInvoice => !!x);
    if (named.length && sum(named.map((i) => i.outstanding)) === input.amount) {
      return { kind: "exact", confidence: "sure", options: [named.map((i) => ({ invoice_id: i.id, amount: i.outstanding }))], tds: [], closest: [], reason: "The payment reference and the amount match exactly." };
    }
  }

  // Remittance advice: Sure only when it agrees with the credit.
  if (input.advice?.length) {
    const ok =
      sum(input.advice.map((x) => x.amount)) === input.amount &&
      input.advice.every((x) => byId.has(x.invoice_id) && x.amount > 0 && x.amount <= byId.get(x.invoice_id)!.outstanding);
    if (ok) return { kind: "advice", confidence: "sure", options: [input.advice], tds: [], closest: [], reason: "The remittance advice agrees with the credit." };
  }

  // One transfer, several invoices.
  const fits = subsetsSummingTo(invoices.map((i) => i.outstanding), input.amount);
  if (fits.length) {
    const options = fits.map((f) => f.map((j) => ({ invoice_id: invoices[j].id, amount: invoices[j].outstanding })));
    return fits.length === 1
      ? { kind: "subset", confidence: "sure", options, tds: [], closest: [], reason: options[0].length > 1 ? `One set of ${options[0].length} open invoices adds up to exactly this.` : "One open invoice matches this amount exactly." }
      : { kind: "subset", confidence: "likely", options, tds: [], closest: [], reason: "More than one set of open invoices adds up to this." };
  }

  // Short by TDS at this buyer's usual rate.
  if (input.tdsRate > 0) {
    const nets = invoices.map((i) => i.outstanding - tdsOn(i, input.tdsRate));
    const tfits = subsetsSummingTo(nets, input.amount, TDS_TOLERANCE);
    if (tfits.length) {
      const f = tfits[0];
      const tds = f.map((j) => ({ invoice_id: invoices[j].id, amount: invoices[j].outstanding - nets[j] }));
      // Post the money that came in, spread net of TDS; any rounding goes on the last invoice.
      const alloc = f.map((j) => ({ invoice_id: invoices[j].id, amount: nets[j] }));
      alloc[alloc.length - 1].amount += input.amount - sum(alloc.map((x) => x.amount));
      const options = tfits.map((g) => g.map((j) => ({ invoice_id: invoices[j].id, amount: nets[j] })));
      options[0] = alloc;
      return {
        kind: "tds",
        confidence: "likely",
        options,
        tds,
        closest: [],
        reason: `It's short by TDS at ${input.tdsRate}%, this buyer's usual rate.`,
      };
    }
  }

  // Part payment: oldest first, unless the advice says otherwise.
  const total = sum(invoices.map((i) => i.outstanding));
  if (input.amount < total) {
    const order = input.advice?.length
      ? [...input.advice.map((x) => byId.get(x.invoice_id)).filter((x): x is OpenInvoice => !!x), ...invoices.filter((i) => !input.advice!.some((x) => x.invoice_id === i.id))]
      : invoices;
    let left = input.amount;
    const alloc: Allocation[] = [];
    for (const inv of order) {
      if (left <= 0) break;
      const take = Math.min(left, inv.outstanding);
      alloc.push({ invoice_id: inv.id, amount: take });
      left -= take;
    }
    return {
      kind: "part",
      confidence: "likely",
      options: [alloc],
      tds: [],
      closest: [],
      reason: input.advice?.length ? "It's a part payment, applied in the order the advice gives." : "It's a part payment, applied to the oldest invoice first.",
    };
  }
  return none("It's more than this buyer owes, so RAY can't tell what it's for.");
}
