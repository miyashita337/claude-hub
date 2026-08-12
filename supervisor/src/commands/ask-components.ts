import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { safeRespond } from "./safe-respond";

/**
 * Tap-to-answer components for AskUserQuestion (Issue #412).
 *
 * #370 made an AskUserQuestion reach the Discord thread as *text*, but the only
 * way to answer it is to type the choice back. On mobile that is slow and easy
 * to get wrong (the options are numbered in one message and typed in another).
 *
 * Layout is HYBRID and decided deterministically by {@link shouldUseButtons}:
 * buttons when the question fits one row and takes a single answer, a String
 * Select otherwise. Buttons are one tap — the common case (AskUserQuestion
 * carries at most a handful of options) — while the select covers the sizes and
 * the multi-select shape a button row cannot express. The alternative (picking
 * one UI) would have needed a migration the moment the other case showed up;
 * this branch is one boolean and covers both.
 *
 * Text replies keep working unchanged: the components are an added path, and
 * `hasPendingAsk` → `resolveAskUser` in messageCreate is untouched.
 *
 * Like the compact button (#364), a component interaction is routed by
 * `customId` back to the app that sent the message, so this stays entirely
 * inside claude-hub — no inbound endpoint is added anywhere else.
 */

/**
 * customId namespace. Buttons carry the option index (`ask:<token>:<index>`);
 * a select carries only the token (`ask:<token>`) because the chosen indices
 * arrive in `interaction.values`.
 */
export const ASK_COMPONENT_PREFIX = "ask:";

/**
 * Discord API limits (docs.discord.com/developers — Message Components).
 * Encoded as named constants so the truncation sites read as "the API says so"
 * rather than as magic numbers.
 */
export const CUSTOM_ID_LIMIT = 100;
/** Max buttons in one ActionRow. Also the button/select branch threshold. */
export const MAX_BUTTON_OPTIONS = 5;
/** Max options in a String Select. Hard ceiling — we never truncate past it. */
export const MAX_SELECT_OPTIONS = 25;
export const BUTTON_LABEL_LIMIT = 80;
export const SELECT_LABEL_LIMIT = 100;
export const SELECT_DESCRIPTION_LIMIT = 100;
export const PLACEHOLDER_LIMIT = 150;

/** Discord's per-message content ceiling is 2000; keep the post clear of it. */
const CONTENT_LIMIT = 1900;

/**
 * Separator `hooks/ask-user-relay.sh` uses to flatten an option to a single
 * string (`label — description`). AskUserEvent carries only those strings, so
 * splitting on the first occurrence is how we recover the label to answer with.
 * ask-components.test.ts locks this against the hook so the pair cannot drift.
 */
export const OPTION_SEPARATOR = " — ";

export type AskComponentKind = "buttons" | "select" | "text";

/**
 * One row holding either kind. Typed as a single ActionRowBuilder over the
 * union (rather than a union of rows) so the message payloads stay assignable
 * to discord.js's `components` without a cast.
 */
export type AskComponentRow = ActionRowBuilder<
  ButtonBuilder | StringSelectMenuBuilder
>;

interface AskOption {
  /** The option exactly as the hook sent it. */
  raw: string;
  /** Non-empty display text for the button/select entry. */
  display: string;
  /** Second half of `label — description`, when present. */
  description?: string;
  /** What we hand back to Claude when this option is chosen. */
  answer: string;
}

/**
 * `pending` → a click answers. `answered` / `superseded` / `expired` → a click
 * is reported to the user instead (never silently ignored, never a second
 * `resolveAskUser`).
 */
export type AskPromptState = "pending" | "answered" | "superseded" | "expired";

interface AskPrompt {
  token: string;
  threadId: string;
  kind: Exclude<AskComponentKind, "text">;
  options: AskOption[];
  multiSelect: boolean;
  state: AskPromptState;
  /** The answer sent to Claude, once answered through a component. */
  answer?: string;
}

/**
 * Per-process registry of posted prompts. It exists because the components
 * cannot carry the answer themselves: a button label is capped at 80 chars and
 * a select value at 100, so a long option would come back truncated and Claude
 * would receive a mangled answer. The token in the customId indexes the full
 * text here instead.
 *
 * A class (rather than module state) so tests get their own instance and cannot
 * leak prompts into each other.
 */
export class AskPromptRegistry {
  private readonly prompts = new Map<string, AskPrompt>();
  private seq = 0;
  /**
   * Random per-process prefix. Tokens must not repeat across supervisor
   * restarts: an old message's button would otherwise index a *different*
   * prompt registered after the restart and answer the wrong question.
   */
  private readonly runId = Math.random().toString(36).slice(2, 6);

  constructor(private readonly capacity = 50) {}

