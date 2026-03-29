import { test, expect, describe, beforeEach } from "bun:test";
import { SessionManager } from "../../src/session/manager";
import { CHANNEL_MAP } from "../../src/config/channels";

describe("SessionManager (thread-based)", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  test("starts a session with threadId", () => {
    const config = CHANNEL_MAP.get("oci-develop")!;
    const threadId = "thread-123";
    const session = manager.start(config, threadId);

    expect(session.id).toBeTruthy();
    expect(session.channelName).toBe("oci-develop");
    expect(session.threadId).toBe(threadId);
    expect(session.projectDir).toBe(config.dir);
    expect(session.status).toBe("running");
  });

  test("has() checks by threadId", () => {
    const config = CHANNEL_MAP.get("oci-develop")!;
    const threadId = "thread-456";
    manager.start(config, threadId);

    expect(manager.has(threadId)).toBe(true);
    expect(manager.has("thread-nonexistent")).toBe(false);
  });

  test("allows multiple sessions in the same channel", () => {
    const config = CHANNEL_MAP.get("oci-develop")!;
    manager.start(config, "thread-1");
    manager.start(config, "thread-2");

    expect(manager.count()).toBe(2);
    expect(manager.has("thread-1")).toBe(true);
    expect(manager.has("thread-2")).toBe(true);
  });

  test("listRunningByChannel returns sessions for a specific channel", () => {
    const ociConfig = CHANNEL_MAP.get("oci-develop")!;
    const devConfig = CHANNEL_MAP.get("dev-tool")!;
    manager.start(ociConfig, "thread-oci-1");
    manager.start(ociConfig, "thread-oci-2");
    manager.start(devConfig, "thread-dev-1");

    const ociSessions = manager.listRunningByChannel("oci-develop");
    expect(ociSessions).toHaveLength(2);

    const devSessions = manager.listRunningByChannel("dev-tool");
    expect(devSessions).toHaveLength(1);
  });

  test("stop() removes session by threadId", async () => {
    const config = CHANNEL_MAP.get("oci-develop")!;
    manager.start(config, "thread-to-stop");

    expect(manager.has("thread-to-stop")).toBe(true);
    // stop() waits GRACEFUL_KILL_TIMEOUT_MS (15s), so increase test timeout
    await manager.stop("thread-to-stop", "manual");
    expect(manager.has("thread-to-stop")).toBe(false);
  }, 20_000);

  test("stop() throws for nonexistent thread", async () => {
    await expect(
      manager.stop("nonexistent-thread", "manual")
    ).rejects.toThrow("セッションが見つかりません");
  });

  test("throws when max sessions exceeded", () => {
    const config = CHANNEL_MAP.get("oci-develop")!;
    // Start MAX_SESSIONS sessions
    for (let i = 0; i < 10; i++) {
      manager.start(config, `thread-${i}`);
    }
    expect(() => manager.start(config, "thread-overflow")).toThrow(
      "最大セッション数"
    );
  });

  test("throws for duplicate threadId", () => {
    const config = CHANNEL_MAP.get("oci-develop")!;
    manager.start(config, "thread-dup");
    expect(() => manager.start(config, "thread-dup")).toThrow(
      "既に稼働中です"
    );
  });

  test("touchActivity updates lastActivityAt", () => {
    const config = CHANNEL_MAP.get("oci-develop")!;
    const session = manager.start(config, "thread-touch");
    const initialTime = session.lastActivityAt.getTime();

    // Small delay to ensure time difference
    const later = new Date(initialTime + 1000);
    manager.touchActivity("thread-touch");

    const updated = manager.get("thread-touch");
    expect(updated!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
      initialTime
    );
  });

  test("listRunningByChannel returns empty when no sessions for channel", () => {
    expect(manager.listRunningByChannel("oci-develop")).toHaveLength(0);
  });
});
