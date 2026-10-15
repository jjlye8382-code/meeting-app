// Loads .env (no dependency), pins the time zone, and exposes settings.
import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// All schedules ("7:30 morning brief") are in Lye's local time.
process.env.TZ = process.env.TZ || "Asia/Kuala_Lumpur";

const env = (k, d = "") => (process.env[k] ?? d).trim();

export const config = {
  telegramToken: env("TELEGRAM_BOT_TOKEN"),
  ownerId: env("TELEGRAM_OWNER_ID"),
  ownerName: env("OWNER_NAME", "Lye"),
  model: env("CLAUDE_MODEL", "claude-opus-5-5"),
  openaiKey: env("OPENAI_API_KEY"),
  transcribeModel: env("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe"),
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  gmail: {
    user: env("GMAIL_ADDRESS"),
    appPassword: env("GMAIL_APP_PASSWORD").replace(/\s+/g, ""),
    notesTag: env("NOTES_TAG", "+notes"), // Lotus Notes rule forwards to you+notes@gmail.com
    agendaSubject: env("AGENDA_SUBJECT", "PAL AGENDA"), // iPhone Shortcut email subject
    pollMinutes: Number(env("MAIL_POLL_MINUTES", "5")) || 5,
  },
  shortVoiceSeconds: Number(env("SHORT_VOICE_SECONDS", "90")) || 90,
  meetingHeadsUpMinutes: Number(env("MEETING_HEADS_UP_MINUTES", "20")) || 20,
};

export function missingConfig() {
  const miss = [];
  if (!config.telegramToken) miss.push("TELEGRAM_BOT_TOKEN");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) miss.push("ANTHROPIC_API_KEY");
  return miss;
}
