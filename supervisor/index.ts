import { startBot } from "./src/bot";

// Global safety net: prevent process crash from unhandled rejections and uncaught exceptions.
// The supervisor must stay alive even if a Discord interaction fails or an async handler throws.
// See Issue #21: Mac sleep/wake causes stale Discord interaction tokens which throw
// "Interaction has already been acknowledged" from async paths that aren't otherwise caught.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Supervisor] Unhandled promise rejection:", reason);
  if (reason instanceof Error && reason.stack) {
    console.error(reason.stack);
  }
  console.error("[Supervisor] Promise:", promise);
});

process.on("uncaughtException", (err) => {
  console.error("[Supervisor] Uncaught exception:", err);
  if (err.stack) {
    console.error(err.stack);
  }
});

const token = process.env.SUPERVISOR_BOT_TOKEN;

if (!token) {
  console.error(
    "[Supervisor] SUPERVISOR_BOT_TOKEN が設定されていません。\n" +
      "以下のいずれかで設定してください:\n" +
      "  1. .env ファイルに SUPERVISOR_BOT_TOKEN=xxx を記載\n" +
      "  2. export SUPERVISOR_BOT_TOKEN=xxx を実行"
  );
  process.exit(1);
}

console.log("[Supervisor] Starting Channel Supervisor...");
startBot(token).catch((err) => {
  console.error("[Supervisor] Fatal error:", err);
  process.exit(1);
});
