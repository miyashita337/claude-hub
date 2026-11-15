import { describe, expect, test } from "bun:test";
import { CHANNEL_MAP } from "../../src/config/channels";
import { buildClaudeFlags } from "../../src/session/manager";

// Issue #566: note のブラウザ作業を行うチャンネルは --no-chrome で起動してはならない。
describe("CHANNEL_MAP chrome opt-in (#566)", () => {
  test.each(["corp", "team-salary"])("%s は --no-chrome を付けない", (name) => {
    const config = CHANNEL_MAP.get(name);
    expect(config).toBeDefined();
    expect(buildClaudeFlags(config!)).not.toContain("--no-chrome");
  });

  test("opt-in していないチャンネルは既定どおり --no-chrome", () => {
    const config = CHANNEL_MAP.get("convert-service");
    expect(buildClaudeFlags(config!)).toContain("--no-chrome");
  });
});
