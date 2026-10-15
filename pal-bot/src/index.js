// Lye's Pal: Telegram front door, scheduler and mail bridge.
import { config, missingConfig } from "./config.js";
import { load, db, save, upsert, flush, prune } from "./store.js";
import * as tg from "./telegram.js";
import { chat, resetSession } from "./chat.js";
import { processCapture, renderCapture, addCaptureActions, looksLikeWhatsApp } from "./capture.js";
import { transcribe, subtitlesToText } from "./transcribe.js";
import { pollMail, mailEnabled, notesAddress, inviteLine } from "./mail.js";
import { RECIPES, recipeState, setRecipe } from "./recipes.js";
import { claudeErrorText, askText } from "./claude.js";
import { executeTool } from "./tools.js";
import { startWhatsApp, unlinkWhatsApp, waState, waLinkedBefore, triageWhatsApp, waData, waMaintenance } from "./whatsapp.js";
import { unanswered } from "./wa-logic.js";
import {
  completeTask, snoozeTask, makeTask, openTasks, isMine, isOverdue, hasTime, parseLocal, taskLine, sod, addDays,
  eventsBetween, eventLine, fmtDay, fmtTime, ymd, hm, rm, isRecipeDue, newId,
} from "./domain.js";

const missing = missingConfig();
if (missing.length) { console.error(`Missing settings: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`); process.exit(1); }
load();
const owner = () => String(config.ownerId || "");
const isOwner = (id) => owner() && String(id) === owner();

/* ---------- helpers ---------- */
async function withTyping(chatId, fn, action = "typing") {
  tg.typing(chatId, action);
  const t = setInterval(() => tg.typing(chatId, action), 4500);
  try { return await fn(); } finally { clearInterval(t); }
}
const errText = (e) => claudeErrorText(e);
async function sendCapture(chatId, cap) {
  const view = renderCapture(cap);
  await tg.send(chatId, view.text, { buttons: view.buttons });
  if (view.reply) await tg.send(chatId, `Draft reply (${view.reply.language || "same language"}), long-press to copy:`).then(() => tg.send(chatId, view.reply.text));
}
const taskButtons = (t) => [[{ text: "Done", callback_data: `done:${t.id}` }, { text: "+1 hour", callback_data: `snz:${t.id}:60` }, { text: "Tomorrow 9am", callback_data: `tmr:${t.id}` }]];

const HELP = `**I'm Pal.** Text me, or send a voice note in English, 中文 or BM.
- "Remind me 3pm tomorrow to call Ahmad on the Setia tender"
- "Ahmad owes me the BQ by Friday" (I'll chase it)
- "RM 42.80 Petronas, business"
- "What's on Thursday?" · "Any urgent Notes mail?"

**After a call:** send a voice note (talk for 30 sec). Over ${config.shortVoiceSeconds}s, I write minutes.
**Meetings:** send the recording (up to 20 MB), the Zoom transcript (.vtt), or tap /meeting first.
**WhatsApp:** once linked (/whatsapp), I read your chats (never send) and flag what needs you; /wa shows who is waiting.

/brief morning brief · /today · /week · /todo · /waiting · /spend · /notes · /recipes · /new fresh chat · /status`;

const waLabel = () => ({ connected: "linked, read-only", connecting: "reconnecting…", linking: "waiting for pairing code" })[waState()] || "not linked: /whatsapp link <number>";
function statusText() {
  const d = db(), at = d.agenda.receivedAt;
  return ["**Pal status**",
    `- Claude model: ${config.model}`,
    `- Voice notes: ${config.openaiKey ? "on (" + config.transcribeModel + ")" : "off: add OPENAI_API_KEY"}`,
    `- Calendar feed: ${at ? `${d.agenda.count ?? d.agenda.events.length} events, received ${fmtDay(new Date(at))} ${fmtTime(new Date(at))}` : "not received yet (set up the iPhone Shortcut)"}`,
    `- WhatsApp: ${waLabel()}`,
    `- Lotus Notes mail: ${mailEnabled() ? `forward to ${notesAddress()} · ${d.mail.length} received` : "off: add GMAIL_ADDRESS and GMAIL_APP_PASSWORD"}`,
    `- Reminders open: ${openTasks(d.tasks).length} · expenses logged: ${d.expenses.length} · minutes saved: ${d.captures.length}`,
  ].join("\n");
}

