# Pal: Lye's personal assistant on Telegram

Pal lives in Telegram on your iPhone and laptop, like Pally lives in iMessage. You text it or send voice notes in English, 中文 or BM. It pushes your morning brief, pings reminders with Done/Snooze buttons, warns you before meetings, flags urgent Lotus Notes mail and invite clashes, and turns calls and meetings into minutes with action items.

| You do | Pal does |
|---|---|
| Text "Remind me 3pm tomorrow to call Ahmad" | Creates the reminder and pings you at 3pm with Done / +1 hour / Tomorrow |
| Text "Ahmad owes me the BQ by Friday" | Tracks it under Waiting on; the Follow-up chaser drafts a WhatsApp nudge once it's late |
| Send a short voice note (any language) | Transcribes it and acts on it like a text |
| Send a long voice note after a call, or a meeting recording | Minutes: summary, decisions, your actions, others' actions, key quotes translated, draft reply |
| Send a Zoom transcript (.vtt) or WhatsApp export (.txt) | Same minutes and actions |
| Paste copied WhatsApp messages, or forward a Telegram message | Pulls out what's asked of you and drafts your reply in the thread's language |
| Snap a whiteboard or slide | Extracts the points and actions |
| Nothing (it runs on its own) | 7:30 brief · reminder pings · meeting heads-up 20 min before · urgent Notes mail · Notes digest 12:30 and 5:30 · invite clash check · Sunday recap |

How the pieces connect:

```
iPhone Calendar (incl. Lotus via Traveler) --Shortcut 6:30/12:00/17:00--> Gmail --IMAP--> Pal
Lotus Notes mail --Notes rule "send copy to" you+notes@gmail.com--> Gmail --IMAP--> Pal
Voice notes / audio --Telegram--> Pal --OpenAI transcription--> text --Claude--> reply / minutes
```

WhatsApp has no API for personal accounts, and Meta bars general-purpose AI bots from the WhatsApp Business API, so no assistant can read your WhatsApp. Copy-paste or Export chat into Pal is the shortest path.

---

## Setup (about 30 minutes, once)

### 1. Create the Telegram bot (3 min)
1. In Telegram, open **@BotFather**, send `/newbot`, name it `Pal`, and pick a username such as `lye_pal_bot`.
2. Copy the token it gives you into `TELEGRAM_BOT_TOKEN`.

### 2. Get the API keys (5 min)
- **Claude:** https://platform.claude.com → API keys → `ANTHROPIC_API_KEY`.
- **OpenAI** (voice to text only): the key your meeting-app already uses → `OPENAI_API_KEY`.

### 3. Forward Lotus Notes mail to Pal (5 min)
1. In the Notes client: **Mail → More → Rules** (older versions: **Tools → Rules**) → **New Rule**.
2. Condition: *All documents*, or limit it, e.g. *Sender contains* your boss, key customers and dealers.
3. Action: **send copy to** `yourgmail+notes@gmail.com`, choose **Full copy**.
4. Save, then send yourself a test email and a test meeting invite. Both should arrive in Gmail.

Gmail delivers `+notes` mail to your normal inbox; Pal finds it by that address.

**Gmail app password:** Google Account → Security → turn on 2-Step Verification → **App passwords** → create one called "Pal" → paste the 16 letters into `GMAIL_APP_PASSWORD`, and your address into `GMAIL_ADDRESS`.

### 4. Send your calendar to Pal with an iPhone Shortcut (10 min)
This reads **every calendar on your iPhone**, including Lotus Notes via Traveler, and emails it to Gmail for Pal.

1. Open **Shortcuts** → **+** → name it **Pal agenda**.
2. Add **Find Calendar Events**. Filter: *Start Date is in the next 7 days*. Sort by *Start Date, Oldest First*. No limit.
3. Add **Repeat with Each** (item = Calendar Events).
4. Inside the repeat, add a **Text** action and build this line, inserting each value from *Repeat Item* (tap the variable to pick the property):
   ```
   Start Date|End Date|Title|Location|Calendar|Is All Day|My Status
   ```
   Tap **Start Date** → *Date Format* → **ISO 8601**, *Include ISO 8601 Time* on. Do the same for **End Date**.
5. After **End Repeat**, add **Combine Text**: *Repeat Results*, separator **New Lines**.
6. Add **Send Email**: To = your Gmail address, Subject = `PAL AGENDA`, Body = *Combined Text*. Expand it and turn **Show Compose Sheet** off.
7. Tap **Automation** → **+** → **Time of Day** → 6:30 AM, Daily → **Run Immediately** (and *Notify When Run* off) → choose **Pal agenda**. Repeat for **12:00 PM** and **5:00 PM**, so midday changes and new invites reach Pal too.
8. Run it once by hand. Within 5 minutes Pal messages you "📅 Calendar connected".

*Send Email* uses the Apple Mail app, so at least one account (iCloud or Gmail) must be set up there.

### 5. Run Pal
```bash
cd pal-bot
cp .env.example .env      # fill in the values from steps 1-3
npm install
npm start
```
Send `/start` to your bot. It replies with your Telegram id. Put that id in `TELEGRAM_OWNER_ID`, restart, and Pal answers only you. `/status` shows what's connected.

### 6. Keep it running (pick one)
Pal must run 24/7 to push briefs and reminders.

| Option | Cost | How |
|---|---|---|
| **Railway** (easiest) | about US$5/month | New project → Deploy from GitHub → this repo, root directory `pal-bot` → add the `.env` values as Variables → add a **Volume** mounted at `/app/data` and set `DATA_DIR=/app/data`. |
| Always-on office or home PC / Mac mini | free | `npm install -g pm2 && pm2 start src/index.js --name pal && pm2 save && pm2 startup` |

Avoid free tiers that sleep when idle (e.g. Render free): Pal would miss its schedules.

---

## Using it
- `/brief` morning brief now · `/today` · `/week` · `/todo` (with Done buttons) · `/waiting` · `/notes` (Lotus mail, 24h) · `/spend` · `/recipes` (switch routines on/off) · `/meeting` (next recording or text becomes minutes) · `/new` (fresh conversation) · `/status`
- Voice notes up to 90 seconds are treated as messages; longer ones become minutes. Bots can download files up to **20 MB** (about 40 minutes of iPhone Voice Memos audio). For longer meetings, send the Zoom transcript instead.
- Reply to Lotus invites in Notes or iPhone Calendar as usual. Pal tells you whether you're free and lists unanswered invites in the morning brief, but cannot accept or decline for you.

## When you move to Microsoft 365
Teams and Outlook mail and calendar can then be read directly through Microsoft Graph, replacing the Lotus rule and the Shortcut for work items. That's a follow-up change; the rest of Pal stays the same.

## Running costs (rough estimate)
- Claude (`claude-opus-5-5`, US$4 / US$20 per million input/output tokens): about US$20–40/month for 20–40 messages a day plus mail triage and minutes. Setting `CLAUDE_MODEL=claude-sonnet-5-5` roughly halves this.
- Transcription (`gpt-4o-transcribe`): about US$0.006 per minute of audio, so roughly US$10/month for an hour a day.
- Hosting: US$0–5/month.

## Privacy: check before you forward company mail
Messages pass through Telegram (cloud chats are not end-to-end encrypted), the Anthropic API and the OpenAI API. Neither API trains on your data by default. Before you forward all Lotus Notes mail, confirm this is acceptable under PMC / Nippon Paint policy, or limit the Notes rule to non-confidential senders.

## Development
`npm test` runs the unit tests. Set `TELEGRAM_API_BASE`, `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` to point at local mocks for end-to-end runs.
