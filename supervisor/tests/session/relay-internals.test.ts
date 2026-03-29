import { test, expect, describe } from "bun:test";
import { isAtPrompt, extractResponse } from "../../src/session/relay";

describe("isAtPrompt", () => {
  test("returns true for bare prompt at end", () => {
    // Real tmux capture format: separator lines surround the prompt
    const content = [
      "⏺ Some response text",
      "",
      "──────────────────────────",
      "❯",
      "──────────────────────────",
      "  status | ctx",
    ].join("\n");
    expect(isAtPrompt(content)).toBe(true);
  });

  test("returns true for bare prompt without separator", () => {
    expect(isAtPrompt("response\n❯")).toBe(true);
  });

  test("returns false when thinking indicator is at end (no prompt yet)", () => {
    // During processing, ✱ appears at end — no ❯ prompt yet
    expect(isAtPrompt("❯ my input\n\n✱ Thinking...")).toBe(false);
  });

  test("returns false for Running indicator at end", () => {
    expect(isAtPrompt("❯ my input\n\nRunning… (3s)")).toBe(false);
  });

  test("returns false when no prompt found", () => {
    expect(isAtPrompt("just some text\nno prompt here")).toBe(false);
  });

  test("returns false for prompt with input text only", () => {
    // ❯ followed by text = input line, not empty prompt
    const content = "❯ my input message\n\n⏺ response";
    expect(isAtPrompt(content)).toBe(false);
  });

  test("returns false for + indicator at end (thinking)", () => {
    expect(isAtPrompt("❯ my input\n\n+ Frosting...")).toBe(false);
  });
});

describe("extractResponse", () => {
  test("extracts text after ⏺ between input and separator", () => {
    const content = [
      "❯ hello",
      "",
      "⏺ Hello! How can I help you?",
      "",
      "──────────────────────────",
      "❯",
    ].join("\n");
    const result = extractResponse("", content, "hello");
    expect(result).toContain("Hello! How can I help you?");
  });

  test("extracts single-line response", () => {
    const content = [
      "❯ pwd",
      "",
      "⏺ /Users/harieshokunin/oci_develop",
      "",
      "──────────────────────────",
      "❯",
    ].join("\n");
    const result = extractResponse("", content, "pwd");
    expect(result).toContain("/Users/harieshokunin/oci_develop");
  });

  test("skips tool-use indicator lines", () => {
    const content = [
      "❯ read the image",
      "",
      "  Read 1 file (ctrl+o to expand)",
      "",
      "⏺ This is a test image with red border.",
      "",
      "──────────────────────────",
      "❯",
    ].join("\n");
    const result = extractResponse("", content, "read the image");
    expect(result).toContain("This is a test image with red border.");
  });

  test("skips thinking indicators", () => {
    const content = [
      "❯ complex question",
      "",
      "✱ Choreographing...",
      "",
      "⏺ The answer is 42.",
      "",
      "──────────────────────────",
      "❯",
    ].join("\n");
    const result = extractResponse("", content, "complex question");
    expect(result).toContain("The answer is 42.");
  });

  test("returns empty string when input not found", () => {
    const content = "❯\n──────────────────────────";
    const result = extractResponse("", content, "nonexistent input");
    expect(result).toBe("");
  });

  test("handles tool execution lines starting with ⏺ Bash", () => {
    const content = [
      "❯ do something",
      "",
      "⏺ Bash(ls -la)",
      "  ⎿  file1.txt",
      "     file2.txt",
      "",
      "⏺ Here are the files in the directory.",
      "",
      "──────────────────────────",
      "❯",
    ].join("\n");
    const result = extractResponse("", content, "do something");
    expect(result).toContain("Here are the files");
  });
});