function recipesView() {
  return {
    text: "**Recipes**\nTap to switch on or off.\n" + RECIPES.map((r) => {
      const s = recipeState(r), sc = r.sched;
      const when = sc.freq === "weekly" ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][sc.dow]} ${sc.time}` : `${sc.freq === "weekdays" ? "Mon–Fri" : "Daily"} ${sc.time}`;
      return `- ${s.on ? "✅" : "⬜️"} ${r.name} · ${when}`;
    }).join("\n"),
    buttons: RECIPES.map((r) => [{ text: `${recipeState(r).on ? "Turn off" : "Turn on"}: ${r.name}`, callback_data: `rtog:${r.id}` }, { text: "Run now", callback_data: `run:${r.id}` }]),
  };
}

async function runRecipe(id, chatId, { manual = false } = {}) {
  const r = RECIPES.find((x) => x.id === id); if (!r) return;
  const now = new Date();
  setRecipe(id, { lastRun: now.getTime() });
  let out;
  try { out = await r.run(now); }
  catch (e) { out = { text: `**${r.name}** couldn't run: ${errText(e)}` }; }
  if (out.empty) { if (manual) await tg.send(chatId, `**${r.name}**: nothing to report.`); return; }
  await tg.send(chatId, out.text, { buttons: out.buttons });
}

/* ---------- commands ---------- */
async function command(chatId, cmd, arg) {
  const d = db(), now = new Date();
  switch (cmd) {
    case "start": case "help": return tg.send(chatId, HELP + "\n\n" + statusText());
    case "status": return tg.send(chatId, statusText());
    case "id": return tg.send(chatId, `Your chat id: \`${chatId}\``);
    case "new": resetSession(); return tg.send(chatId, "Fresh start. What's up?");
    case "brief": return withTyping(chatId, () => runRecipe("morning-brief", chatId, { manual: true }));
    case "week": return runRecipe("week-ahead", chatId, { manual: true });
    case "notes": {
      const list = d.mail.filter((m) => m.date > now - 864e5 && m.urgency !== "ignore").slice(-12).reverse();
      return tg.send(chatId, list.length ? "**Lotus Notes · last 24h**\n" + list.map((m) => `- [${m.urgency}] **${m.from}**: ${m.subject}\n  ${m.summary}`).join("\n")
        : mailEnabled() ? "No Lotus Notes mail in the last 24 hours." : "Lotus Notes mail isn't connected yet (see setup guide, step 3).");
    }
    case "today": {
      const evs = eventsBetween(d.agenda.events, sod(now), addDays(sod(now), 1));
      const due = openTasks(d.tasks).filter((t) => isMine(t) && t.due && parseLocal(t.due) < addDays(sod(now), 1));
      return tg.send(chatId, [`**${fmtDay(now)}**`, "**Calendar**\n" + (evs.map(eventLine).join("\n") || "- Nothing"), "**Reminders**\n" + (due.map((t) => taskLine(t, now)).join("\n") || "- None due")].join("\n\n"));
    }
    case "todo": case "waiting": {
      const list = openTasks(d.tasks).filter((t) => (cmd === "todo" ? isMine(t) : !isMine(t))).sort((a, b) => (a.due || "9").localeCompare(b.due || "9")).slice(0, 12);
      if (!list.length) return tg.send(chatId, cmd === "todo" ? "No open reminders." : "Nobody owes you anything right now.");
      return tg.send(chatId, `**${cmd === "todo" ? "Your reminders" : "Waiting on others"}**\n` + list.map((t) => `${isOverdue(t, now) ? "⚠️ " : ""}${taskLine(t, now).slice(2)}`).map((l) => "- " + l).join("\n"),
        { buttons: list.slice(0, 8).map((t) => [{ text: `Done: ${t.title.slice(0, 30)}`, callback_data: `done:${t.id}` }]) });
    }
    case "spend": {
      const s = await executeTool("spending_summary", { days: Number(arg) || 7 });
      const rows = Object.entries(s.by_category).sort((a, b) => b[1] - a[1]).map(([c, v]) => `| ${c} | ${v.toFixed(2)} |`);
      return tg.send(chatId, `**Last ${s.days} days** · ${rm(s.total)} (before: ${rm(s.previous_total)})` + (rows.length ? "\n| Category | RM |\n|---|---|\n" + rows.join("\n") : "\nNothing logged.") +
        (s.possible_double_charges.length ? `\n\n⚠️ Possible double charges: ${s.possible_double_charges.map((x) => `${x.merchant} ${rm(x.amount)}`).join(", ")}` : ""));
    }
    case "meeting":
      d.mode = "meeting"; save();
      return tg.send(chatId, "Meeting mode: send the recording, voice note, transcript or notes next, and I'll write minutes.");
    case "whatsapp": {
      const [sub, num] = String(arg || "").trim().split(/\s+/);
      if (sub === "link") {
        if (!/^\+?\d{9,15}$/.test(num || "")) return tg.send(chatId, "Send your WhatsApp number with country code, e.g. `/whatsapp link 60123456789`.");
        await tg.send(chatId, "Requesting a pairing code from WhatsApp…");
        return startWhatsApp({ phone: num, onNotify: (t) => tg.send(chatId, t) });
      }
      if (sub === "unlink") { await unlinkWhatsApp(); return tg.send(chatId, "WhatsApp unlinked. I no longer read your chats. Also check WhatsApp → Linked devices."); }
      return tg.send(chatId, `**WhatsApp: ${waLabel()}**\n\nRead-only link: I never send, never mark messages read, never show you online.\n- \`/whatsapp link 60123456789\` link (pairing code arrives here)\n- \`/whatsapp unlink\` stop\n- /wa who's waiting on you`);
    }
    case "wa": {
      const w = unanswered(waData()).slice(0, 15);
      if (waState() !== "connected" && !w.length) return tg.send(chatId, "WhatsApp isn't linked yet. Send `/whatsapp link <your number>`.");
      return tg.send(chatId, w.length ? "**WhatsApp · waiting on you**\n" + w.map((x) => `- **${x.name}**${x.isGroup ? " (group)" : ""} · ${x.count} msg · since ${fmtDay(new Date(x.since))} ${fmtTime(new Date(x.since))}\n  ${x.last.text.replace(/\s+/g, " ").slice(0, 120)}`).join("\n") : "Nobody on WhatsApp is waiting on you. 👍");
    }
    case "recipes": { const v = recipesView(); return tg.send(chatId, v.text, { buttons: v.buttons }); }
    default: return tg.send(chatId, "I don't know that command. /help shows what I can do.");
  }
}

/* ---------- messages ---------- */
const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|opus|webm|mp4|mpeg|mpga|aac|flac)$/i;
const TEXT_EXT = /\.(txt|vtt|srt|md|csv|eml)$/i;

