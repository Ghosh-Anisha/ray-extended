// The fixed lines RAY sends customers in this moment, in the customer's
// language (English or Hinglish), always as the merchant and signed with the
// playbook's sign-off. Every number in them comes from the case data: the
// payment record, the store order, or a timer on the case (rule 6). None of
// them says "refunded" or "confirmed": only a confirmation may, after the
// action ran (the confirmation guard).
export type Lang = "en" | "hinglish";

export const langOf = (language: string | null | undefined): Lang =>
  language === "hinglish" || language === "hi" ? "hinglish" : "en";

export type PaymentBits = {
  name: string; // first name
  amount: string; // ₹1,299
  time: string; // 9:22 AM
  date: string; // 12 Oct
  ref: string | null; // "UTR ending 0021" or "card ending 4417"
  order: string | null; // #1234
};

const refPart = (p: PaymentBits) => (p.ref ? `, ${p.ref}` : "");
// The same, mid-sentence: closed with a comma.
const refMid = (p: PaymentBits) => (p.ref ? `, ${p.ref},` : "");

// The promise line: checkable details, no link, and when they'll hear back.
export function promiseLine(p: PaymentBits, by: string, signOff: string, lang: Lang, downtime: boolean): string {
  const outage =
    downtime && lang === "en"
      ? " There was a UPI outage at that time, which held things up."
      : downtime
        ? " Us samay UPI mein outage tha, isliye der hui."
        : "";
  if (lang === "hinglish") {
    return `Hi ${p.name}, humein aapka ${p.amount} ka payment dikh raha hai, ${p.date} ko ${p.time}${refPart(p)}. Aap ise apne UPI app mein check kar sakte hain.${outage} ${by} tak hum aapko update denge. ${signOff}`;
  }
  return `Hi ${p.name}, we can see your payment of ${p.amount} at ${p.time} on ${p.date}${refPart(p)}. You can check this in your UPI app.${outage} You'll hear from us with an update by ${by}. ${signOff}`;
}

export function holdingLine(p: PaymentBits, by: string, signOff: string, lang: Lang): string {
  if (lang === "hinglish") return `Hi ${p.name}, hum abhi bhi aapke ${p.amount} ke payment par kaam kar rahe hain. ${by} tak aapko update milega. ${signOff}`;
  return `Hi ${p.name}, we're still on your payment of ${p.amount}. You'll hear from us by ${by}. ${signOff}`;
}

// Situation C, first reply: it failed on our side; the bank is being checked.
export function bankCheckLine(p: PaymentBits, by: string, signOff: string, lang: Lang, downtime: boolean): string {
  const outage = downtime ? (lang === "en" ? " There was a UPI outage at that time." : " Us samay UPI mein outage tha.") : "";
  if (lang === "hinglish") {
    return `Hi ${p.name}, aapka ${p.amount} ka payment ${p.date} ko ${p.time}${refMid(p)} hamari taraf poora nahi hua, chahe bank mein debit dikh raha ho.${outage} Hum aapke bank se check kar rahe hain, ${by} tak update denge. ${signOff}`;
  }
  return `Hi ${p.name}, your payment of ${p.amount} at ${p.time} on ${p.date}${refMid(p)} didn't complete on our side, even if your bank shows it as debited.${outage} We're checking with your bank and you'll hear from us by ${by}. ${signOff}`;
}

// A pay-again link, never alone: the merchant, the amount and what it's for.
export function payAgainLine(p: PaymentBits, merchant: string, url: string, signOff: string, lang: Lang): string {
  const what = p.order ? `order ${p.order}` : "your order";
  if (lang === "hinglish") return `Agar aap abhi order karna chahte hain, toh ${merchant} ka ${p.amount} ka naya payment link ${what} ke liye: ${url} ${signOff}`;
  return `If you'd like the order now, here's a new payment link from ${merchant} for ${p.amount} for ${what}: ${url} ${signOff}`;
}

