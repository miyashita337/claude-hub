import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createHmac } from "crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bufferToBase64url } from "../../src/action/token";
import {
  collectAnswers,
  parseAskQuestions,
  renderAskFormHtml,
  realAskDeps,
  type AskDeps,
  type AskQuestion,
} from "../../src/action/ask";
import type { EvaluateDeps } from "../../src/action/receiver";

process.env.SUPERVISOR_DB_PATH = ":memory:";
const { handleActRequest } = await import("../../src/action/receiver");

// Issue #519: AskUserQuestion answers from the phone
const KEY = "ask-test-key";
const NOW = 1_000_000;

const QUESTIONS: AskQuestion[] = [
  {
    question: "A か B か？",
    header: "選択",
    multiSelect: false,
    options: [{ label: "A", description: "案 A" }, { label: "B" }],
  },
];

function token(overrides: Record<string, unknown> = {}): string {
  const obj = {
    v: 1,
    action: "ask-answer",
    target: "ask-0123456789abcdef",
    iat: NOW,
    ttl: 1800,
    nonce: `n-${Math.random()}`,
    ...overrides,
  };
  const payload = bufferToBase64url(Buffer.from(JSON.stringify(obj), "utf8"));
  const sig = bufferToBase64url(createHmac("sha256", KEY).update(payload).digest());
  return `${payload}.${sig}`;
}

function makeDeps(ask: AskDeps | undefined, nonces: string[] = []): EvaluateDeps {
  return {
    key: KEY,
    nowSeconds: NOW,
    // ask-answer is routed by its action, never through the execute allowlist
    isActionAllowed: () => false,
    consumeNonce: (n) => {
      if (nonces.includes(n)) return false;
      nonces.push(n);
      return true;
    },
    execute: async () => {
      throw new Error("ask-answer must not reach executeAction");
    },
    ask,
  };
}

function spyAsk(questions: AskQuestion[] | null = QUESTIONS) {
  const written: Record<string, string>[] = [];
  const ask: AskDeps = {
    readQuestions: async () => questions,
    writeAnswers: async (_id, a) => {
      written.push(a);
      return true;
    },
  };
  return { ask, written };
}

function url(t: string, extra = ""): URL {
  return new URL(`http://100.80.0.1:8317/act?t=${encodeURIComponent(t)}${extra}`);
}

describe("action/ask collectAnswers", () => {
  test("picked option → its label, keyed by question text", () => {
    const r = collectAnswers(new URLSearchParams("q0=1"), QUESTIONS);
    expect(r).toEqual({ ok: true, answers: { "A か B か？": "B" } });
  });

  test("free text wins over the choice", () => {
    const r = collectAnswers(new URLSearchParams("q0=0&t0=どちらでもない"), QUESTIONS);
    expect(r).toEqual({ ok: true, answers: { "A か B か？": "どちらでもない" } });
  });

  test("multiSelect joins labels with commas in option order", () => {
    const qs: AskQuestion[] = [
      { question: "どれ？", multiSelect: true, options: [{ label: "x" }, { label: "y" }, { label: "z" }] },
    ];
    const r = collectAnswers(new URLSearchParams("q0=2&q0=0"), qs);
    expect(r).toEqual({ ok: true, answers: { "どれ？": "x, z" } });
  });

  test("unanswered, out of range, or two picks on a single-select → missing", () => {
    expect(collectAnswers(new URLSearchParams(""), QUESTIONS)).toEqual({ ok: false, missing: [0] });
    expect(collectAnswers(new URLSearchParams("q0=5"), QUESTIONS)).toEqual({ ok: false, missing: [0] });
    expect(collectAnswers(new URLSearchParams("q0=0&q0=1"), QUESTIONS)).toEqual({
      ok: false,
      missing: [0],
    });
  });
});

