import { test, expect, describe } from "bun:test";
import {
  formatForDiscord,
  parseStreamJsonOutput,
} from "../../src/session/output-formatter";

describe("formatForDiscord", () => {
  test("returns single chunk for short text", () => {
    const result = formatForDiscord("Hello, world!");
    expect(result).toEqual(["Hello, world!"]);
  });

  test("returns single chunk for text at exactly 2000 chars", () => {
    const text = "a".repeat(2000);
    const result = formatForDiscord(text);
    expect(result).toEqual([text]);
  });

  test("splits long text at newline boundaries", () => {
    const line = "a".repeat(100) + "\n";
    const text = line.repeat(25); // 2525 chars
    const result = formatForDiscord(text);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    // Reassembled text should match original
    expect(result.join("")).toBe(text);
  });

  test("preserves code blocks when splitting", () => {
    const before = "a".repeat(1960) + "\n";
    const codeBlock = "```typescript\nconst x = 1;\nconst y = 2;\n```\n";
    const text = before + codeBlock;
    const result = formatForDiscord(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Reassembled text should contain all code
    const reassembled = result.join("");
    expect(reassembled).toContain("const x = 1;");
    expect(reassembled).toContain("const y = 2;");
  });

  test("handles text with no newlines", () => {
    const text = "a".repeat(5000);
    const result = formatForDiscord(text);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  test("handles code block spanning split boundary", () => {
    const text =
      "a".repeat(1950) +
      "\n```python\n" +
      "x = 1\n".repeat(20) +
      "```\n";
    const result = formatForDiscord(text);
    // Each chunk should have balanced code fences
    for (const chunk of result) {
      const fenceCount = (chunk.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  test("handles empty string", () => {
    const result = formatForDiscord("");
    expect(result).toEqual([""]);
  });

  test("wraps bare markdown tables in code fences", () => {
    const text = "Here is a table:\n| Name | Value |\n|---|---|\n| foo | bar |\n\nDone.";
    const result = formatForDiscord(text);
    const joined = result.join("");
    expect(joined).toContain("```\n| Name | Value |");
    expect(joined).toContain("| foo | bar |\n```");
  });

  test("does not double-wrap tables already in code fences", () => {
    const text = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
    const result = formatForDiscord(text);
    const joined = result.join("");
    // Should have exactly 2 code fences (open + close)
    const fences = joined.match(/```/g) || [];
    expect(fences.length).toBe(2);
  });
});

describe("parseStreamJsonOutput", () => {
  test("extracts result from JSON output", () => {
    const output = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Hello from Claude!",
      session_id: "test-123",
    });
    const result = parseStreamJsonOutput(output);
    expect(result).toBe("Hello from Claude!");
  });

  test("extracts text from assistant message", () => {
    const output = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello!" }],
      },
    });
    const result = parseStreamJsonOutput(output);
    expect(result).toBe("Hello!");
  });

  test("handles multi-line NDJSON with result at end", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Working..." }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Final answer",
        session_id: "abc",
      }),
    ];
    const result = parseStreamJsonOutput(lines.join("\n"));
    expect(result).toBe("Final answer");
  });

  test("returns empty string for empty input", () => {
    const result = parseStreamJsonOutput("");
    expect(result).toBe("");
  });

  test("returns empty string for non-JSON input", () => {
    const result = parseStreamJsonOutput("not json at all");
    expect(result).toBe("");
  });

  test("handles assistant message with multiple text blocks", () => {
    const output = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part 1\n" },
          { type: "tool_use", name: "Bash" },
          { type: "text", text: "Part 2" },
        ],
      },
    });
    const result = parseStreamJsonOutput(output);
    expect(result).toBe("Part 1\n\nPart 2");
  });
});
