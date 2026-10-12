import { describe, expect, it } from "vitest";
import { idAliases } from "./stable-ids";

describe("stable ids for replay keys", () => {
  it("swaps random ids (and their random part inside a URL) for aliases in order, and back", () => {
    const run = (evt: string, link: string) => {
      const ids = idAliases();
      const hidden = ids.hide({ evidence: [{ id: evt }], seeded: "pay_LB1234PRIYA", url: `https://pay.sim.example/l/${link.slice(6)}`, link });
      return { ids, hidden };
    };
    const a = run("evt_Ab3dEf6hIj9kLm", "plink_Zz1yXx2wVv3uTt");
    const b = run("evt_Qq9wEr8tYu7iOp", "plink_Mm4nNb5vVc6xXz");
    expect(a.hidden).toEqual(b.hidden);
    expect(a.hidden).toEqual({ evidence: [{ id: "evt_ref1" }], seeded: "pay_LB1234PRIYA", url: "https://pay.sim.example/l/plinkref1", link: "plink_ref1" });
    expect(a.ids.show("See evt_ref1 and https://pay.sim.example/l/plinkref1")).toBe("See evt_Ab3dEf6hIj9kLm and https://pay.sim.example/l/Zz1yXx2wVv3uTt");
  });

  it("aliases a simulated link URL even when the link id isn't there", () => {
    const one = idAliases().hide({ short_url: "https://pay.sim.example/l/5rX0LPub7eNt6A" });
    const two = idAliases().hide({ short_url: "https://pay.sim.example/l/EmfF0IRp14LUCL" });
    expect(one).toEqual(two);
  });
});
