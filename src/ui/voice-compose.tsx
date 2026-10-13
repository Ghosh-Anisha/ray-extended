"use client";

// Send a voice note: pick a speaker-scoped recorded sample, or record/upload
// audio when live transcription is configured for the demo.
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DOING_IT } from "@/surfaces/words";
import { Button } from "./kit";
import type { PostResult } from "./bits";

async function send(url: string, fields: Record<string, string>, audio: Blob | null): Promise<PostResult> {
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (audio) form.append("audio", audio, "voice-note");
    const res = await fetch(url, { method: "POST", body: form });
    return (await res.json()) as PostResult;
  } catch {
    return { ok: false, error: "Couldn't reach RAY. Check your connection and try again." };
  }
}

export function VoiceCompose({
  url,
  fields,
  samples,
  live,
  sendLabel,
  onSent,
}: {
  url: string;
  fields: Record<string, string>;
  samples: { id: string; label: string }[];
  live: boolean;
  sendLabel: string;
  onSent?: (result: unknown) => void;
}) {
  const router = useRouter();
  const [sample, setSample] = useState(samples[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const rec = useRef<MediaRecorder | null>(null);

  async function go(audio: Blob | null) {
    setBusy(true);
    setError(null);
    const r = await send(url, audio ? { ...fields, requestId } : { ...fields, sampleId: sample, requestId }, audio);
    if (!r.ok) setError(r.error);
    else { onSent?.(r.result); setRequestId(crypto.randomUUID()); }
    router.refresh();
    setBusy(false);
  }

  async function toggleRecording() {
    if (recording) {
      rec.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const r = new MediaRecorder(stream);
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        void go(new Blob(chunks, { type: r.mimeType || "audio/webm" }));
      };
      rec.current = r;
      r.start();
      setRecording(true);
    } catch {
      setError("Couldn't use the microphone. Pick a sample instead.");
    }
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="voice-compose">
        <label>
          Voice note{" "}
          <select className="field" value={sample} onChange={(e) => { setSample(e.target.value); setRequestId(crypto.randomUUID()); }} aria-label="Recorded sample">
            {samples.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" isDisabled={busy || !sample} onClick={() => go(null)}>
          {busy ? DOING_IT : sendLabel}
        </Button>
        {live && (
          <>
            <Button type="button" variant="secondary" isDisabled={busy} onClick={toggleRecording} aria-pressed={recording}>
              {recording ? "Stop and send" : "Record"}
            </Button>
            <label className="muted">
              or a file{" "}
              <input type="file" accept="audio/*" disabled={busy} onChange={(e) => e.target.files?.[0] && go(e.target.files[0])} />
            </label>
          </>
        )}
      </div>
      <span className="muted" style={{ fontSize: 12 }}>
        {live ? "Recordings are transcribed for this demo." : "Choose a recorded sample to send its transcript."}
      </span>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