  /**
   * Register a posted prompt and return its token. Any earlier prompt for the
   * same thread is marked `superseded`: the relay replaces an in-flight ask
   * (relay-server resolves the displaced one with 499), so a click on the older
   * message would otherwise answer the NEW question with the OLD option.
   */
  register(input: {
    threadId: string;
    kind: Exclude<AskComponentKind, "text">;
    options: AskOption[];
    multiSelect: boolean;
  }): string {
    for (const prompt of this.prompts.values()) {
      if (prompt.threadId === input.threadId && prompt.state === "pending") {
        prompt.state = "superseded";
      }
    }

    const token = `${this.runId}${++this.seq}`;
    this.prompts.set(token, {
      token,
      threadId: input.threadId,
      kind: input.kind,
      options: input.options,
      multiSelect: input.multiSelect,
      state: "pending",
    });

    // Answered prompts are kept so a repeat click can be told "already
    // answered" rather than "expired". Bound the map anyway — the supervisor is
    // long-lived, and an evicted prompt degrades to the expired message, which
    // is accurate for one that old.
    while (this.prompts.size > this.capacity) {
      const oldest = this.prompts.keys().next().value;
      if (oldest === undefined) break;
      this.prompts.delete(oldest);
    }
    return token;
  }

  get(token: string): AskPrompt | undefined {
    return this.prompts.get(token);
  }

  size(): number {
    return this.prompts.size;
  }
}

/** Registry used by the running bot. Tests build their own instance. */
export const askPrompts = new AskPromptRegistry();

/** Whether a component interaction belongs to this module. */
export function isAskComponentId(customId: string): boolean {
  return customId.startsWith(ASK_COMPONENT_PREFIX);
}

export function parseAskCustomId(
  customId: string
): { token: string; index?: number } | null {
  if (!isAskComponentId(customId)) return null;
  const parts = customId.slice(ASK_COMPONENT_PREFIX.length).split(":");
  const token = parts[0];
  if (!token) return null;
  if (parts.length === 1) return { token };
  if (parts.length !== 2) return null;
  const index = Number(parts[1]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { token, index };
}

/**
 * The hybrid branch. Deterministic on purpose (#412): no heuristic, no
 * inspection of the option text — the two inputs fully decide the layout.
 * Buttons only when every option fits one ActionRow AND a single answer is
 * wanted; a select otherwise.
 */
export function shouldUseButtons(
  optionCount: number,
  multiSelect: boolean
): boolean {
  return optionCount <= MAX_BUTTON_OPTIONS && !multiSelect;
}

/** Recover `label` / `description` from the hook's flattened option string. */
export function splitOption(raw: string): {
  label: string;
  description?: string;
} {
  const idx = raw.indexOf(OPTION_SEPARATOR);
  if (idx < 0) return { label: raw.trim() };
  const label = raw.slice(0, idx).trim();
  const description = raw.slice(idx + OPTION_SEPARATOR.length).trim();
  return { label, ...(description ? { description } : {}) };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function toAskOption(raw: string, index: number): AskOption {
  const { label, description } = splitOption(raw);
  // Discord rejects an empty label, so a malformed option (no text before the
  // separator) falls back to its description and then to a positional name —
  // it stays clickable instead of failing the whole post.
  const display = label || description || `選択肢 ${index + 1}`;
  // Answer with the label: that is what AskUserQuestion's own dialog returns.
  // With no label we send the raw option text — complete-but-verbose beats
  // empty.
  const answer = label || raw.trim() || display;
  return { raw, display, ...(description ? { description } : {}), answer };
}

function buildButtonRow(
  token: string,
  options: AskOption[],
  disabled: boolean
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...options.map((option, index) =>
      new ButtonBuilder()
        .setCustomId(`${ASK_COMPONENT_PREFIX}${token}:${index}`)
        .setLabel(truncate(option.display, BUTTON_LABEL_LIMIT))
        .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled)
    )
  );
}

