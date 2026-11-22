/** Text that came from a person's own records becomes data for the model. These helpers keep it short and plain. */

 
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;

/** One line, no control or invisible characters, at most `max` characters. */
export function clean(value: unknown, max = 60): string {
  const text = String(value ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A name or note that may carry anything: clean it and make sure it cannot pose as a tag we use around data. */
export const safeLabel = (value: unknown, max = 40) => clean(value, max).replace(/[<>]/g, "");

/** Cuts a reply at a sentence end when it is too long. */
export function limitReply(text: string, max = 1500): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${(end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim()}…`;
}

/** Code blocks, links and pictures never belong in an answer about the person's own money. */
export function looksOffTopic(reply: string): boolean {
  return /```|~~~|https?:\/\/|www\.|\]\(|<\s*(script|iframe|img|a)\b/i.test(reply);
}
