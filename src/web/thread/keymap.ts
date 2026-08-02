/**
 * The keyboard command table, and the help overlay generated from it.
 *
 * One entry per binding: the key sequence that triggers it, the command it
 * runs, and where it shows up in the help overlay. The overlay used to be a
 * second, hand-maintained copy of this list — the two drifted apart every time
 * a binding changed, so the rows below are derived instead.
 *
 * Prefix keys (`g`, `z`, `y`) are not entries of their own: a key is a prefix
 * exactly when some binding starts with it, which is what makes an orphaned
 * prefix impossible to write down.
 */

/**
 * What a binding does. The reducer switches on these, so adding one is a type
 * error until it is handled (see keys.ts).
 */
export type CommandId =
  | "cursor-next"
  | "cursor-prev"
  | "cursor-parent"
  | "cursor-child"
  | "cursor-sibling-prev"
  | "cursor-sibling-next"
  | "cursor-first"
  | "cursor-last"
  | "unread-next"
  | "unread-prev"
  | "mark-read"
  | "mark-unread"
  | "fold-toggle"
  | "fold-open"
  | "fold-close"
  | "fold-open-subtree"
  | "fold-close-subtree"
  | "fold-open-all"
  | "fold-close-all"
  | "center-cursor"
  | "open-on-x"
  | "copy-x-link"
  | "copy-app-link"
  | "help-toggle"
  | "help-close";

/** A binding's trigger: a single key, or a prefix key then a second key. */
export type KeySeq = readonly [string] | readonly [string, string];

/**
 * A help overlay row. Rows group the bindings that describe one idea, so
 * `desc` reads as a whole ("next / previous post") rather than per key.
 * Members are joined with `sep`; a row with two clusters (letters and arrows
 * for the same motions) separates them with a comma.
 */
interface HelpRowSpec {
  readonly id: string;
  readonly desc: string;
  /** Between members of one cluster. Defaults to " / ". */
  readonly sep?: string;
}

const HELP_ROWS = [
  { id: "cursor-line", desc: "next / previous post" },
  { id: "cursor-tree", desc: "parent / first reply" },
  { id: "cursor-sibling", desc: "previous / next sibling branch" },
  { id: "unread", desc: "next / previous unread (marks read)" },
  { id: "read", desc: "mark read (fold-scoped) / mark unread + subtree" },
  { id: "fold-one", desc: "toggle / open / close fold", sep: "  " },
  { id: "fold-subtree", desc: "open / close subtree recursively" },
  { id: "fold-all", desc: "open / close all folds" },
  { id: "fold-enter", desc: "toggle fold" },
  { id: "ends", desc: "first / last post" },
  { id: "center", desc: "center current post" },
  { id: "open-x", desc: "open post on x.com" },
  { id: "copy", desc: "copy x.com link / app deep link" },
  { id: "help", desc: "toggle this help" },
] as const satisfies readonly HelpRowSpec[];

export type HelpRowId = (typeof HELP_ROWS)[number]["id"];

interface HelpPlacement {
  readonly row: HelpRowId;
  /** How the key is written in the overlay ("↓" for ArrowDown). */
  readonly label: string;
  /**
   * Which cluster of the row this label joins. Clusters are separated by a
   * comma, so "j / k, ↓ / ↑" is one row of two clusters.
   */
  readonly cluster?: number;
}

export interface Binding {
  readonly seq: KeySeq;
  readonly command: CommandId;
  /** Omitted for bindings the overlay doesn't advertise (Escape). */
  readonly help?: HelpPlacement;
}

/**
 * Order matters twice: labels appear in a help row in table order, and a
 * binding listed twice would shadow itself (asserted in the tests).
 */
