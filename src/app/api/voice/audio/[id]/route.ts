// Voice note and generated call audio, by audio id.
import fs from "node:fs";
import path from "node:path";
import { getAdapters } from "@/adapters";

const TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".webm": "audio/webm", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac" };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const file = getAdapters().voice.audioPath((await params).id);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(file)), {
    headers: { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "private, max-age=3600" },
  });
}