async function capture(chatId, kind, text, opts = {}) {
  const cap = await withTyping(chatId, () => processCapture({ kind, text, ...opts }));
  await sendCapture(chatId, cap);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id, d = db();
  if (!isOwner(msg.from?.id)) {
    if (/^\/(start|id)/.test(msg.text || "")) {
      await tg.send(chatId, owner() ? "This is a private assistant." : `Hi! Your Telegram id is \`${msg.from.id}\`. Put it in TELEGRAM_OWNER_ID in the bot's .env and restart me.`);
    }
    return;
  }
  const meetingMode = d.mode === "meeting";
  const clearMode = () => { if (meetingMode) { d.mode = null; save(); } };

  if (msg.text) {
    const m = msg.text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
    if (m) return command(chatId, m[1].toLowerCase(), m[2]);
    const forwarded = !!(msg.forward_origin || msg.forward_from || msg.forward_date);
    if (meetingMode || forwarded || msg.text.length > 1200) {
      clearMode();
      const kind = meetingMode ? "meeting" : looksLikeWhatsApp(msg.text) ? "whatsapp" : "thread";
      const who = msg.forward_origin?.sender_user?.first_name || msg.forward_origin?.sender_user_name || msg.forward_origin?.chat?.title || "";
      return capture(chatId, kind, (who ? `Forwarded from ${who}:\n` : "") + msg.text);
    }
    const reply = await withTyping(chatId, () => chat(msg.text));
    return tg.send(chatId, reply);
  }

  const voice = msg.voice || msg.audio || msg.video_note || (msg.document && (AUDIO_EXT.test(msg.document.file_name || "") || /^audio\//.test(msg.document.mime_type || "")) ? msg.document : null);
  if (voice) {
    if ((voice.file_size || 0) > 20 * 1024 * 1024) return tg.send(chatId, "That file is over Telegram's 20 MB limit for bots. Send the Zoom transcript (.vtt), or split the recording into parts.");
    const short = msg.voice && (msg.voice.duration || 0) <= config.shortVoiceSeconds && !meetingMode;
    clearMode();
    return withTyping(chatId, async () => {
      const file = await tg.download(voice.file_id);
      const ext = (voice.file_name || file.path).match(/\.[a-z0-9]+$/i)?.[0] || ".ogg";
      const text = await transcribe(file.buffer, "audio" + (ext === ".oga" ? ".ogg" : ext));
      if (!text) return tg.send(chatId, "I couldn't hear anything in that recording.");
      if (short) {
        await tg.send(chatId, `🎙 _${text.slice(0, 600)}_`);
        return tg.send(chatId, await chat(text, { voice: true }));
      }
      const cap = await processCapture({ kind: meetingMode ? "meeting" : "voice", text, caption: msg.caption || "" });
      return sendCapture(chatId, cap);
    }, "typing");
  }

  if (msg.document && TEXT_EXT.test(msg.document.file_name || "")) {
    if ((msg.document.file_size || 0) > 20 * 1024 * 1024) return tg.send(chatId, "That file is too big (20 MB limit).");
    clearMode();
    const file = await tg.download(msg.document.file_id);
    let text = file.buffer.toString("utf8"), kind = meetingMode ? "meeting" : "thread";
    if (/\.(vtt|srt)$/i.test(msg.document.file_name)) { text = subtitlesToText(text); kind = "meeting"; }
    else if (looksLikeWhatsApp(text)) kind = "whatsapp";
    return capture(chatId, kind, text, { caption: msg.caption || "" });
  }

  if (msg.photo) {
    clearMode();
    const best = msg.photo[msg.photo.length - 1];
    const file = await tg.download(best.file_id);
    return capture(chatId, "photo", "(see the photo)", { caption: msg.caption || "", images: [{ mediaType: "image/jpeg", data: file.buffer.toString("base64") }] });
  }

  if (msg.document && /\.zip$/i.test(msg.document.file_name || "")) return tg.send(chatId, "For WhatsApp, export the chat *without media* so it comes as a .txt, then share that to me.");
  return tg.send(chatId, "I can read text, voice notes, audio recordings, transcripts (.vtt/.txt) and photos.");
}

/* ---------- buttons ---------- */
async function handleCallback(q) {
  if (!isOwner(q.from?.id)) return tg.answerCallback(q.id);
  const [kind, id, extra] = String(q.data || "").split(":");
  const chatId = q.message?.chat?.id, d = db(), now = new Date();
  const task = d.tasks.find((t) => t.id === id);
  const mail = d.mail.find((m) => m.id === id);
  switch (kind) {
    case "done":
      if (!task) return tg.answerCallback(q.id, "Already gone.");
      upsert("tasks", completeTask(task, now));
      tg.answerCallback(q.id, task.repeat !== "none" && task.due ? "Done. Next one scheduled." : "Done ✓");
      return tg.send(chatId, `✓ ${task.title}`);
    case "snz":
      if (!task) return tg.answerCallback(q.id, "Already gone.");
      upsert("tasks", snoozeTask(task, Number(extra) || 60, now));
      tg.clearButtons(chatId, q.message.message_id);
      return tg.answerCallback(q.id, "Snoozed for an hour");
    case "tmr": {
      if (!task) return tg.answerCallback(q.id, "Already gone.");
      const t = addDays(sod(now), 1); t.setHours(9, 0);
      upsert("tasks", { ...task, due: hm(t), pinged: "", nags: task.nags || 0 });
      tg.clearButtons(chatId, q.message.message_id);
      return tg.answerCallback(q.id, "Moved to tomorrow 9am");
    }
    case "cap": tg.clearButtons(chatId, q.message.message_id); return tg.answerCallback(q.id, addCaptureActions(id, extra));
    case "mact":
      if (!mail) return tg.answerCallback(q.id, "Gone.");
      for (const a of mail.actions) upsert("tasks", makeTask({ title: a.task, due: a.due, notes: `From Notes mail: ${mail.from} – ${mail.subject}` }));
      tg.clearButtons(chatId, q.message.message_id);
      return tg.answerCallback(q.id, `Added ${mail.actions.length} reminder${mail.actions.length === 1 ? "" : "s"}`);
    case "mrep":
      tg.answerCallback(q.id);
      if (!mail?.suggested_reply) return tg.send(chatId, "No reply drafted for that one.");
      await tg.send(chatId, "Draft reply, long-press to copy into Notes:");
      return tg.send(chatId, mail.suggested_reply);
    case "prep": {
      tg.answerCallback(q.id, "Preparing…");
      const ev = d.meta.headsUp?.[id]; if (!ev) return;
      const words = ev.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const hit = (s) => words.some((w) => String(s).toLowerCase().includes(w));
      const related = [...d.mail.filter((m) => hit(m.subject + " " + m.summary)).slice(-5).map((m) => `Mail from ${m.from}: ${m.subject}: ${m.summary}`),
        ...d.captures.filter((c) => hit(c.title + " " + c.result.summary.join(" "))).slice(-3).map((c) => `Earlier minutes "${c.title}": ${c.result.summary.join("; ")}`),
        ...openTasks(d.tasks).filter((t) => hit(t.title)).map((t) => `Open reminder: ${t.title}`)];
      const text = await withTyping(chatId, () => askText({ system: "You are Pal, chief of staff to Lye, GM of PMC (Nippon Paint Malaysia's marketing and distribution arm). Telegram style: short, **bold** headings, - bullets.",
        prompt: `Meeting soon: ${ev.title} at ${fmtTime(new Date(ev.start))}${ev.location ? " in " + ev.location : ""}.\nRelated notes:\n${related.join("\n") || "none"}\n\nWrite a prep note: likely purpose (say if guessing), 3 sharp questions to ask, and what Lye should decide or bring. Max 120 words.` }).catch((e) => errText(e)));
      return tg.send(chatId, text);
    }
    case "rtog": {
      const r = RECIPES.find((x) => x.id === id); if (!r) return tg.answerCallback(q.id);
      const on = !recipeState(r).on; setRecipe(id, { on, lastRun: Date.now() });
      tg.answerCallback(q.id, `${r.name} ${on ? "on" : "off"}`);
      const v = recipesView(); return tg.send(chatId, v.text, { buttons: v.buttons });
    }
    case "warep": {
      tg.answerCallback(q.id);
      const a = waData().alerts[id];
      if (!a?.reply) return tg.send(chatId, "No reply drafted for that one.");
      await tg.send(chatId, `Draft reply to ${a.from}${a.replyLang ? " (" + a.replyLang + ")" : ""}, long-press to copy into WhatsApp:`);
      return tg.send(chatId, a.reply);
    }
    case "warem": {
      const a = waData().alerts[id]; if (!a) return tg.answerCallback(q.id, "Gone.");
      upsert("tasks", makeTask({ title: a.ask || a.summary, due: a.due, notes: `WhatsApp · ${a.chat}: ${a.text.slice(0, 200)}` }));
      tg.clearButtons(chatId, q.message.message_id);
      return tg.answerCallback(q.id, "Added to reminders");
    }
    case "run": tg.answerCallback(q.id, "Running…"); return withTyping(chatId, () => runRecipe(id, chatId, { manual: true }));
    default: return tg.answerCallback(q.id);
  }
}

/* ---------- scheduler ---------- */
let lastMailPoll = 0, lastWaTriage = 0, ticking = false;
async function tick() {
  if (ticking || !owner()) return;
  ticking = true;
  const chatId = owner(), now = new Date(), d = db();
  try {
    for (const r of RECIPES) {
      const s = recipeState(r);
      if (s.on && isRecipeDue(r.sched, s.lastRun, now)) await runRecipe(r.id, chatId);
    }
    // Reminder pings at the exact time, with buttons.
    for (const t of openTasks(d.tasks)) {
      if (!isMine(t) || !hasTime(t.due) || t.pinged === t.due) continue;
      const due = parseLocal(t.due);
      if (due > now || now - due > 12 * 36e5) continue;
      upsert("tasks", { ...t, pinged: t.due });
      await tg.send(chatId, `⏰ **${t.title}**${t.notes ? "\n" + t.notes : ""}`, { buttons: taskButtons(t) });
    }
    // Heads-up before meetings in the calendar feed.
    d.meta.headsUp = d.meta.headsUp || {};
    const soon = eventsBetween(d.agenda.events, now, new Date(now.getTime() + config.meetingHeadsUpMinutes * 6e4))
      .filter((e) => !e.allDay && new Date(e.start) > now && !Object.values(d.meta.headsUp).some((h) => h.start === e.start && h.title === e.title));
    for (const e of soon) {
      const k = newId(); d.meta.headsUp[k] = { title: e.title, start: e.start, location: e.location }; save();
      const mins = Math.round((new Date(e.start) - now) / 6e4);
      await tg.send(chatId, `🗓 In ${mins} min: **${e.title}**${e.location ? " · " + e.location : ""}`, { buttons: [[{ text: "Prep me", callback_data: `prep:${k}` }]] });
    }
    for (const [k, h] of Object.entries(d.meta.headsUp)) if (new Date(h.start) < now - 864e5) delete d.meta.headsUp[k];

    // WhatsApp: flag messages that need Lye, after a 10-minute hold so his own phone replies cancel them.
    if (waState() === "connected" && now - lastWaTriage > 5 * 6e4) {
      lastWaTriage = now.getTime();
      for (const a of await triageWhatsApp(now.getTime())) {
        const buttons = [[...(a.reply ? [{ text: "Draft reply", callback_data: `warep:${a.id}` }] : []), { text: "Remind me", callback_data: `warem:${a.id}` }]];
        await tg.send(chatId, `💬 **WhatsApp · ${a.from}**${a.isGroup ? ` in ${a.chat}` : ""}\n${a.summary}${a.due ? "\nDue: " + a.due.replace("T", " ") : ""}\n\n> ${a.text.replace(/\s+/g, " ").slice(0, 280)}`, { buttons });
      }
    }
    if (mailEnabled() && now - lastMailPoll > config.gmail.pollMinutes * 6e4) {
      lastMailPoll = now.getTime();
      const res = await pollMail();
      if (res.agenda && !d.meta.agendaWelcomed) {
        d.meta.agendaWelcomed = true; save();
        await tg.send(chatId, `📅 Calendar connected: ${d.agenda.events.length} events from your iPhone (Lotus included). I'll use it for briefs and meeting heads-ups.`);
      }
      const fresh = res.mail.filter((m) => now - m.date < 12 * 36e5);
      for (const m of fresh.filter((x) => x.urgency === "urgent")) {
        m.pushed = true;
        const buttons = [[...(m.actions.length ? [{ text: `Add ${m.actions.length} action${m.actions.length > 1 ? "s" : ""}`, callback_data: `mact:${m.id}` }] : []),
          ...(m.suggested_reply ? [{ text: "Draft reply", callback_data: `mrep:${m.id}` }] : [])]].filter((r) => r.length);
        await tg.send(chatId, `🔴 **Lotus Notes · ${m.from}**\n${m.subject}\n\n${m.summary}${m.actions.length ? "\n\n" + m.actions.map((a) => "- " + a.task).join("\n") : ""}`, { buttons: buttons.length ? buttons : undefined });
      }
      const invites = fresh.filter((x) => x.is_invite && x.urgency !== "urgent");
      if (invites.length) {
        invites.forEach((m) => (m.pushed = true));
        await tg.send(chatId, "📨 **New invites in Lotus Notes**\n" + invites.map(inviteLine).join("\n") + "\n\n_Reply to them in Notes or iPhone Calendar._");
      }
      save();
    }
  } catch (e) {
    console.error("tick error:", e);
  } finally { ticking = false; }
}

/* ---------- main loop ---------- */
let queue = Promise.resolve();
async function main() {
  await tg.deleteWebhook();
  await tg.setCommands([
    { command: "brief", description: "Morning brief now" }, { command: "today", description: "Today's calendar and reminders" },
    { command: "week", description: "Week ahead" }, { command: "todo", description: "Your open reminders" },
    { command: "waiting", description: "What others owe you" }, { command: "notes", description: "Lotus Notes, last 24h" },
    { command: "spend", description: "Spending, last 7 days" }, { command: "meeting", description: "Next recording/transcript becomes minutes" },
    { command: "recipes", description: "Switch routines on or off" }, { command: "new", description: "Start a fresh conversation" },
    { command: "wa", description: "WhatsApp: who's waiting on you" }, { command: "whatsapp", description: "Link or unlink WhatsApp (read-only)" },
    { command: "status", description: "What's connected" }, { command: "help", description: "How to use Pal" },
  ]);
  console.log(`Pal is running. Owner: ${owner() || "(not set: send /start to the bot to get your id)"}`);
  if (owner() && !db().meta.welcomed) { db().meta.welcomed = true; save(); tg.send(owner(), "👋 Pal is online.\n\n" + HELP).catch(() => {}); }
  setInterval(tick, 30000); setTimeout(tick, 3000);
  setInterval(() => { prune(); waMaintenance(); }, 864e5);
  if (waLinkedBefore()) startWhatsApp({ onNotify: (t) => tg.send(owner(), t) }).catch((e) => console.error("WhatsApp start failed:", e.message));

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.getUpdates(offset);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) handleCallback(u.callback_query).catch((e) => console.error("callback", e));
        else if (u.message) {
          queue = queue.then(() => handleMessage(u.message)).catch(async (e) => {
            console.error("message error:", e);
            await tg.send(u.message.chat.id, errText(e)).catch(() => {});
          });
        }
      }
    } catch (e) {
      if (e.code === 409) console.error("Another copy of Pal is polling this bot. Stop the other copy.");
      else if (e.code === 401) { console.error("TELEGRAM_BOT_TOKEN was rejected. Check it with @BotFather."); process.exit(1); }
      else console.error("getUpdates:", e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { flush(); } catch {} process.exit(0); });
main();
