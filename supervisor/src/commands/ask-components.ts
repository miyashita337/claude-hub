import { createHash } from "crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  evaluateAccess,
  type AccessDecision,
  type AccessQuery,
} from "../config/access-policy";
import { askWaitNotice } from "../session/relay-server";
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
 *
 * `CUSTOM_ID_LIMIT` is the exception: nothing truncates a customId, because a
 * truncated one would index the wrong option. The token keeps it far under 100
 * chars by construction, and ask-components.test.ts asserts the built ids stay
 * within the limit — verified, not clamped.
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
  /**
   * Issue #443: shared by every sub-question of one multi-question ask, so
   * they can be registered together without superseding each other (see
   * {@link AskPromptRegistry.register}) and so the click handler can find its
   * siblings ({@link AskPromptRegistry.groupOf}) to decide whether the whole
   * ask is answered yet. `undefined` for a solo (single-question) ask.
   */
  groupId?: string;
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
   * Register a posted prompt and return its token. Every earlier prompt for the
   * same thread that has NOT been answered is marked `superseded`: the relay
   * replaces an in-flight ask (relay-server resolves the displaced one with
   * 499), so a click on the older message would otherwise answer the NEW
   * question with the OLD option.
   *
   * The condition is `!== "answered"` rather than `=== "pending"` because
   * `hasPendingAsk` is per-THREAD while a token is per-MESSAGE: an `expired`
   * prompt left un-superseded still passes the state checks, and by the time it
   * is clicked the thread may have a *different* ask pending — which it would
   * then answer (#427 review must-2). The structural fix is to carry an ask id
   * through `hasPendingAsk` / `resolveAskUser`; that touches relay-server.ts,
   * which #416 is editing, so it is deferred there.
   *
   * `groupId` (Issue #443) opts a registration out of superseding its own
   * siblings: every sub-question of one multi-question ask is registered with
   * the SAME `groupId`, so posting Q2 does not immediately supersede Q1's
   * still-unanswered buttons. A prompt belonging to a DIFFERENT group (or no
   * group at all) is still superseded exactly as before — only a genuinely
   * new ask, solo or multi, replaces the whole thread's pending question(s).
   */
  register(input: {
    threadId: string;
    kind: Exclude<AskComponentKind, "text">;
    options: AskOption[];
    multiSelect: boolean;
    groupId?: string;
  }): string {
    for (const prompt of this.prompts.values()) {
      const sibling =
        input.groupId !== undefined && prompt.groupId === input.groupId;
      if (
        prompt.threadId === input.threadId &&
        prompt.state !== "answered" &&
        !sibling
      ) {
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
      groupId: input.groupId,
    });

    // Answered prompts are kept so a repeat click can be told "already
    // answered" rather than "expired". Bound the map anyway — the supervisor is
    // long-lived, and an evicted prompt degrades to the expired message, which
    // is accurate for one that old.
    //
    // Eviction is by insertion order and does NOT skip `pending` entries, so a
    // solo live question can age out of the registry once ~50 asks have been
    // posted since. That degrades safely: its buttons report "already
    // finished" and the text-reply path still resolves the ask. It is not a
    // correctness hole for a solo ask, but it WOULD be one for a multi-question
    // group (Issue #443 review should-2): `groupOf()` only sees survivors, so
    // evicting an unanswered sibling would let `allAnswered` in the click
    // handler go true — and resolveAskUser fire — without that sibling ever
    // being tapped. So a still-pending member of a multi-question group
    // (`groupId` set) is skipped over here; only a solo prompt or an
    // already-terminal (answered/superseded/expired) one is evicted. Bounded
    // scan: falls through to evicting the oldest entry outright if every
    // candidate in the map is a live group member, so the map can never grow
    // unbounded even in that pathological case.
    if (this.prompts.size > this.capacity) {
      // PR #444 review (CodeRabbit / Qodo): a group is "still open" as long as
      // ANY sibling is pending — not just the pending ones individually. The
      // original check only protected `state === "pending"` entries, so an
      // ALREADY-ANSWERED sibling of a group that has not fully resolved yet
      // was still evictable. Losing it would shrink `groupOf()`'s result,
      // shifting the `Q<n>:` ordinals of the remaining siblings AND silently
      // dropping that sibling's answer from the combined string sent back to
      // Claude once the group does finish. Protecting the whole group (not
      // just its pending members) closes that hole.
      const openGroups = new Set<string>();
      for (const p of this.prompts.values()) {
        if (p.groupId !== undefined && p.state === "pending") {
          openGroups.add(p.groupId);
        }
      }
      while (this.prompts.size > this.capacity) {
        let victim: string | undefined;
        for (const [tok, p] of this.prompts) {
          const liveGroupMember =
            p.groupId !== undefined && openGroups.has(p.groupId);
          if (!liveGroupMember) {
            victim = tok;
            break;
          }
        }
        this.prompts.delete(victim ?? this.prompts.keys().next().value!);
      }
    }
    return token;
  }

  get(token: string): AskPrompt | undefined {
    return this.prompts.get(token);
  }

  size(): number {
    return this.prompts.size;
  }

  /**
   * Every prompt sharing `token`'s `groupId`, including itself, in
   * registration order (Issue #443). A solo prompt (`groupId` undefined)
   * returns just itself — so callers can treat "is the whole ask answered
   * yet" the same way for a solo click and a multi-question one: check
   * whether every entry in the returned array is `answered`.
   */
  groupOf(token: string): AskPrompt[] {
    const prompt = this.prompts.get(token);
    if (!prompt) return [];
    if (prompt.groupId === undefined) return [prompt];
    const siblings: AskPrompt[] = [];
    for (const p of this.prompts.values()) {
      if (p.groupId === prompt.groupId) siblings.push(p);
    }
    return siblings;
  }

  /**
   * True while this thread has a still-live multi-question ask (2+ siblings,
   * none superseded/expired) registered. `bot.ts`'s plain-text reply path
   * uses this to refuse answering an entire batch of taps with one stray
   * message (#443 AC-3) while leaving single-question text answers untouched.
   */
  hasActiveMultiAsk(threadId: string): boolean {
    const counts = new Map<string, number>();
    const hasPending = new Set<string>();
    for (const p of this.prompts.values()) {
      if (p.threadId !== threadId) continue;
      if (p.state === "superseded" || p.state === "expired") continue;
      if (p.groupId === undefined) continue;
      counts.set(p.groupId, (counts.get(p.groupId) ?? 0) + 1);
      // PR #444 review (CodeRabbit / Qodo): a fully-answered group's entries
      // stay in the registry as `"answered"` — they are never re-superseded
      // (register()'s supersede loop deliberately skips `"answered"` prompts)
      // — so without this, a group that finished answering would still count
      // toward "active" here, and a LATER solo ask on the same thread would
      // be wrongly told "this is a multi-question ask, tap the buttons"
      // instead of accepting its plain-text reply. Only a group with at
      // least one still-`"pending"` member is genuinely awaiting taps.
      if (p.state === "pending") hasPending.add(p.groupId);
    }
    for (const [groupId, count] of counts) {
      if (count > 1 && hasPending.has(groupId)) return true;
    }
    return false;
  }
}

/** Registry used by the running bot. Tests build their own instance. */
export const askPrompts = new AskPromptRegistry();

/** Whether a component interaction belongs to this module. */
export function isAskComponentId(customId: string): boolean {
  return customId.startsWith(ASK_COMPONENT_PREFIX);
}

/**
 * Issue #443 AC-3: whether `threadId` currently has a live multi-question ask
 * (2+ tappable sub-questions, not yet fully answered). `bot.ts`'s
 * `messageCreate` handler checks this before letting a plain-text reply
 * resolve a pending ask — a stray message must not be read as the answer to
 * every question in the batch, only a tap on a specific question's row does
 * that. Delegates to {@link AskPromptRegistry.hasActiveMultiAsk}; the
 * `registry` param exists so tests can build an isolated instance instead of
 * the module singleton.
 */
export function hasActiveMultiAsk(
  threadId: string,
  registry: AskPromptRegistry = askPrompts
): boolean {
  return registry.hasActiveMultiAsk(threadId);
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
 *
 * MOSTLY DEAD PATH for a single-question ask (#427 review should-3): in
 * production `shouldUseButtons` still returns `true` for {@link buildAskPrompt}
 * every time, because a solo question carries at most 4 options (+ Other) and
 * hooks/ask-user-relay.sh still drops `multiSelect` when flattening ONE
 * question's options. The select branch there runs only under unit tests.
 *
 * REACHABLE for a multi-question ask (Issue #443): `hooks/ask-user-relay.sh`
 * forwards each sub-question's `multiSelect` flag and structured options in
 * `questions[]`, so {@link buildMultiAskPrompt} can and does hit the select
 * branch in production when a question asks for multiple selections.
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
  /**
   * Effective wait budget for this ask (`AskUserEvent.timeoutMs`, #416). Passed
   * through to the footer so the post states the real deadline. Omitted falls
   * back to the relay's current default — never to a hardcoded duration.
   */
  timeoutMs?: number;
}

export interface AskPromptMessage {
  content: string;
  components: AskComponentRow[];
  kind: AskComponentKind;
  /** Registry token; absent when the message carries no components. */
  token?: string;
  /**
   * Issue #443: one registry token per question, in question order — set
   * instead of `token` by {@link buildMultiAskPrompt}. `components` holds one
   * row per entry at the same index.
   */
  tokens?: string[];
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
 *
 * The over-limit branch shares the select path's reachability caveat — see
 * {@link shouldUseButtons}. Today AskUserQuestion never sends more than 5
 * options, so only the no-options and buttons branches run in production.
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
      content: joinContent(head, [], askFooter("text", input.timeoutMs)),
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
        `⚠️ 選択肢が ${rawOptions.length} 件あり Discord の上限（${MAX_SELECT_OPTIONS} 件）を超えるため、ボタン/メニューを表示できません。\n${askFooter("text", input.timeoutMs)}`
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
    content: joinContent(head, list, askFooter(kind, input.timeoutMs)),
    components: [
      kind === "buttons"
        ? buildButtonRow(token, options, false)
        : buildSelectRow(token, options, multiSelect, false),
    ],
    kind,
    token,
  };
}

/**
 * Minimal Discord channel surface `postAskUserPrompt` needs to deliver a post.
 * Deliberately narrower than discord.js's `Channel` union (which not every
 * member satisfies — only text-based / thread channels have `.send()`) so a
 * caller can pass an already-narrowed `ThreadChannel` (bot.ts, after its own
 * `isThread()` check) or a hermetic fake (tests) without a cast.
 */
export interface AskPostChannel {
  send(options: {
    content: string;
    components?: AskComponentRow[];
  }): Promise<unknown>;
}

/**
 * Build the AskUserQuestion post and actually deliver it (Issue #436 V-2).
 *
 * Split out from `buildAskPrompt` so "does this reach Discord in the right
 * shape" is answerable without a live bot token: tests can pass a fake
 * `AskPostChannel` and assert on the captured `send()` call. Previously
 * nothing fed `buildAskPrompt`'s output into an actual send in any test —
 * bot-wiring tests only checked that the handler was registered, never that
 * it produced a correct post. Kept side-effect-free otherwise: callers own
 * channel resolution (`client.channels.fetch` + `isThread()`) and error
 * handling, same as before this was extracted.
 */
export async function postAskUserPrompt(
  channel: AskPostChannel,
  input: AskPromptInput,
  registry: AskPromptRegistry = askPrompts
): Promise<AskPromptMessage> {
  const prompt = buildAskPrompt(input, registry);
  await channel.send({
    content: prompt.content,
    ...(prompt.components.length ? { components: prompt.components } : {}),
  });
  return prompt;
}

/** One sub-question of a multi-question ask, as `buildMultiAskPrompt` needs it. */
export interface AskSubQuestionInput {
  question: string;
  options?: string[];
  multiSelect?: boolean;
}

export interface MultiAskPromptInput {
  threadId: string;
  questions: AskSubQuestionInput[];
  /** Same meaning as {@link AskPromptInput.timeoutMs}. */
  timeoutMs?: number;
}

/** Discord's ActionRow-per-message ceiling (docs.discord.com/developers). */
export const MAX_ASK_QUESTIONS_PER_MESSAGE = 5;

/**
 * Build the thread post for a multi-question AskUserQuestion (Issue #443).
 *
 * Before this, `hooks/ask-user-relay.sh` flattened every question in
 * `questions[]` down to one joined text with no options the moment there was
 * more than one — `buildAskPrompt` then had nothing to build components from
 * and fell back to plain text, so the only way to answer was one free-text
 * reply for the whole batch (the #443 incident: an unrelated message got read
 * as the answer to every proposal at once).
 *
 * Each sub-question is registered as its OWN `AskPromptRegistry` entry — same
 * registration, same customId scheme (`buildButtonRow` / `buildSelectRow`,
 * unchanged), same click handling as a solo ask — so none of that machinery
 * needed to change. What is new is `groupId`: every sub-question of one batch
 * shares it, which (a) stops them superseding each other on registration (the
 * "one live ask per thread" rule in {@link AskPromptRegistry.register} would
 * otherwise disable Q1's buttons the instant Q2 registers) and (b) lets
 * {@link createAskComponentHandler} tell "wait for the rest of the group"
 * apart from "this alone is the whole answer" ({@link AskPromptRegistry.groupOf}).
 *
 * Falls back to the old flattened text-only post when any sub-question has no
 * options, there are zero questions, or there are more questions than Discord
 * allows rows for — a free-text sub inside a tap-to-answer batch is exactly
 * the ambiguous-mapping problem `ask-user-relay.sh`'s own comment calls out,
 * so it is not attempted; the whole batch degrades together, not
 * question-by-question.
 */
export function buildMultiAskPrompt(
  input: MultiAskPromptInput,
  registry: AskPromptRegistry = askPrompts
): AskPromptMessage {
  const { threadId, questions, timeoutMs } = input;
  const canUseComponents =
    questions.length > 0 &&
    questions.length <= MAX_ASK_QUESTIONS_PER_MESSAGE &&
    questions.every((q) => {
      const count = (q.options ?? []).length;
      return count > 0 && count <= MAX_SELECT_OPTIONS;
    });

  if (!canUseComponents) {
    if (questions.length > MAX_ASK_QUESTIONS_PER_MESSAGE) {
      console.warn(
        `[ask-components] ${questions.length} questions exceed the Discord ActionRow limit (${MAX_ASK_QUESTIONS_PER_MESSAGE}); posting without components (#443)`
      );
    }
    // Review finding (PR #444): a per-question option count over
    // MAX_SELECT_OPTIONS (25) would make buildSelectRow hand Discord a
    // StringSelectMenu with more entries than its hard API ceiling — the
    // send() call would fail outright, not degrade. Same whole-batch
    // text fallback as the zero-options case: a free-text sub inside a
    // tap-to-answer batch is the exact ambiguity buildAskPrompt's own
    // over-limit branch already avoids for a solo ask.
    if (questions.some((q) => (q.options ?? []).length > MAX_SELECT_OPTIONS)) {
      console.warn(
        `[ask-components] a question has more than ${MAX_SELECT_OPTIONS} options; posting the whole batch without components (#443)`
      );
    }
    const joined = questions.map((q) => q.question).join("\n");
    return {
      content: joinContent(
        [`❓ **Claude からの質問**`, joined],
        [],
        askFooter("text", timeoutMs)
      ),
      components: [],
      kind: "text",
    };
  }

  const groupId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tokens: string[] = [];
  const rows: AskComponentRow[] = [];
  const kinds: Exclude<AskComponentKind, "text">[] = [];
  const blocks: string[] = [];

  questions.forEach((q, i) => {
    const rawOptions = q.options ?? [];
    const multiSelect = q.multiSelect ?? false;
    const options = rawOptions.map(toAskOption);
    const kind = shouldUseButtons(options.length, multiSelect)
      ? "buttons"
      : "select";
    const token = registry.register({
      threadId,
      kind,
      options,
      multiSelect,
      groupId,
    });
    tokens.push(token);
    kinds.push(kind);
    rows.push(
      kind === "buttons"
        ? buildButtonRow(token, options, false)
        : buildSelectRow(token, options, multiSelect, false)
    );
    const list = rawOptions.map((option, j) => `${j + 1}. ${option}`);
    blocks.push([`**Q${i + 1}.** ${q.question}`, ...list].join("\n"));
  });

  const footer =
    "各質問のボタン/メニューからそれぞれ回答してください（すべてに回答すると再開します）。\n" +
    askWaitNotice(timeoutMs);
  const head = `❓ **Claude からの質問（${questions.length}件）**`;
  const body = [head, ...blocks].join("\n\n");
  const budget = CONTENT_LIMIT - footer.length - 2;
  const trimmedBody = body.length > budget ? truncate(body, budget) : body;

  return {
    content: `${trimmedBody}\n\n${footer}`,
    components: rows,
    // Best-effort summary: a batch can mix buttons and selects per question,
    // but AskPromptMessage.kind has no "mixed" value. "select" whenever at
    // least one row is one, since that is the row a caller most needs to know
    // about (it is the branch that is otherwise unreachable in production —
    // see shouldUseButtons).
    kind: kinds.includes("select") ? "select" : "buttons",
    tokens,
  };
}

/**
 * Build the multi-question post and deliver it (mirrors `postAskUserPrompt`,
 * #436 V-2's rationale: an E2E test can drive this exact call with a fake
 * channel and assert on what actually reaches `send()`).
 */
export async function postMultiAskUserPrompt(
  channel: AskPostChannel,
  input: MultiAskPromptInput,
  registry: AskPromptRegistry = askPrompts
): Promise<AskPromptMessage> {
  const prompt = buildMultiAskPrompt(input, registry);
  await channel.send({
    content: prompt.content,
    ...(prompt.components.length ? { components: prompt.components } : {}),
  });
  return prompt;
}

/**
 * Issue #447: one-line notice posted to the thread's PARENT channel when an
 * AskUserQuestion lands in the thread. The morning brief arrives in #corp
 * itself, but the decision question it triggers only renders inside the CEO
 * session's thread — unless the user happens to open that thread, a pending
 * decision is invisible. The question itself stays in the thread (answer
 * routing is per-thread: the #416 wait and the #423 no-auto-answer rule are
 * untouched); the parent channel gets a link, not a second copy of the
 * question (#447 rejected posting the question body to the channel because a
 * channel-level reply cannot be attributed to a specific ask).
 *
 * `<#id>` is Discord's channel mention and resolves for threads too — one tap
 * opens the thread holding the question. Not corp-specific: like the brief
 * trigger (corp-brief.ts), #corp is merely the first user; the notice works
 * for any thread whose parent channel resolves.
 */
export function buildAskChannelNotice(
  threadId: string,
  questionCount: number,
): string {
  return `📥 決裁待ち ${questionCount} 件 → <#${threadId}>`;
}

/**
 * Deliver the parent-channel notice (mirrors `postAskUserPrompt`, #436 V-2's
 * rationale: build + send in one call so a test can assert on what actually
 * reaches `send()` with a fake channel). Callers own parent resolution and
 * error handling — the notice is best-effort and must never fail the ask post
 * that precedes it (bot.ts wraps this call in its own try/catch), and it must
 * only be sent AFTER the question landed in the thread (a failed question post
 * with a live "決裁待ち" notice would link to nothing).
 */
export async function postAskChannelNotice(
  parent: AskPostChannel,
  input: { threadId: string; questionCount: number },
): Promise<void> {
  await parent.send({
    content: buildAskChannelNotice(input.threadId, input.questionCount),
  });
}

/**
 * Closing lines of the post: how to answer, then the relay's own wait notice.
 *
 * `askWaitNotice` (relay-server.ts, #416) already says both "a text reply in
 * this thread is the answer" and how long the relay will wait, plus the #423
 * line that no option is auto-selected once it falls back to the TUI. Those
 * belong to the server that owns the timeout — restating any of it here is how
 * the old hardcoded "約 5 分" survived two changes to the real value. So the
 * component kinds only prepend the tap instruction and reuse the notice
 * verbatim; the text kind is the notice alone.
 */
function askFooter(kind: AskComponentKind, timeoutMs?: number): string {
  const notice = askWaitNotice(timeoutMs);
  if (kind === "buttons") {
    return `下のボタンをタップして回答してください。\n${notice}`;
  }
  if (kind === "select") {
    return `下のメニューから選択して回答してください。\n${notice}`;
  }
  return notice;
}

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

/**
 * Rebuild a prompt's row, enabled or disabled. Used both for the
 * single-answered-row case (disabled) and, for a multi-question ask (#443),
 * to rebuild every sibling row on each click — the still-pending ones stay
 * enabled, the just-answered one (and any answered earlier) come back
 * disabled, so `interaction.update()` can replace the whole `components` list
 * at once (Discord has no partial-row patch).
 */
function buildRowForPrompt(prompt: AskPrompt, disabled: boolean): AskComponentRow {
  return prompt.kind === "buttons"
    ? buildButtonRow(prompt.token, prompt.options, disabled)
    : buildSelectRow(prompt.token, prompt.options, prompt.multiSelect, disabled);
}

/** Rebuild the row in its disabled form (answer recorded, no further clicks). */
function buildDisabledRow(prompt: AskPrompt): AskComponentRow {
  return buildRowForPrompt(prompt, true);
}

/**
 * Best-effort: stop a stale message from inviting more clicks. Failure is
 * logged, never swallowed — the ephemeral reply has already told the user what
 * happened, so a failed edit degrades the UI, not the answer path.
 */
async function disableStaleMessage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  prompt: AskPrompt,
  registry: AskPromptRegistry
): Promise<void> {
  try {
    // Issue #443 review must-1: rebuild EVERY sibling row, not just the one
    // clicked. `.edit({components})` replaces the whole array — for a
    // multi-question ask the message carries N rows, and every call site here
    // means the whole ask is dead (expired / superseded / no longer pending),
    // so all siblings go disabled together, not just the row that was tapped.
    // A solo ask's group is just itself, so this is unchanged there.
    const group = registry.groupOf(prompt.token);
    await interaction.message?.edit({
      components: group.map((p) => buildRowForPrompt(p, true)),
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
  /**
   * access.json gate. Defaults to the live policy evaluation — the same
   * function messageCreate uses before relaying a thread message
   * (`bot.ts` の evaluateAccess 呼び出し). Injectable so tests exercise
   * allow/deny without a policy file on disk.
   */
  checkAccess?: (query: AccessQuery) => AccessDecision;
}

/**
 * Short, non-reversible id for "who clicked", for the decision audit line.
 *
 * The house rule for these logs is that they carry no raw snowflakes
 * (access-policy.ts の reason enum 方針と同じ). A raw `interaction.user.id`
 * would break that, but "which of the allowed users answered" is exactly what a
 * decision trail needs — so the id is hashed. The same person hashes to the same
 * value across lines, and the value cannot be pasted back into an API call.
 */
function actorTag(userId: string): string {
  if (!userId) return "unknown";
  return createHash("sha256").update(userId).digest("hex").slice(0, 8);
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
  const checkAccess = deps.checkAccess ?? ((query) => evaluateAccess(query));

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

    // Authorize the CLICKER before anything else about the question is
    // disclosed or decided (#427 review must-1). A tap and a text reply produce
    // the SAME thing — the 会長's answer — so they must pass the same gate;
    // messageCreate runs evaluateAccess on `parentId ?? threadId` before
    // relaying, and this is that path's twin. Without it, anyone who can see the
    // thread could commit a decision as the owner, which is the same class of
    // failure (an answer the owner never gave) this whole feature was built to
    // fix.
    //
    // `isMention: true` is deliberate, not a bypass: `requireMention` exists so
    // the bot ignores channel chatter not addressed to it, and a component
    // click IS addressed to it — Discord routes the interaction to the app that
    // sent the message, by customId. With every group defaulting to
    // requireMention:true, passing false here would deny every tap and leave the
    // feature dead. The gate that matters for a click is `allowFrom`.
    {
      const channel = interaction.channel;
      const parentChannelId =
        (channel?.isThread() ? channel.parentId : null) ?? prompt.threadId;
      const userId = interaction.user?.id ?? "";
      const decision = userId
        ? checkAccess({
            channelKey: parentChannelId,
            userId,
            isMention: true,
          })
        : ({
            allowed: false,
            reason: "sender_not_allowlisted",
          } satisfies AccessDecision);
      if (!decision.allowed) {
        // Same shape as the messageCreate denial log: coarse reason enum, no
        // user snowflake, no message body.
        console.warn(
          `[ask-components] tap denied (reason=${decision.reason}) on thread ${prompt.threadId}; not answered`
        );
        await safeRespond(interaction, {
          content:
            "🚫 この質問に回答する権限がありません（このスレッドの許可リストに登録されたユーザーのみ回答できます）。",
          ephemeral: true,
        });
        return;
      }
    }

    if (prompt.state === "answered") {
      await safeRespond(interaction, {
        content: `ℹ️ この質問は回答済みです（選択: ${prompt.answer ?? "—"}）。`,
        ephemeral: true,
      });
      return;
    }
    if (prompt.state === "expired") {
      // Terminal, like `answered`: an ask never becomes pending again once the
      // relay gave up on it. Re-deciding from `hasPendingAsk` below would read
      // the state of whatever ask is pending NOW, which is a different question
      // (#427 review must-2).
      await safeRespond(interaction, {
        content:
          "⌛ この質問は回答期限が切れています（セッションは TUI ダイアログに戻っています）。",
        ephemeral: true,
      });
      await disableStaleMessage(interaction, prompt, registry);
      return;
    }
    if (prompt.state === "superseded") {
      await safeRespond(interaction, {
        content:
          "ℹ️ この質問は新しい質問に置き換えられています。最新のメッセージから回答してください。",
        ephemeral: true,
      });
      await disableStaleMessage(interaction, prompt, registry);
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
      await disableStaleMessage(interaction, prompt, registry);
      return;
    }

    // Mark and resolve synchronously — no await in between — so a double click
    // (or a button and a select racing) cannot resolve the same ask twice.
    //
    // Multi-select answers are joined with ", ". UNVERIFIED: whether the native
    // AskUserQuestion dialog returns multiple labels as one comma-joined string,
    // an array, or newline-separated is not confirmed against the tool's
    // contract. It does not bite today (the select path is unreachable in
    // production — see shouldUseButtons), but confirm the shape when the hook
    // starts forwarding multiSelect.
    const answer = chosen.map((option) => option.answer).join(", ");
    prompt.state = "answered";
    prompt.answer = answer;

    // Issue #443: a multi-question ask registers each sub-question as its own
    // prompt sharing one groupId. `group` is every sibling (a solo ask's group
    // is just itself, so this whole block behaves exactly as it did before
    // #443 for a solo ask — see AskPromptRegistry.groupOf). resolveAskUser
    // fires the ONE underlying /ask response, so it must fire once, only once
    // ALL siblings are answered — resolving on the first tap would hand Claude
    // an answer for questions nobody tapped yet.
    const group = registry.groupOf(prompt.token);
    const ordinal = group.indexOf(prompt) + 1;
    const allAnswered = group.every((p) => p.state === "answered");
    if (allAnswered) {
      const combinedAnswer =
        group.length > 1
          ? group.map((p, i) => `Q${i + 1}: ${p.answer ?? ""}`).join("\n")
          : answer;
      deps.resolveAskUser(prompt.threadId, combinedAnswer);
    }

    // The decision trail (#427 review should-1). This is the 会長's input point:
    // when someone later says "I tapped it and nothing happened", this line is
    // the only evidence that the tap existed and what it chose. Actor is hashed
    // (see actorTag) so the trail carries no snowflake.
    console.log(
      `[ask-components] answered thread ${prompt.threadId} (token ${parsed.token}, actor ${actorTag(interaction.user?.id ?? "")}, kind ${prompt.kind}): ${answer}`
    );

    const base = interaction.message?.content ?? "";
    const chosenLine = truncate(
      group.length > 1 ? `✅ Q${ordinal} 選択: ${answer}` : `✅ 選択: ${answer}`,
      CONTENT_LIMIT
    );
    // Trim the QUESTION, never the choice (#427 review should-4). Appending and
    // truncating the whole thing drops the tail first, which is exactly the line
    // that records what was decided.
    const baseBudget = CONTENT_LIMIT - chosenLine.length - 2;
    const trimmedBase =
      baseBudget > 0 ? truncate(base, baseBudget) : "";
    const content = trimmedBase ? `${trimmedBase}\n\n${chosenLine}` : chosenLine;
    try {
      await interaction.update({
        content,
        // Rebuild every sibling row (not just this one) — a multi-question ask
        // posts them all in ONE message, and Discord has no way to patch a
        // single ActionRow without resending the rest. Still-pending siblings
        // stay tappable; this is a no-op array-of-one for a solo ask.
        components: group.map((p) => buildRowForPrompt(p, p.state === "answered")),
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