// Situation A, the authorised payment goes back: when the bank returns it.
export function returnDateLine(p: PaymentBits, returnBy: string, signOff: string, lang: Lang): string {
  if (lang === "hinglish") return `Hi ${p.name}, aapka ${p.amount} ka payment ${p.date} ko ${p.time}${refMid(p)} poora nahi hua, isliye aapka bank ise ${returnBy} tak wapas kar dega. ${signOff}`;
  return `Hi ${p.name}, your payment of ${p.amount} at ${p.time} on ${p.date}${refMid(p)} didn't complete, so your bank will return it by ${returnBy}. ${signOff}`;
}

// Situation C, polling ended and the payment never went through.
export function reversalLine(p: PaymentBits, returnBy: string, signOff: string, lang: Lang): string {
  if (lang === "hinglish") return `Hi ${p.name}, aapka ${p.amount} ka payment ${p.date} wala poora nahi hua. Agar debit hua tha, toh aapka bank ise ${returnBy} tak wapas kar dega. ${signOff}`;
  return `Hi ${p.name}, your payment of ${p.amount} from ${p.date} didn't go through. If it was debited, your bank will return it by ${returnBy}. ${signOff}`;
}

// Situation D: the order is there; say so again.
export function resendLine(p: PaymentBits, status: string, signOff: string, lang: Lang): string {
  if (lang === "hinglish") return `Hi ${p.name}, aapka ${p.amount} ka payment ${p.date} ko ${p.time}${refMid(p)} order ${p.order} par hai, aur order abhi ${status} hai. ${signOff}`;
  return `Hi ${p.name}, your payment of ${p.amount} at ${p.time} on ${p.date}${refMid(p)} is on order ${p.order}, and the order is ${status}. ${signOff}`;
}

// Situation F: no match yet. Never quotes the customer's own numbers back.
export function askProofLine(name: string, by: string, signOff: string, lang: Lang, again: boolean): string {
  if (lang === "hinglish") {
    return `Hi ${name}, humein abhi aapka payment nahi mila. Kya aap UPI app se payment ka screenshot ya UPI reference bhej sakte hain?${again ? " Jo aapne bheja usse match nahi hua." : ""} ${by} tak update denge. ${signOff}`;
  }
  return `Hi ${name}, we couldn't find your payment yet. Could you share a screenshot of the payment or the UPI reference from your UPI app?${again ? " What you sent didn't match a payment to us." : ""} You'll hear from us by ${by}. ${signOff}`;
}

export function otherGatewayLine(name: string, by: string, signOff: string, lang: Lang): string {
  if (lang === "hinglish") return `Hi ${name}, yeh payment hamare Razorpay account mein nahi dikh raha. Agar aapne hamare doosre checkout option se pay kiya tha, toh shayad wahan hai. Hum check kar rahe hain, ${by} tak update denge. ${signOff}`;
  return `Hi ${name}, we can't see this payment in our Razorpay account. If you paid through our other checkout option, it's likely there, and we're checking. You'll hear from us by ${by}. ${signOff}`;
}

export function arrivalCheckLine(name: string, order: string, signOff: string, lang: Lang): string {
  if (lang === "hinglish") return `Hi ${name}, kya aapka order ${order} pahunch gaya? YES ya NO reply karein. ${signOff}`;
  return `Hi ${name}, did your order ${order} arrive? Reply YES or NO. ${signOff}`;
}

// Fallback confirmation drafts, used when the write job has no answer.
// They carry the checkable details too, in case it's the first message.
export function fulfilConfirmationLine(p: PaymentBits, signOff: string, lang: Lang): string {
  if (lang === "hinglish") return `Hi ${p.name}, aapka ${p.amount} ka payment ${p.date} ko ${p.time}${refPart(p)} mil gaya hai, aur order ${p.order} confirmed hai. Der ke liye sorry. ${signOff}`;
  return `Hi ${p.name}, we got your payment of ${p.amount} at ${p.time} on ${p.date}${refPart(p)}, and your order ${p.order} is confirmed. Sorry for the wait. ${signOff}`;
}

export function refundConfirmationLine(p: PaymentBits, signOff: string, lang: Lang): string {
  if (lang === "hinglish") return `Hi ${p.name}, humne aapka ${p.amount} refunded kar diya hai. Yeh aapke bank ki speed se aapke account mein aayega. ${signOff}`;
  return `Hi ${p.name}, we've refunded your ${p.amount}. It will reach your account at your bank's usual speed. ${signOff}`;
}
