/**
 * Best-effort Pushover notification (Issue #12, Journey AC #2).
 *
 * The supervisor runs headless: when a dialog slips past
 * `--dangerously-skip-permissions` and the relay stalls, the user is paged on
 * Discord *and* (optionally) Pushover so a phone push lands even if Discord is
 * backgrounded.
 *
 * Pushover is strictly optional and credential-gated: when
 * `PUSHOVER_TOKEN` / `PUSHOVER_USER_KEY` are unset we log a one-line skip and
 * return `false`. This is NOT a silent fallback — the skip is surfaced so a
 * missing credential is observable (rules/general/agent-output-quality.md #1).
 * Network / API errors are caught and logged; this function never throws so a
 * paging failure can never break the relay path that calls it.
 */

const PUSHOVER_API = "https://api.pushover.net/1/messages.json";
const PUSHOVER_TIMEOUT_MS = 10_000;

export interface PushoverEnv {
  token?: string;
  userKey?: string;
}

function readEnv(): PushoverEnv {
  return {
    token: process.env.PUSHOVER_TOKEN,
    userKey: process.env.PUSHOVER_USER_KEY,
  };
}

/**
 * Issue #255: surface a *startup* warning when Pushover is unconfigured, so the
 * operator learns at boot that stall / dialog paging is disabled — rather than
 * discovering it only when a stall silently fails to page (the #255
 * observability gap, where many `[Pushover] skipped` lines went unnoticed
 * because nothing flagged the missing credentials up front). Returns `true` when
 * both credentials are present. `env` is injectable for tests.
 */
export function warnIfPushoverUnconfigured(env: PushoverEnv = readEnv()): boolean {
  if (env.token && env.userKey) return true;
  console.warn(
    "[Pushover] startup: PUSHOVER_TOKEN / PUSHOVER_USER_KEY not set — stall/dialog paging is disabled (Issue #255)"
  );
  return false;
}

/**
 * Send a Pushover notification. Returns `true` only when the API accepted the
 * message (`status: 1`). Returns `false` when credentials are absent or the
 * request fails — both are logged, never thrown.
 *
 * `fetchImpl` and `env` are injectable for tests.
 */
export async function notifyPushover(
  title: string,
  message: string,
  opts?: {
    env?: PushoverEnv;
    fetchImpl?: typeof fetch;
  }
): Promise<boolean> {
  const env = opts?.env ?? readEnv();
  const fetchImpl = opts?.fetchImpl ?? fetch;

  if (!env.token || !env.userKey) {
    console.warn(
      "[Pushover] skipped: PUSHOVER_TOKEN / PUSHOVER_USER_KEY not set"
    );
    return false;
  }

  const body = new URLSearchParams({
    token: env.token,
    user: env.userKey,
    title,
    message,
  });

  try {
    const res = await fetchImpl(PUSHOVER_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[Pushover] API returned HTTP ${res.status}`);
      return false;
    }
    const json = (await res.json()) as { status?: number };
    if (json.status !== 1) {
      console.warn(`[Pushover] API status=${json.status} (expected 1)`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Pushover] notification failed: ${msg}`);
    return false;
  }
}
