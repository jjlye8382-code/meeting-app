// Speech to text for voice notes and meeting audio. Claude does not take audio, so this uses
// OpenAI's transcription endpoint (the same key your meeting-app already uses).
import { config } from "./config.js";

const VOCAB = "Malaysian business conversation that switches between English, Mandarin Chinese and Bahasa Melayu " +
  "(Manglish: lah, lor, meh, boleh, tak apa). Paint industry: Nippon Paint, PMC, dealer, contractor, developer, consultant, " +
  "tender, project pipeline, Pro Connect, repaint, Dulux, Jotun, Kansai, ringgit, RM.";

export async function transcribe(buffer, filename) {
  if (!config.openaiKey) throw new Error("Voice notes need OPENAI_API_KEY in the bot's settings.");
  if (buffer.length > 25 * 1024 * 1024) throw new Error("That audio is over 25 MB. Send a shorter clip, or the Zoom transcript (.vtt) instead.");
  const fd = new FormData();
  fd.append("file", new Blob([buffer]), filename);
  fd.append("model", config.transcribeModel);
  fd.append("prompt", VOCAB);
  fd.append("response_format", "json");
  const res = await fetch(`${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST", headers: { Authorization: `Bearer ${config.openaiKey}` }, body: fd, signal: AbortSignal.timeout(10 * 60000),
  });
  if (!res.ok) throw new Error(`Transcription failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  return String((await res.json()).text || "").trim();
}

// Zoom and Teams transcripts arrive as WebVTT or SRT; keep the speaker lines, drop cue numbers and timings.
export function subtitlesToText(s) {
  return String(s).replace(/^WEBVTT.*$/m, "").split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^NOTE\b/.test(l))
    .join("\n");
}
