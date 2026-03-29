import { startBot } from "./src/bot";

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
