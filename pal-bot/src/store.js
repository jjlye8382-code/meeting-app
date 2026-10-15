// A single JSON file on disk. Small, readable, easy to back up.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const FILE = path.join(config.dataDir, "pal.json");
const EMPTY = () => ({
  tasks: [], expenses: [], captures: [], mail: [], agenda: { events: [], receivedAt: 0 },
  session: { messages: [], startedAt: 0, lastAt: 0 }, recap: [], recipes: {}, mailSeenUid: 0, mode: null, meta: {},
});

let data = EMPTY();
let timer = null;

export function load() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(FILE)) {
    try { data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; }
    catch (e) {
      const bad = FILE + ".corrupt-" + Date.now();
      fs.copyFileSync(FILE, bad);
      console.error(`Could not read ${FILE}; saved a copy at ${bad} and started fresh.`, e.message);
      data = EMPTY();
    }
  }
  return data;
}

export const db = () => data;

// Debounced atomic write: temp file then rename, so a crash never leaves half a file.
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
}
export function flush() {
  clearTimeout(timer);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, FILE);
}

export function upsert(list, item) {
  const arr = data[list], i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
  save();
  return item;
}
export function remove(list, id) {
  data[list] = data[list].filter((x) => x.id !== id);
  save();
}
// Keep the file from growing forever.
export function prune() {
  const cutoff = Date.now() - 400 * 864e5;
  data.expenses = data.expenses.filter((e) => (e.created || 0) > cutoff || new Date(e.date).getTime() > cutoff);
  data.tasks = data.tasks.filter((t) => !t.done || (t.doneAt || 0) > Date.now() - 90 * 864e5);
  data.captures = data.captures.slice(-150);
  data.mail = data.mail.slice(-300);
  save();
}
