// Claude writes light markdown; Telegram wants a small HTML subset.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export function toTelegramHTML(md) {
  const lines = String(md || "").split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l)) {
      // Tables read best as monospace blocks on a phone.
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/\*\*/g, "")));
      const w = cells[0].map((_, c) => Math.min(22, Math.max(...cells.map((r) => (r[c] || "").length))));
      out.push("<pre>" + esc(cells.map((r) => r.map((c, k) => (c || "").slice(0, 22).padEnd(w[k])).join("  ").trimEnd()).join("\n")) + "</pre>");
      continue;
    }
    if (/^```/.test(l)) {
      const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      out.push("<pre>" + esc(code.join("\n")) + "</pre>");
      continue;
    }
    if (/^#{1,4}\s+/.test(l)) { out.push("<b>" + inline(l.replace(/^#+\s+/, "")) + "</b>"); continue; }
    if (/^\s*[-*•]\s+/.test(l)) { out.push("• " + inline(l.replace(/^\s*[-*•]\s+/, ""))); continue; }
    if (/^\s*>\s?/.test(l)) { out.push("<blockquote>" + inline(l.replace(/^\s*>\s?/, "")) + "</blockquote>"); continue; }
    out.push(inline(l));
  }
  return out.join("\n");
}

// Telegram caps messages at 4096 characters; split on paragraph boundaries, leaving room for HTML tags.
export function splitMessage(text, max = 3500) {
  if (text.length <= max) return [text];
  const parts = []; let cur = "";
  for (const para of text.split(/\n(?=\n)|\n(?=[-*•#|])/)) {
    if ((cur + "\n" + para).length > max && cur) { parts.push(cur); cur = para.replace(/^\n/, ""); }
    else cur = cur ? cur + "\n" + para : para;
    while (cur.length > max) { parts.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
