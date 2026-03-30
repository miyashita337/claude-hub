import { test, expect, describe } from "bun:test";
import { isAtPrompt, extractResponse } from "../../src/session/relay";

describe("isAtPrompt", () => {
  test("returns true for bare prompt at end", () => {
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

  test("returns false when thinking indicator is at end", () => {
    expect(isAtPrompt("❯ my input\n\n✱ Thinking...")).toBe(false);
  });

  test("returns false for Running indicator at end", () => {
    expect(isAtPrompt("❯ my input\n\nRunning… (3s)")).toBe(false);
  });

  test("returns false when no prompt found", () => {
    expect(isAtPrompt("just some text\nno prompt here")).toBe(false);
  });

  test("returns false for prompt with input text only", () => {
    expect(isAtPrompt("❯ my input message\n\n⏺ response")).toBe(false);
  });

  test("returns false during permission dialog", () => {
    const content = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "",
      "Esc to cancel",
    ].join("\n");
    expect(isAtPrompt(content)).toBe(false);
  });

  test("returns false for + indicator at end", () => {
    expect(isAtPrompt("❯ my input\n\n+ Frosting...")).toBe(false);
  });
});

describe("extractResponse", () => {
  test("extracts simple text response", () => {
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

  test("extracts single-line response (pwd)", () => {
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

  test("extracts last text block when tool calls precede it", () => {
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
    expect(result).not.toContain("Bash(ls");
  });

  test("extracts response after Read tool", () => {
    const content = [
      "❯ Read the image at /tmp/image.png. describe it",
      "",
      "  Read 1 file (ctrl+o to expand)",
      "",
      "⏺ This is a test image with a red border.",
      "",
      "──────────────────────────",
      "❯",
    ].join("\n");
    // Search with the original Discord message, not the relay-modified one
    const result = extractResponse("", content, "describe it");
    expect(result).toContain("This is a test image with a red border.");
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

  test("handles complex multi-tool response", () => {
    const content = [
      "❯ analyze this code",
      "",
      "⏺ Read(src/main.ts)",
      "  ⎿  const x = 1;",
      "",
      "⏺ Bash(bun test)",
      "  ⎿  3 pass, 0 fail",
      "",
      "⏺ The code looks good. All 3 tests pass and the implementation is clean.",
      "",
      "──────────────────────────",
      "❯",
    ].join("\n");
    const result = extractResponse("", content, "analyze this code");
    expect(result).toContain("The code looks good");
    expect(result).not.toContain("Read(src/main.ts)");
    expect(result).not.toContain("Bash(bun test)");
  });

  test("handles multi-line text response", () => {
    const content = [
      "❯ explain",
      "",
      "⏺ Line one of the explanation.",
      "  Line two continues here.",
      "  Line three wraps up.",
      "",
      "──────────────────────────",
      "❯",
    ].join("\n");
    const result = extractResponse("", content, "explain");
    expect(result).toContain("Line one");
    expect(result).toContain("Line two");
    expect(result).toContain("Line three");
  });

  test("uses shorter search term as fallback", () => {
    const content = [
      "❯ Read the image at /tmp/att.png. describe this",
      "",
      "⏺ It's a red circle.",
      "",
      "──────────────────────────",
      "❯",
    ].join("\n");
    // Original message was "describe this" but relay prepended image path
    const result = extractResponse("", content, "describe this");
    expect(result).toContain("It's a red circle.");
  });
});
