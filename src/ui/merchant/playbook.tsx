"use client";

// Playbook: per-moment rules with on/off, the approval limit, tone,
// sign-off and send-from. Rules are proposed, never assumed: nothing applies
// until Approve rule.
import { Button, Heading, Text } from "@/ui/kit";
import { useState } from "react";
import { REFUND_SPEED_LABEL, TONES } from "@/surfaces/words";
import type { PlaybookView } from "@/surfaces/views";
import { Chip, useAction } from "../bits";
import { useView } from "../view";

const RULE_CHIP = {
  proposed: { label: "Proposed", tone: "notice" },
  approved: { label: "On", tone: "positive" },
  off: { label: "Off", tone: "neutral" },
} as const;

export function Playbook({ p }: { p: PlaybookView }) {
  const { view } = useView();
  const { busy, error, run } = useAction();
  const [limit, setLimit] = useState(String(p.approvalLimitRupees));
  const mid = p.merchant.id;
  const rule = (id: string, status: "approved" | "off") => run(`${id}-${status}`, "/api/merchant/rule", { merchantId: mid, ruleId: id, status });
  const setting = (moment: string, key: string, value: string | boolean) => run(`${moment}-${key}`, "/api/merchant/setting", { merchantId: mid, moment, key, value });

  return (
    <section className="stack">
      <Heading size="large">Rules</Heading>
      {error && <span className="error">{error}</span>}
      <div className="panel row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>Approval limit</strong>
          <div className="muted">Anything above {p.approvalLimit} always comes to you.</div>
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            run("limit", "/api/merchant/limit", { merchantId: mid, rupees: Number(limit) });
          }}
        >
          <label className="row">
            ₹ <input inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ""))} style={{ width: 100 }} aria-label="Approval limit in rupees" />
          </label>
          <Button type="submit" size="small" variant="secondary" isDisabled={busy !== null}>
            Save limit
          </Button>
        </form>
      </div>
      <div className={view === "phone" ? "stack" : "cols-2"}>
        {p.moments.map((m) => (
          <div key={m.moment} className="panel stack" style={{ gap: 10 }}>
            <h2>{m.label}</h2>
            {m.rules.length === 0 ? (
              <Text color="surface.text.gray.muted">No rules yet. RAY proposes one when you make the same choice a few times.</Text>
            ) : (
              m.rules.map((r) => (
                <div key={r.id} id={r.id} className="stack" style={{ gap: 4, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span>{r.text}</span>
                    <Chip chip={RULE_CHIP[r.status]} />
                  </div>
                  {r.limit && <span className="muted">{r.limit}</span>}
                  <div className="row">
                    {r.status === "proposed" && (
                      <>
                        <Button size="small" onClick={() => rule(r.id, "approved")} isDisabled={busy !== null}>
                          Approve rule
                        </Button>
                        <Button size="small" variant="tertiary" onClick={() => rule(r.id, "off")} isDisabled={busy !== null}>
                          Not now
                        </Button>
                      </>
                    )}
                    {r.status === "approved" && (
                      <Button size="small" variant="secondary" onClick={() => rule(r.id, "off")} isDisabled={busy !== null}>
                        Turn off rule
                      </Button>
                    )}
                    {r.status === "off" && (
                      <Button size="small" variant="secondary" onClick={() => rule(r.id, "approved")} isDisabled={busy !== null}>
                        Turn on rule
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
            <label className="row" style={{ justifyContent: "space-between" }}>
              <span>Tone</span>
              <select value={m.settings.tone} onChange={(e) => setting(m.moment, "tone", e.target.value)}>
                {TONES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <SignOff initial={m.settings.signOff} onSave={(v) => setting(m.moment, "sign_off", v)} />
            <label className="row" style={{ justifyContent: "space-between" }}>
              <span>Send from</span>
              <select value={m.settings.sendFrom} onChange={(e) => setting(m.moment, "send_from", e.target.value)}>
                {m.sendFromOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ justifyContent: "space-between" }}>
              <span>Refund speed</span>
              <select value={m.settings.refundSpeed} onChange={(e) => setting(m.moment, "refund_speed", e.target.value)}>
                {Object.entries(REFUND_SPEED_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ justifyContent: "space-between" }}>
              <span>Automatic customer messages</span>
              <input type="checkbox" checked={m.settings.autoMessages} onChange={(e) => setting(m.moment, "auto_customer_messages", e.target.checked)} />
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}

function SignOff({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <form
      className="row"
      style={{ justifyContent: "space-between" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSave(v.trim());
      }}
    >
      <label className="row">
        <span>Sign-off</span>
        <input value={v} onChange={(e) => setV(e.target.value)} />
      </label>
      <Button type="submit" size="small" variant="tertiary" isDisabled={v.trim() === initial}>
        Save sign-off
      </Button>
    </form>
  );
}