describe("action/ask parse + render", () => {
  test("parseAskQuestions rejects non-ask content (empty perm .pending)", () => {
    expect(parseAskQuestions([])).toBeNull();
    expect(parseAskQuestions("")).toBeNull();
    expect(parseAskQuestions([{ question: 1 }])).toBeNull();
    expect(parseAskQuestions(QUESTIONS)?.[0]?.options.length).toBe(2);
  });

  test("model-provided text is escaped in the form", () => {
    const html = renderAskFormHtml("tok", [
      { question: "<script>x</script>", options: [{ label: '"><img src=x>' }] },
    ]);
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("action/receiver ask-answer path", () => {
  test("opening the link shows the form and spends no nonce", async () => {
    const nonces: string[] = [];
    const { ask, written } = spyAsk();
    const res = await handleActRequest(url(token()), makeDeps(ask, nonces));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A か B か？");
    expect(html).toContain('name="q0" value="1"');
    expect(nonces).toEqual([]);
    expect(written).toEqual([]);
  });

  test("submitting writes the answers once; the same link cannot answer again", async () => {
    const nonces: string[] = [];
    const { ask, written } = spyAsk();
    const t = token({ nonce: "fixed" });
    const first = await handleActRequest(url(t, "&submit=1&q0=1"), makeDeps(ask, nonces));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("回答を送りました");
    expect(written).toEqual([{ "A か B か？": "B" }]);
    const again = await handleActRequest(url(t, "&submit=1&q0=0"), makeDeps(ask, nonces));
    expect(again.status).toBe(409);
    expect(written.length).toBe(1);
  });

  test("incomplete submit re-shows the form without spending the nonce", async () => {
    const nonces: string[] = [];
    const { ask, written } = spyAsk();
    const res = await handleActRequest(url(token(), "&submit=1"), makeDeps(ask, nonces));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("未回答です");
    expect(nonces).toEqual([]);
    expect(written).toEqual([]);
  });

  test("request no longer waiting (timed out) → 404", async () => {
    const { ask } = spyAsk(null);
    const res = await handleActRequest(url(token()), makeDeps(ask));
    expect(res.status).toBe(404);
  });

  test("forged or expired token is rejected before anything is read", async () => {
    let read = false;
    const ask: AskDeps = {
      readQuestions: async () => {
        read = true;
        return QUESTIONS;
      },
      writeAnswers: async () => true,
    };
    // flip a leading signature char: the last char of a base64url digest can carry only padding bits
    const good = token();
    const dot = good.indexOf(".");
    const forged = good.slice(0, dot + 1) + (good[dot + 1] === "A" ? "B" : "A") + good.slice(dot + 2);
    expect((await handleActRequest(url(forged), makeDeps(ask))).status).toBe(401);
    expect((await handleActRequest(url(token({ iat: NOW - 4000 })), makeDeps(ask))).status).toBe(410);
    expect(read).toBe(false);
  });
});

describe("action/ask realAskDeps (files shared with ask-user-remote.sh)", () => {
  let dir: string;
  const prev = process.env.PERM_REQUEST_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ask-files-"));
    process.env.PERM_REQUEST_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PERM_REQUEST_DIR;
    else process.env.PERM_REQUEST_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads the pending questions and publishes <id>.answer once", async () => {
    const id = "ask-0123456789abcdef";
    expect(await realAskDeps.readQuestions(id)).toBeNull();
    expect(await realAskDeps.writeAnswers(id, { q: "a" })).toBe(false);
    writeFileSync(join(dir, `${id}.pending`), JSON.stringify(QUESTIONS));
    expect((await realAskDeps.readQuestions(id))?.[0]?.question).toBe("A か B か？");
    expect(await realAskDeps.writeAnswers(id, { "A か B か？": "B" })).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, `${id}.answer`), "utf8"))).toEqual({ "A か B か？": "B" });
    await expect(realAskDeps.writeAnswers(id, { "A か B か？": "A" })).rejects.toThrow();
  });

  test("unsafe ids never touch the filesystem", async () => {
    expect(await realAskDeps.readQuestions("../../etc/passwd")).toBeNull();
    expect(await realAskDeps.writeAnswers("a/b/c/d/e", {})).toBe(false);
    expect(existsSync(join(dir, "a"))).toBe(false);
  });
});
