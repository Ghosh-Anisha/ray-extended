"use client";

// Send a voice note: pick a recorded sample, or (with ELEVENLABS_API_KEY
// set) record one or pick an audio file, transcribed live on ElevenLabs.
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DOING_IT } from "@/surfaces/words";
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
  const rec = useRef<MediaRecorder | null>(null);

  async function go(audio: Blob | null) {
    setBusy(true);
    setError(null);
    const r = await send(url, audio ? fields : { ...fields, sampleId: sample }, audio);
    if (!r.ok) setError(r.error);
    else onSent?.(r.result);
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
          <select value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Recorded sample">
            {samples.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy || !sample} onClick={() => go(null)}>
          {busy ? DOING_IT : sendLabel}
        </button>
        {live && (
          <>
            <button type="button" disabled={busy} onClick={toggleRecording} aria-pressed={recording}>
              {recording ? "Stop and send" : "Record"}
            </button>
            <label className="muted">
              or a file{" "}
              <input type="file" accept="audio/*" disabled={busy} onChange={(e) => e.target.files?.[0] && go(e.target.files[0])} />
            </label>
          </>
        )}
      </div>
      <span className="muted" style={{ fontSize: 12 }}>
        {live ? "Recordings are transcribed on ElevenLabs." : "Recorded samples. Set ELEVENLABS_API_KEY to record your own."}
      </span>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