function buildSelectRow(
  token: string,
  options: AskOption[],
  multiSelect: boolean,
  disabled: boolean
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${ASK_COMPONENT_PREFIX}${token}`)
    .setPlaceholder(
      truncate(
        multiSelect ? "回答を選択（複数可）" : "回答を選択",
        PLACEHOLDER_LIMIT
      )
    )
    .setMinValues(1)
    .setMaxValues(multiSelect ? options.length : 1)
    .setDisabled(disabled)
    .addOptions(
      options.map((option, index) => ({
        label: truncate(option.display, SELECT_LABEL_LIMIT),
        // The index is the value: an option's own text can exceed the 100-char
        // value limit, and the registry holds the full text anyway.
        value: String(index),
        ...(option.description
          ? {
              description: truncate(
                option.description,
                SELECT_DESCRIPTION_LIMIT
              ),
            }
          : {}),
      }))
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export interface AskPromptInput {
  threadId: string;
  question: string;
  options?: string[];
  multiSelect?: boolean;
}

export interface AskPromptMessage {
  content: string;
  components: AskComponentRow[];
  kind: AskComponentKind;
  /** Registry token; absent when the message carries no components. */
  token?: string;
}

/**
 * Build the thread post for one AskUserQuestion, registering it so clicks can
 * be resolved. Registration is part of building because the customIds embed the
 * token — a caller cannot have one without the other.
 *
 * `kind: "text"` (no components) happens when the hook forwarded no options
 * (multi-question asks flatten to a bare question) or when there are more
 * options than a select can hold. The over-limit case is stated in the message
 * and logged rather than truncated: dropping choices silently would let the
 * user answer a question they were never shown all of.
 */
export function buildAskPrompt(
  input: AskPromptInput,
  registry: AskPromptRegistry = askPrompts
): AskPromptMessage {
  const rawOptions = input.options ?? [];
  const multiSelect = input.multiSelect ?? false;
  const head = [`❓ **Claude からの質問**`, input.question];
  const list = rawOptions.map((option, i) => `${i + 1}. ${option}`);

  if (rawOptions.length === 0) {
    return {
      content: joinContent(head, [], TEXT_FOOTER),
      components: [],
      kind: "text",
    };
  }

  if (rawOptions.length > MAX_SELECT_OPTIONS) {
    console.warn(
      `[ask-components] ${rawOptions.length} options exceed the Discord select limit (${MAX_SELECT_OPTIONS}); posting without components (#412)`
    );
    return {
      content: joinContent(
        head,
        list,
        `⚠️ 選択肢が ${rawOptions.length} 件あり Discord の上限（${MAX_SELECT_OPTIONS} 件）を超えるため、ボタン/メニューを表示できません。\n${TEXT_FOOTER}`
      ),
      components: [],
      kind: "text",
    };
  }

  const options = rawOptions.map(toAskOption);
  const kind = shouldUseButtons(options.length, multiSelect)
    ? "buttons"
    : "select";
  const token = registry.register({
    threadId: input.threadId,
    kind,
    options,
    multiSelect,
  });

  return {
    content: joinContent(
      head,
      list,
      kind === "buttons" ? BUTTON_FOOTER : SELECT_FOOTER
    ),
    components: [
      kind === "buttons"
        ? buildButtonRow(token, options, false)
        : buildSelectRow(token, options, multiSelect, false),
    ],
    kind,
    token,
  };
}

// The relay owns the ask timeout (relay-server.ts DEFAULT_ASK_TIMEOUT_MS) and
// #416 is changing it. Naming a duration here would go stale silently, so the
// footers state the consequence without the number.
const TEXT_FOOTER =
  "このスレッドへの次の返信がそのまま回答として送られます（タイムアウトすると TUI ダイアログに戻ります）。";
const BUTTON_FOOTER =
  "下のボタンをタップして回答してください（このスレッドへの返信でも回答できます）。";
const SELECT_FOOTER =
  "下のメニューから選択して回答してください（このスレッドへの返信でも回答できます）。";

/**
 * Assemble the post under Discord's content ceiling. Only the option list is
 * trimmed — the footer tells the user how to answer, so losing it to a long
 * list would leave a question with no visible way forward.
 */
function joinContent(
  head: string[],
  list: string[],
  footer: string
): string {
  const body = [...head, ...(list.length ? ["", ...list] : [])].join("\n");
  const budget = CONTENT_LIMIT - footer.length - 2;
  const trimmedBody = body.length > budget ? truncate(body, budget) : body;
  return `${trimmedBody}\n\n${footer}`;
}

/** Rebuild the row in its disabled form (answer recorded, no further clicks). */
function buildDisabledRow(prompt: AskPrompt): AskComponentRow {
  return prompt.kind === "buttons"
    ? buildButtonRow(prompt.token, prompt.options, true)
    : buildSelectRow(prompt.token, prompt.options, prompt.multiSelect, true);
}

/**
 * Best-effort: stop a stale message from inviting more clicks. Failure is
 * logged, never swallowed — the ephemeral reply has already told the user what
 * happened, so a failed edit degrades the UI, not the answer path.
 */
async function disableStaleMessage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  prompt: AskPrompt
): Promise<void> {
  try {
    await interaction.message?.edit({
      components: [buildDisabledRow(prompt)],
    });
  } catch (err) {
    console.warn(
      `[ask-components] failed to disable stale components on thread ${prompt.threadId}:`,
      err
    );
  }
}

