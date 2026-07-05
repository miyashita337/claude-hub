import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Resolve the shared HMAC secret for one-tap action tokens (Issue #305).
 *
 * Resolution order (spec §5 / task): the `PUSHOVER_ACTION_HMAC_KEY` env first,
 * then the macOS Keychain. Two Keychain service names are tried so a key stored
 * per EITHER side's documentation is found: `PUSHOVER_ACTION_HMAC_KEY` (this
 * receiver's setup instruction) and `pushover-action-hmac-key` (agent-base's
 * `action-token.sh` header — `security add-generic-password -s
 * pushover-action-hmac-key`). The VALUE must be identical on both machines; the
 * service NAME only affects where each side reads it.
 *
 * Returns null when no source has the key — the caller disables the receiver
 * with a WARN rather than starting with a broken verifier (not a silent skip).
 */
export const HMAC_KEY_ENV = "PUSHOVER_ACTION_HMAC_KEY";
export const HMAC_KEY_KEYCHAIN_SERVICES = [
  "PUSHOVER_ACTION_HMAC_KEY",
  "pushover-action-hmac-key",
] as const;

export interface KeyResolveDeps {
  env?: NodeJS.ProcessEnv;
  /** Keychain lookup by service name; returns the secret or null. Injectable for tests. */
  keychainLookup?: (service: string) => Promise<string | null>;
}

export async function resolveHmacKey(deps: KeyResolveDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const fromEnv = env[HMAC_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;

  const lookup = deps.keychainLookup ?? securityKeychainLookup;
  for (const service of HMAC_KEY_KEYCHAIN_SERVICES) {
    const val = await lookup(service);
    if (val && val.trim()) return val.trim();
  }
  return null;
}

/**
 * macOS Keychain lookup via `security find-generic-password -s <service> -w`.
 * Returns null on any failure (not on macOS, service absent, `security`
 * missing) so resolution falls through to the next source. argv (no shell) so
 * the service name cannot inject metacharacters.
 */
async function securityKeychainLookup(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: 3000 }
    );
    const val = stdout.toString().replace(/\n$/, "");
    return val || null;
  } catch {
    return null;
  }
}
