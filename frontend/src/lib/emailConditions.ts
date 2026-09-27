import type { Condition, ConditionField, ConditionOp } from "./emailWatcher";

/**
 * Email Watcher conditions in the browser: their labels, and where one takes a text —
 * the same rules the server matches by (backend/src/lib/emailRules.ts), for marking it.
 */

export const FIELD_LABEL: Record<ConditionField, string> = { from: "Sender", subject: "Subject", body: "Body" };
export const OP_LABEL: Record<ConditionOp, string> = {
  contains: "contains",
  not_contains: "does not contain",
  equals: "equals",
  in: "is one of",
  not_in: "is none of",
  regex: "matches regex",
};
export const NEGATIVE: ConditionOp[] = ["not_contains", "not_in"];

export const conditionInvalid = (c: Condition) => {
  if (c.op !== "regex" || !c.value.trim()) return false;
  try {
    new RegExp(c.value.trim(), "i");
    return false;
  } catch {
    return true;
  }
};

/** Conditions the server accepts: a value, and a regex that compiles. */
export const usable = (conditions: Condition[]) => conditions.filter((c) => c.value.trim() && !conditionInvalid(c));

/** Where a condition takes the text: [start, end], or null. Negative ones mark nothing. */
export function spanOf(c: Condition, text: string): [number, number] | null {
  const value = c.value.trim();
  if (!value || NEGATIVE.includes(c.op)) return null;
  const lower = text.toLowerCase();
  const at = (needle: string): [number, number] | null => {
    const i = lower.indexOf(needle.toLowerCase());
    return i < 0 ? null : [i, i + needle.length];
  };
  if (c.op === "contains" || c.op === "equals") return at(value);
  if (c.op === "in") {
    for (const item of value.split(",").map((v) => v.trim()).filter(Boolean)) {
      const span = at(item);
      if (span) return span;
    }
    return null;
  }
  try {
    const m = new RegExp(value, "i").exec(text);
    return m && m[0].length ? [m.index, m.index + m[0].length] : null;
  } catch {
    return null;
  }
}

/** The first mark the conditions on one field leave in a text. */
export const firstSpan = (conditions: Condition[], field: ConditionField, text: string) => {
  for (const c of conditions) {
    if (c.field !== field) continue;
    const span = spanOf(c, text);
    if (span) return span;
  }
  return null;
};