export const KEYMAP: readonly Binding[] = [
  // Motion.
  { seq: ["j"], command: "cursor-next", help: { row: "cursor-line", label: "j" } },
  { seq: ["ArrowDown"], command: "cursor-next", help: { row: "cursor-line", label: "↓", cluster: 1 } },
  { seq: ["k"], command: "cursor-prev", help: { row: "cursor-line", label: "k" } },
  { seq: ["ArrowUp"], command: "cursor-prev", help: { row: "cursor-line", label: "↑", cluster: 1 } },
  { seq: ["h"], command: "cursor-parent", help: { row: "cursor-tree", label: "h" } },
  { seq: ["ArrowLeft"], command: "cursor-parent", help: { row: "cursor-tree", label: "←", cluster: 1 } },
  { seq: ["l"], command: "cursor-child", help: { row: "cursor-tree", label: "l" } },
  { seq: ["ArrowRight"], command: "cursor-child", help: { row: "cursor-tree", label: "→", cluster: 1 } },
  { seq: ["{"], command: "cursor-sibling-prev", help: { row: "cursor-sibling", label: "{" } },
  { seq: ["}"], command: "cursor-sibling-next", help: { row: "cursor-sibling", label: "}" } },
  { seq: ["g", "g"], command: "cursor-first", help: { row: "ends", label: "gg" } },
  { seq: ["G"], command: "cursor-last", help: { row: "ends", label: "G" } },

  // Unread.
  { seq: ["n"], command: "unread-next", help: { row: "unread", label: "n" } },
  { seq: ["N"], command: "unread-prev", help: { row: "unread", label: "N" } },
  { seq: ["r"], command: "mark-read", help: { row: "read", label: "r" } },
  { seq: ["R"], command: "mark-unread", help: { row: "read", label: "R" } },

  // Folds. Enter and za are the same command, not merely similar ones.
  { seq: ["Enter"], command: "fold-toggle", help: { row: "fold-enter", label: "enter" } },
  { seq: ["z", "a"], command: "fold-toggle", help: { row: "fold-one", label: "za" } },
  { seq: ["z", "o"], command: "fold-open", help: { row: "fold-one", label: "zo" } },
  { seq: ["z", "c"], command: "fold-close", help: { row: "fold-one", label: "zc" } },
  { seq: ["z", "O"], command: "fold-open-subtree", help: { row: "fold-subtree", label: "zO" } },
  { seq: ["z", "C"], command: "fold-close-subtree", help: { row: "fold-subtree", label: "zC" } },
  { seq: ["z", "R"], command: "fold-open-all", help: { row: "fold-all", label: "zR" } },
  { seq: ["z", "M"], command: "fold-close-all", help: { row: "fold-all", label: "zM" } },

  // Everything else.
  { seq: ["z", "z"], command: "center-cursor", help: { row: "center", label: "zz" } },
  { seq: ["g", "x"], command: "open-on-x", help: { row: "open-x", label: "gx" } },
  { seq: ["y", "y"], command: "copy-x-link", help: { row: "copy", label: "yy" } },
  { seq: ["Y"], command: "copy-app-link", help: { row: "copy", label: "Y" } },
  { seq: ["?"], command: "help-toggle", help: { row: "help", label: "?" } },
  { seq: ["Escape"], command: "help-close" },
];

function seqKey(pending: string | null, key: string): string {
  return pending === null ? key : `${pending} ${key}`;
}

const BY_SEQ = new Map<string, CommandId>(
  KEYMAP.map((binding) => [
    seqKey(binding.seq.length === 2 ? binding.seq[0] : null, binding.seq[binding.seq.length - 1]!),
    binding.command,
  ]),
);

const PREFIXES = new Set<string>(
  KEYMAP.filter((binding) => binding.seq.length === 2).map((binding) => binding.seq[0]),
);

/** The command a key runs, given the prefix already typed (null if none). */
export function lookup(pending: string | null, key: string): CommandId | null {
  return BY_SEQ.get(seqKey(pending, key)) ?? null;
}

/** Whether a key starts a sequence rather than running a command. */
export function isPrefix(key: string): boolean {
  return PREFIXES.has(key);
}

export interface HelpRow {
  readonly keys: string;
  readonly desc: string;
}

function buildHelp(): readonly HelpRow[] {
  return HELP_ROWS.map((row) => {
    const clusters = new Map<number, string[]>();
    for (const { help } of KEYMAP) {
      if (help?.row !== row.id) continue;
      const cluster = clusters.get(help.cluster ?? 0) ?? [];
      cluster.push(help.label);
      clusters.set(help.cluster ?? 0, cluster);
    }
    const sep = "sep" in row ? row.sep : " / ";
    const keys = [...clusters.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, labels]) => labels.join(sep))
      .join(", ");
    return { keys, desc: row.desc };
  });
}

/** The help overlay's contents, in display order. */
export const HELP: readonly HelpRow[] = buildHelp();
