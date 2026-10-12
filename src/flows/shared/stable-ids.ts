// Replay fixtures are keyed by a hash of the AI job's input, so the same
// question must look the same every run. Ids the system makes up at random
// (newId: a prefix and 14 random characters) would change the key each
// time, so before a call they are swapped for stable aliases in order of
// first appearance ("evt_ref1"), and swapped back in the answer. Seeded and
// Razorpay ids are left as they are.

const RANDOM_ID = /\b(evt|cev|msg|so|plink|act|tmr|case|rfnd|pay|order|chg|tap|alert|prop|down)_[A-Za-z0-9]{14}\b/g;
// A simulated payment link's URL carries its id without the prefix.
const LINK_URL = /\/l\/([A-Za-z0-9]{14})\b/g;

export type IdAliases = {
  // Replaces random ids everywhere inside a value (deeply).
  hide<T>(value: T): T;
  // Puts the real ids back.
  show<T>(value: T): T;
};

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[fn(k)] = mapStrings(v, fn);
    return out;
  }
  return value;
}

export function idAliases(): IdAliases {
  const toAlias = new Map<string, string>();
  const toReal = new Map<string, string>();
  const counts = new Map<string, number>();
  const alias = (id: string, prefix: string) => {
    let a = toAlias.get(id);
    if (!a) {
      const n = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, n);
      a = `${prefix}_ref${n}`;
      toAlias.set(id, a);
      toReal.set(a, id);
      // The random part can also travel on its own, e.g. inside a link's
      // URL; it gets the alias without the underscore.
      const bare = `${prefix}ref${n}`;
      toAlias.set(id.slice(prefix.length + 1), bare);
      toReal.set(bare, id.slice(prefix.length + 1));
    }
    return a;
  };
  const collect = (value: unknown) =>
    mapStrings(value, (str) => {
      for (const m of str.matchAll(new RegExp(`${RANDOM_ID.source}|${LINK_URL.source}`, "g"))) {
        if (m[1]) alias(m[0], m[1]);
        else alias(`plink_${m[2]}`, "plink");
      }
      return str;
    });
  const suffixes = () => [...toAlias.keys()].filter((k) => !k.includes("_"));
  return {
    hide: <T>(value: T) => {
      collect(value);
      const bare = suffixes();
      return mapStrings(value, (str) => {
        let out = str.replace(RANDOM_ID, (id) => toAlias.get(id)!);
        for (const b of bare) if (out.includes(b)) out = out.split(b).join(toAlias.get(b)!);
        return out;
      }) as T;
    },
    show: <T>(value: T) => mapStrings(value, (str) => str.replace(/\b[a-z]+_?ref\d+\b/g, (a) => toReal.get(a) ?? a)) as T,
  };
}
