import { readFile } from "fs/promises";
import { join } from "path";
import { PERM_REQUEST_ID, permRequestDir, publishAnswerFile } from "./execute";

/**
 * AskUserQuestion answers from the phone (Issue #519).
 *
 * `hooks/ask-user-remote.sh` (PreToolUse[AskUserQuestion]) writes the tool's
 * `questions` array to `<id>.pending` and sends one Pushover link carrying a
 * signed `ask-answer` token for that id. One link instead of one per option:
 * each token is ~250 chars and Pushover caps the whole message at 1024, so four
 * per-option links would not fit.
 *
 * Opening the link renders a form built from `<id>.pending` (no nonce spent, so
 * reloading the page is harmless). Submitting it spends the nonce and publishes
 * `<id>.answer` = JSON `{ "<question text>": "<answer>" }` — the exact shape of
 * the tool's `answers` input, so the hook passes it through unchanged as
 * `updatedInput.answers` (code.claude.com/docs/en/hooks, AskUserQuestion:
 * "Maps question text to the selected option label. Multi-select answers join
 * labels with commas").
 */

export const ASK_ACTION = "ask-answer";

/** Upper bound for a free-text answer; the hook hands it to the model verbatim. */
export const MAX_FREE_TEXT = 1000;

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface AskDeps {
  /** The pending request's questions, or null when the id is not waiting. */
  readQuestions: (id: string) => Promise<AskQuestion[] | null>;
  /** Publish the answers. False = not pending; throws = already answered. */
  writeAnswers: (id: string, answers: Record<string, string>) => Promise<boolean>;
}

/** Shape-check the `questions` array written by the hook. Null on anything unexpected. */
export function parseAskQuestions(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) return null;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== "string" || r.question.length === 0) return null;
    const options: AskOption[] = [];
    for (const o of Array.isArray(r.options) ? r.options : []) {
      if (typeof o !== "object" || o === null) return null;
      const or = o as Record<string, unknown>;
      if (typeof or.label !== "string") return null;
      options.push({
        label: or.label,
        description: typeof or.description === "string" ? or.description : undefined,
      });
    }
    out.push({
      question: r.question,
      header: typeof r.header === "string" ? r.header : undefined,
      multiSelect: r.multiSelect === true,
      options,
    });
  }
  // `answers` is keyed by question text: two identical questions would overwrite
  // each other, so such a request is not answerable here (the TUI handles it)
  if (new Set(out.map((q) => q.question)).size !== out.length) return null;
  return out;
}

export type CollectResult =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; missing: number[] };

/**
 * Read the submitted form. Per question `i`: free text `t<i>` wins over the
 * choices `q<i>` (option indexes). A single-select question with more than one
 * index, or an index out of range, counts as unanswered.
 */
export function collectAnswers(
  params: URLSearchParams,
  questions: AskQuestion[]
): CollectResult {
  const answers: Record<string, string> = {};
  const missing: number[] = [];
  questions.forEach((q, i) => {
    const text = (params.get(`t${i}`) ?? "").trim().slice(0, MAX_FREE_TEXT);
    if (text) {
      answers[q.question] = text;
      return;
    }
    // Number("") is 0, so an empty `q0=` must not count as picking option 1
    const picked = [
      ...new Set(params.getAll(`q${i}`).filter((s) => /^\d+$/.test(s))),
    ].map(Number);
    const valid =
      picked.length > 0 &&
      (q.multiSelect || picked.length === 1) &&
      picked.every((n) => Number.isInteger(n) && n >= 0 && n < q.options.length);
    if (!valid) {
      missing.push(i);
      return;
    }
    answers[q.question] = picked
      .sort((a, b) => a - b)
      .map((n) => q.options[n]!.label)
      .join(", ");
  });
  return missing.length === 0 ? { ok: true, answers } : { ok: false, missing };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The answer form. Question and option text come from the model, so every
 * interpolated value is escaped. The token is carried in a hidden field so the
 * submit goes back through the same signature / TTL / nonce checks.
 */
export function renderAskFormHtml(
  token: string,
  questions: AskQuestion[],
  missing: number[] = []
): string {
  const blocks = questions
    .map((q, i) => {
      const type = q.multiSelect ? "checkbox" : "radio";
      const opts = q.options
        .map(
          (o, n) =>
            `<label class="opt"><input type="${type}" name="q${i}" value="${n}"> ` +
            `<span>${n + 1}. ${esc(o.label)}${
              o.description ? `<small>${esc(o.description)}</small>` : ""
            }</span></label>`
        )
        .join("\n");
      const head = q.header ? `<div class="hd">${esc(q.header)}</div>` : "";
      const warn = missing.includes(i) ? `<div class="warn">未回答です</div>` : "";
      return `<fieldset>${head}<legend>${esc(q.question)}</legend>${warn}
${opts}
<input class="free" type="text" name="t${i}" maxlength="${MAX_FREE_TEXT}" placeholder="自由入力（選択より優先）">
</fieldset>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>質問に回答</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 1rem;
         background: #0d1117; color: #e6edf3; }
  fieldset { border: 1px solid #30363d; border-radius: 8px; margin: 0 0 1rem; padding: 0.75rem; }
  legend { font-size: 1.1rem; padding: 0 0.25rem; }
  .hd { color: #8b949e; font-size: 0.85rem; }
  .warn { color: #f85149; }
  .opt { display: flex; gap: 0.5rem; padding: 0.6rem 0; font-size: 1.1rem; }
  .opt small { display: block; color: #8b949e; font-size: 0.85rem; }
  .free { width: 100%; box-sizing: border-box; padding: 0.6rem; font-size: 1rem; margin-top: 0.5rem; }
  button { width: 100%; padding: 0.9rem; font-size: 1.2rem; border: 0; border-radius: 8px;
           background: #238636; color: #fff; }
</style>
</head>
<body>
<form method="get" action="/act">
<input type="hidden" name="t" value="${esc(token)}">
<input type="hidden" name="submit" value="1">
${blocks}
<button type="submit">回答を送る</button>
</form>
</body>
</html>`;
}

/** Production {@link AskDeps}: the files shared with `hooks/ask-user-remote.sh`. */
export const realAskDeps: AskDeps = {
  async readQuestions(id) {
    if (!PERM_REQUEST_ID.test(id)) return null;
    let text: string;
    try {
      text = await readFile(join(permRequestDir(), `${id}.pending`), "utf8");
    } catch (err) {
      // ENOENT = not waiting (timed out / answered at the Mac) — the normal "not found"
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[action-ask] cannot read pending request ${id}:`, err);
      }
      return null;
    }
    try {
      return parseAskQuestions(JSON.parse(text));
    } catch {
      // A permission request's `.pending` is empty — not an ask request
      return null;
    }
  },
  async writeAnswers(id, answers) {
    if (!PERM_REQUEST_ID.test(id)) return false;
    return publishAnswerFile(id, "answer", JSON.stringify(answers));
  },
};
