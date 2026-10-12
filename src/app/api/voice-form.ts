// Voice note uploads: form fields, plus the audio file if one was recorded.
import type { AudioInput } from "@/adapters/voice";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export async function readVoiceForm(req: Request): Promise<{ fields: Record<string, string>; audio?: AudioInput }> {
  const form = await req.formData();
  const fields: Record<string, string> = {};
  let audio: AudioInput | undefined;
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") fields[k] = v;
    else if (k === "audio") {
      if (v.size > MAX_AUDIO_BYTES) throw new Error("That voice note is too long. Keep it under 10 MB.");
      audio = { bytes: new Uint8Array(await v.arrayBuffer()), mime: v.type || "audio/webm" };
    }
  }
  return { fields, audio };
}