export interface AskComponentHandlerDeps {
  /** relay-server: is an /ask request still waiting on this thread? */
  hasPendingAsk: (threadId: string) => boolean;
  /** relay-server: hand the answer back to the blocked hook. */
  resolveAskUser: (threadId: string, answer: string) => void;
  registry?: AskPromptRegistry;
}

/**
 * Interaction handler for both component kinds. Mirrors compact-button.ts: the
 * bot's dispatcher does the customId check and this owns everything after it.
 *
 * Every non-answer path replies ephemerally. A click that does nothing and says
 * nothing is the failure mode this whole feature exists to remove — the user
 * would sit waiting on a question that is already gone.
 */
export function createAskComponentHandler(deps: AskComponentHandlerDeps) {
  const registry = deps.registry ?? askPrompts;

  return async (
    interaction: ButtonInteraction | StringSelectMenuInteraction
  ): Promise<void> => {
    const parsed = parseAskCustomId(interaction.customId);
    if (!parsed) {
      await safeRespond(interaction, {
        content: "ℹ️ この操作は認識できませんでした。",
        ephemeral: true,
      });
      return;
    }

    const prompt = registry.get(parsed.token);
    if (!prompt) {
      // Registry miss: supervisor restarted, or the prompt aged out. Either way
      // the ask it belonged to is long gone.
      console.log(
        `[ask-components] click on unknown prompt token ${parsed.token} (restarted or evicted)`
      );
      await safeRespond(interaction, {
        content:
          "⌛ この質問は既に終了しています（supervisor 再起動、または古い質問です）。",
        ephemeral: true,
      });
      return;
    }

    if (
      interaction.channelId &&
      interaction.channelId !== prompt.threadId
    ) {
      // Defensive: a component can only be clicked where it was posted, so this
      // means the token is not the one we think it is.
      console.warn(
        `[ask-components] token ${parsed.token} clicked outside its thread; ignoring`
      );
      await safeRespond(interaction, {
        content: "ℹ️ この質問はこのスレッドのものではありません。",
        ephemeral: true,
      });
      return;
    }

    if (prompt.state === "answered") {
      await safeRespond(interaction, {
        content: `ℹ️ この質問は回答済みです（選択: ${prompt.answer ?? "—"}）。`,
        ephemeral: true,
      });
      return;
    }
    if (prompt.state === "superseded") {
      await safeRespond(interaction, {
        content:
          "ℹ️ この質問は新しい質問に置き換えられています。最新のメッセージから回答してください。",
        ephemeral: true,
      });
      await disableStaleMessage(interaction, prompt);
      return;
    }

    const indices = interaction.isStringSelectMenu()
      ? interaction.values.map((value) => Number(value))
      : parsed.index === undefined
        ? []
        : [parsed.index];
    const chosen = indices
      .filter((i) => Number.isInteger(i) && i >= 0 && i < prompt.options.length)
      .map((i) => prompt.options[i]!);
    if (chosen.length === 0 || chosen.length !== indices.length) {
      console.warn(
        `[ask-components] unresolvable selection on token ${parsed.token}: ${JSON.stringify(indices)}`
      );
      await safeRespond(interaction, {
        content: "⚠️ 選択内容を解釈できませんでした。もう一度お試しください。",
        ephemeral: true,
      });
      return;
    }

    if (!deps.hasPendingAsk(prompt.threadId)) {
      // The relay gave up waiting (timeout) — the session already fell back to
      // its TUI dialog, so an answer now would go nowhere.
      prompt.state = "expired";
      console.log(
        `[ask-components] expired click on thread ${prompt.threadId} (token ${parsed.token}); no pending ask`
      );
      await safeRespond(interaction, {
        content:
          "⌛ この質問は回答期限が切れています（セッションは TUI ダイアログに戻っています）。",
        ephemeral: true,
      });
      await disableStaleMessage(interaction, prompt);
      return;
    }

    // Mark and resolve synchronously — no await in between — so a double click
    // (or a button and a select racing) cannot resolve the same ask twice.
    const answer = chosen.map((option) => option.answer).join(", ");
    prompt.state = "answered";
    prompt.answer = answer;
    deps.resolveAskUser(prompt.threadId, answer);

    const base = interaction.message?.content ?? "";
    const chosenLine = `✅ 選択: ${answer}`;
    const content = truncate(
      base ? `${base}\n\n${chosenLine}` : chosenLine,
      CONTENT_LIMIT
    );
    try {
      await interaction.update({
        content,
        components: [buildDisabledRow(prompt)],
      });
    } catch (err) {
      // The answer is already delivered; only the message update failed. Log it
      // rather than reporting a failure the user cannot act on.
      console.warn(
        `[ask-components] answer delivered but message update failed on thread ${prompt.threadId}:`,
        err
      );
    }
  };
}
