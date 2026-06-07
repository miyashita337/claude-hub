import { describe, test, expect } from "bun:test";
import { parseDispatchCommand } from "../../src/session/dispatch";

/**
 * Issue #32 / S7 (dispatch transport): an allowed external source posts a
 * single message to a department channel:
 *
 *   /dispatch <branch> <issueNumber>
 *
 * `parseDispatchCommand` is the pure validator. It rejects anything that is
 * not the exact shape, a branch with shell metacharacters / path traversal
 * (RW-045 reuse), or a non-positive-integer issue number. A non-`/dispatch`
 * message yields `{ kind: "not_dispatch" }` so the caller falls through to the
 * normal relay path.
 */

describe("parseDispatchCommand", () => {
  test("parses a valid /dispatch command", () => {
    const r = parseDispatchCommand("/dispatch corp-dispatch-42 42");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.branch).toBe("corp-dispatch-42");
      expect(r.issueNumber).toBe(42);
    }
  });

  test("tolerates extra surrounding whitespace", () => {
    const r = parseDispatchCommand("   /dispatch   feat/foo   7   ");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.branch).toBe("feat/foo");
      expect(r.issueNumber).toBe(7);
    }
  });

  test("non-/dispatch content → not_dispatch (falls through to relay)", () => {
    expect(parseDispatchCommand("hello world").kind).toBe("not_dispatch");
    expect(parseDispatchCommand("/impl 42").kind).toBe("not_dispatch");
    expect(parseDispatchCommand("/dispatcher x 1").kind).toBe("not_dispatch");
    expect(parseDispatchCommand("").kind).toBe("not_dispatch");
  });

  test("missing issue number → error (not silently a relay)", () => {
    const r = parseDispatchCommand("/dispatch some-branch");
    expect(r.kind).toBe("error");
  });

  test("too many arguments → error", () => {
    const r = parseDispatchCommand("/dispatch some-branch 42 extra");
    expect(r.kind).toBe("error");
  });

  test("non-integer issue number → error", () => {
    expect(parseDispatchCommand("/dispatch some-branch abc").kind).toBe("error");
    expect(parseDispatchCommand("/dispatch some-branch 4.2").kind).toBe("error");
    expect(parseDispatchCommand("/dispatch some-branch 4x").kind).toBe("error");
  });

  test("zero / negative issue number → error", () => {
    expect(parseDispatchCommand("/dispatch some-branch 0").kind).toBe("error");
    expect(parseDispatchCommand("/dispatch some-branch -5").kind).toBe("error");
  });

  test("branch with shell metacharacters → error (RW-045)", () => {
    for (const bad of [
      '/dispatch foo"bar 1',
      "/dispatch foo`bar 1",
      "/dispatch foo$bar 1",
      "/dispatch foo\\bar 1",
    ]) {
      const r = parseDispatchCommand(bad);
      expect(r.kind).toBe("error");
    }
  });

  test("branch path traversal → error (RW-045)", () => {
    const r = parseDispatchCommand("/dispatch ../../etc 1");
    expect(r.kind).toBe("error");
  });

  test("error reason is identifier-free of the raw issue arg", () => {
    const r = parseDispatchCommand("/dispatch some-branch not-a-number");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      // The coarse message names the field, not the raw user-supplied token.
      expect(r.reason).not.toContain("not-a-number");
    }
  });

  test("a very large issue number is accepted as a positive integer", () => {
    const r = parseDispatchCommand("/dispatch b 1000000");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.issueNumber).toBe(1000000);
  });
});
