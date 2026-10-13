"use client";

// Design language section 5, "How voice looks":
// - Voice note bubble: ▶ play · duration · transcript below, in the original language
// - Call card: "Call to Priya · 1 min 42 s · Simulated" · outcome chip ·
//   transcript expander · ▶ for generated audio lines
// - Pre-call notice: "RAY will call Priya at 8:30 PM if there's no reply · Cancel call"
import { useRef, useState, type ReactNode } from "react";
import type { CallView, PreCallNotice as Notice, VoiceNoteView } from "@/surfaces/calls";
import { DOING_IT } from "@/surfaces/words";
import { SimulatedTag, useAction } from "./bits";

export const audioUrl = (ref: string) => `/api/voice/audio/${encodeURIComponent(ref)}`;

// ▶ for one piece of audio. Recorded samples have no audio, so the button
// says so instead of playing.
export function PlayButton({ audioRef, label }: { audioRef: string | null; label: string }) {
  const el = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  if (!audioRef) {
    return (
      <span className="chip neutral" aria-label={`${label}: transcript only`}>Transcript only</span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="play"
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        onClick={() => {
          const a = el.current;
          if (!a) return;
          if (a.paused) void a.play();
          else a.pause();
        }}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <audio ref={el} src={audioUrl(audioRef)} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    </>
  );
}

export function VoiceNoteBubble({ note, mine, meta }: { note: VoiceNoteView; mine?: boolean; meta?: ReactNode }) {
  return (
    <div className={`bubble voice-note ${mine ? "mine" : ""}`} data-testid="voice-note">
      <div className="row" style={{ gap: 8 }}>
        {note.audioRef ? <><PlayButton audioRef={note.audioRef} label="voice note" /><span className="muted">{note.duration}</span></> : <span className="muted">Transcript only</span>}
      </div>
      <div lang="und" style={{ marginTop: 4 }}>
        {note.transcript}
      </div>
      {meta && <div className="meta">{meta}</div>}
    </div>
  );
}

export function CallCard({ call, meta }: { call: CallView; meta?: ReactNode }) {
  return (
    <section className="panel stack call-card" data-testid="call-card" style={{ gap: 6 }}>
      <div className="row">
        <strong>{call.title}</strong>
        <SimulatedTag />
        <span className={`chip ${call.tone}`}>{call.outcome}</span>
      </div>
      <div>{call.summary}</div>
      <details>
        <summary>Transcript</summary>
        {call.transcript.map((l, i) => (
          <p key={i} className="row" style={{ gap: 6, alignItems: "baseline", margin: "4px 0" }}>
            {l.audioRef && <PlayButton audioRef={l.audioRef} label={`line ${i + 1}`} />}
            <span>
              {l.who && <strong>{l.who}: </strong>}
              {l.text}
            </span>
          </p>
        ))}
      </details>
      {meta && <div className="meta">{meta}</div>}
    </section>
  );
}

export function PreCallNotice({ notice, caseId }: { notice: Notice; caseId: string }) {
  const { busy, error, run } = useAction();
  return (
    <div className="banner hold" role="status" data-testid="pre-call-notice">
      <span>{notice.text}</span>
      {" · "}
      <button type="button" className="link" disabled={busy !== null} onClick={() => run("cancel", "/api/merchant/cancel-call", { caseId, timerId: notice.timerId })}>
        {busy === "cancel" ? DOING_IT : "Cancel call"}
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
