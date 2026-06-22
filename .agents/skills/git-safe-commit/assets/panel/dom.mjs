export const $ = (selector) => document.querySelector(selector);

export function list(items) {
  return items && items.length ? items.join("\n") : "(无)";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function commandText(result) {
  if (!result) return "";
  return [result.stdout, result.stderr, result.error].filter(Boolean).join("\n").trim();
}
