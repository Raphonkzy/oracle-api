/** Text that came from a person's own records becomes data for the model. These helpers keep it short and plain. */

 
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;

/** One line, no control or invisible characters, at most `max` characters. */
export function clean(value: unknown, max = 60): string {
  const text = String(value ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A name or note that may carry anything: clean it and make sure it cannot pose as a tag we use around data. */
export const safeLabel = (value: unknown, max = 40) => clean(value, max).replace(/[<>]/g, "");

/** Cuts a reply at the last sentence end inside the limit. Without a sentence end, cuts at the limit. */
export function limitReply(text: string, max = 4000): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  let end = -1;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const ch = slice[i];
    if (ch === "\n") {
      end = i;
      break;
    }
    if ((ch === "." || ch === "!" || ch === "?") && (i === slice.length - 1 || /\s/.test(slice[i + 1]))) {
      end = i + 1;
      break;
    }
  }
  return (end > 0 ? slice.slice(0, end) : slice).trim();
}
