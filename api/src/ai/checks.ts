/** Output checks for model text. Rules are plain regular expressions, no markdown parser. */

/** Reject rule names. Each is also the fixed word used in the log line. */
export type RejectRule = "marker" | "code" | "link" | "tag" | "table";

/** Removes closed <think> blocks, and cuts from an unclosed <think> to the end. Runs first on every model text. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
}

const MARKER_SHAPE = /\bORC-[0-9a-f]{8}\b/i;
const CODE = /```|~~~/;
const LINK = /https?:\/\/|www\.|\]\(/i;
const TAG = /<\/?[a-z!][^>]*>/i;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}/;

/** Each rule answers true when the text must be rejected. */
export const isMarkerLeak = (text: string, marker?: string) => (marker ? text.includes(marker) : false) || MARKER_SHAPE.test(text);
export const hasCode = (text: string) => CODE.test(text);
export const hasLink = (text: string) => LINK.test(text);
export const hasTag = (text: string) => TAG.test(text);
export const hasTable = (text: string) => text.split(/\r?\n/).some((line) => TABLE_ROW.test(line) || TABLE_SEPARATOR.test(line));

/** The first reject rule that matches, in design order, or null when the text passes. */
export function rejectRule(text: string, marker?: string): RejectRule | null {
  if (isMarkerLeak(text, marker)) return "marker";
  if (hasCode(text)) return "code";
  if (hasLink(text)) return "link";
  if (hasTag(text)) return "tag";
  if (hasTable(text)) return "table";
  return null;
}

/** Logs only a fixed check name, such as `reply-check:code`. Never pass reply text. */
export function logCheck(name: string): void {
  console.warn(name);
}

/**
 * Plain-text normalization. It never rejects. Run it only after the reject rules, because it removes backticks
 * and would turn a code fence into plain text.
 */
export function normalizePlainText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "") // N-HEADING
        .replace(/^(\s*)(?:\*|•)\s+/, "$1- "), // N-BULLET
    )
    .join("\n")
    .replace(/\*\*|__|~~/g, "") // N-EMPHASIS
    .replace(/`/g, "") // N-CODE-TICK
    .replace(/\n{3,}/g, "\n\n") // N-SPACE
    .trim();
}

/** Code blocks, links and pictures never belong in an answer about the person's own money. */
export function looksOffTopic(reply: string): boolean {
  return /```|~~~|https?:\/\/|www\.|\]\(|<\s*(script|iframe|img|a)\b/i.test(reply);
}
