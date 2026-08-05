/**
 * The reader's own settings, on disk.
 *
 * One file, `<claude config dir>/claude-observatory/prefs.json`, holding only what a reader has
 * ACTUALLY changed. An absent key means "follow the environment", which is why nothing here writes
 * defaults out: a prefs file full of the values the product would have picked anyway is a file that
 * silently freezes today's defaults into every future version, and the reader never asked for that.
 *
 * Every value is validated on read. This file can be hand-edited, can be older than the build reading
 * it, and can be newer — so an unknown colour name or a rebind to a key that no longer exists must
 * degrade to the default rather than break the dashboard on its first paint. `read()` never throws.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeConfigDir } from './paths';

export type ColorPref = 'auto' | 'truecolor' | '256' | '16' | 'none';
export type GlyphPref = 'auto' | 'ascii' | 'safe' | 'block';

/**
 * Every rebindable verb.
 *
 * Structural keys are deliberately absent: F1–F5, the arrows, Tab, Enter, Escape, Space and the
 * digits are the frame's navigation, several are the only way out of a mode, and a reader who
 * rebinds their way into a dashboard they cannot leave has been handed a footgun by a settings
 * screen. The options window says as much rather than offering a field that quietly refuses.
 */
export const REBINDABLE = [
  { action: 'keep', label: 'Keep the selection', fallback: 'a' },
  { action: 'undo', label: 'Undo the selection', fallback: 'u' },
  { action: 'keepAll', label: 'Keep everything listed', fallback: 'A' },
  { action: 'undoAll', label: 'Undo everything listed', fallback: 'U' },
  // `redo` is NOT here: it is `^R`, vim's own redo, and lives with the other ctrl chords in app.ts.
  // It was `R`, one shift away from `r` for refresh — a harmless re-poll and a verb that rewrites
  // files on disk, a shift key apart, sharing nothing that would let a reader guess which was which.
  // Ctrl chords are not rebindable for the same reason the structural keys are not: they are a fixed
  // layer the frame documents, and `keys` here is a map of single characters.
  { action: 'next', label: 'Next edit', fallback: 'n' },
  { action: 'prev', label: 'Previous edit', fallback: 'p' },
  { action: 'editor', label: 'Open in $EDITOR', fallback: 'e' },
  { action: 'copy', label: 'Copy the path, or the diff', fallback: 'y' },
  { action: 'wrap', label: 'Wrap long diff lines, or scroll them', fallback: 'w' },
  // `s` for sort and `b` for the session picker, which is a SWAP: sort was `S` beside session's `s`.
  // Same objection as `o`-not-`M` below, and worse here, because `a`/`A` and `u`/`U` teach the reader a
  // rule — lowercase acts on the selection, uppercase on everything listed — that `s`/`S` then broke,
  // since sorting a list and leaving it are not the same verb in two scopes. Sort is the one a reader
  // reaches for while reading, so it takes the home-row letter; the picker becomes `b`, for browse.
  { action: 'sort', label: 'Sort the list', fallback: 's' },
  // `x` for mark, not `space`: space already folds a change-map folder, and one key doing two things
  // depending on which pane has focus is the ambiguity this keymap keeps removing elsewhere.
  { action: 'mark', label: 'Mark the row for a bulk keep or undo', fallback: 'x' },
  { action: 'filter', label: 'Filter', fallback: '/' },
  { action: 'refresh', label: 'Refresh', fallback: 'r' },
  { action: 'session', label: 'Browse sessions', fallback: 'b' },
  // `o`, not `M`: `m` already minimizes the focused window, and one letter running two different
  // verbs by case alone is a keymap the reader has to squint at — the key row showed `m min` and
  // `M options` side by side and they read as the same key twice.
  { action: 'options', label: 'Options', fallback: 'o' },
  { action: 'minimize', label: 'Minimize the focused window', fallback: 'm' },
  { action: 'zoom', label: 'Zoom the focused window', fallback: 'z' },
  { action: 'reset', label: 'Reset the layout', fallback: '=' },
  { action: 'help', label: 'Keys', fallback: '?' },
  { action: 'quit', label: 'Quit', fallback: 'q' },
] as const;

export type Action = (typeof REBINDABLE)[number]['action'];

export interface Prefs {
  /** Overrides `$VISUAL`/`$EDITOR`. Empty means "use the environment". */
  editor?: string;
  color?: ColorPref;
  glyphs?: GlyphPref;
  mouse?: boolean;
  /** Seconds between polls. Floored on read — a zero would spin the CPU on a background window. */
  refreshSeconds?: number;
  /** Which window has focus when the dashboard opens. */
  startFocus?: StartFocus;
  /** How the Traces list is ordered. Absent means `recent`, the order the payload arrives in. */
  sort?: SortKey;
  /** Syntax colour on a diff's CONTEXT lines. Off by default and the only setting that is: it is the
   *  one feature whose cost lands on a frame that re-renders per keystroke, so it is opt-in and
   *  measured rather than assumed free. */
  syntax?: boolean;
  /** Named colour palette. Absent means `default` — the palette this product has always used, so a
   *  reader who never opens the setting sees no change. Validated on read against the build's own
   *  list, because a theme name from a newer version must degrade to the default, not to a blank UI. */
  theme?: string;
  /** Which face the centre window opens on: the change map, the selected edit's diff, or `auto` —
   *  the map when nothing is selected, which is what a fresh session always is. */
  startFace?: StartFace;
  /** Why a just-entered value was refused, for the settings screen to show. Never persisted:
   *  `writePrefs` stores only real settings, and this is a message about one that did not become one. */
  __reject?: string;
  /** action -> the single key that runs it. Only actions in `REBINDABLE` are honoured. */
  keys?: Partial<Record<Action, string>>;
  /** Where the observatory keeps its store — the log, the blobs and the derived caches. Absolute, or
   *  `~`-prefixed. Absent means the default beside your Claude config. Changing it MOVES what is
   *  already there; a setting that silently stranded a session's history would be worse than none. */
  storeDir?: string;
  /** Machines to look for Claude Code sessions on, over SSH. Read-only: the dashboard lists and reads
   *  them, and never reverts anything on another machine. Each can be turned off without losing it —
   *  a host that is down should not have to be re-typed when it comes back. */
  remotes?: Remote[];
}

export function prefsPath(dir = claudeConfigDir()): string {
  return path.join(dir, 'claude-observatory', 'prefs.json');
}

/** A remote config dir: an absolute or `~` path, or ONE leading shell variable, then plain path
 *  segments. It is interpolated into a remote shell, so `$(`, backticks, `;`, quotes and spaces are
 *  all refused rather than escaped — there is no legitimate config dir that needs them. */
// Anchored with an explicit `[/]` between the head and the tail, so the two cannot both consume the
// same run of path characters. The previous shape let `[A-Za-z0-9._\-\/]*` start immediately after a
// `$VAR` whose own class overlaps it, which is the polynomial-backtracking case CodeQL flags — and this
// string is typed by a reader and then interpolated into a shell on ANOTHER machine, so it is the last
// place to leave a pathological input path open.
export const CONFIG_DIR_OK = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|~|\/)(?:[A-Za-z0-9._-]|\/)*$/;

/** A machine to look for Claude Code sessions on, over SSH. */
export interface Remote {
  /** What the reader called it — the label on every row from this host. */
  name: string;
  /** Whatever `ssh` accepts: a Host from ~/.ssh/config, `user@host`, `host:port` via config. */
  host: string;
  /** The remote's Claude config dir, when it is not `~/.claude` (their CLAUDE_CONFIG_DIR). */
  configDir?: string;
  /** Turned off without being forgotten — a machine that is down should not have to be re-typed
   *  when it comes back. Absent means on. */
  enabled?: boolean;
}

/**
 * Parse one `"name host [configDir]"` line into a validated remote, or the reason it was refused.
 *
 * THE ONE DOOR. Every surface that can add a machine — the terminal options window, the `remotes`
 * verb, and through it both editors — comes through here, because two of these fields are
 * interpolated into a shell that runs on ANOTHER computer. A second copy of that guard is a second
 * chance to get it wrong.
 *
 * A single token is read as the host, with the name defaulting to it, so `remotes --add build-box`
 * works for the common case where the two are the same.
 */
export function parseRemoteSpec(line: string): { remote: Remote } | { error: string } {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { error: 'nothing to add — give a host, or “name host [configDir]”' };
  const [a, b, c] = parts;
  const host = b ?? a;
  if (!/^[A-Za-z0-9._@-]+$/.test(host)) return { error: `“${host}” is not a usable ssh host name` };
  // The NAME never reaches ssh — only `host` and `configDir` are interpolated — but it IS the handle
  // every later operation uses (`remotes --remove <name>`), so one that looks like a flag makes its
  // own removal unparseable: `remotes --add "--json evil"` stored a machine called `--json`.
  if (a.startsWith('-')) return { error: `“${a}” cannot start with “-” — that is how you would name a flag, not a machine` };
  // Validated HERE, not only on read. `readPrefs` drops a configDir that fails this test, which kept
  // the dangerous string out of the shell but made a rejected value vanish with nothing said — the
  // reader configured a path and the tool quietly used a different one.
  if (c !== undefined && !CONFIG_DIR_OK.test(c)) {
    return { error: `“${c}” is not a usable config dir — an absolute or ~ path, or one $VARIABLE, then plain segments` };
  }
  return { remote: { name: a, host, configDir: c, enabled: true } };
}

/** Absolute, or `~`-prefixed. See `Prefs.storeDir` for why a relative path is refused. */
export function isAbsoluteStorePath(p: string): boolean {
  return p.startsWith('~') || path.isAbsolute(p);
}

/** Expand a leading `~` to the home directory. Everything downstream wants a real path. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Validate a store location the reader typed, or say why it cannot be one. */
export function parseStorePath(line: string): { dir: string } | { error: string } {
  const v = line.trim();
  if (!v) return { error: 'nothing to set — give an absolute path, or ~/somewhere' };
  if (!isAbsoluteStorePath(v)) {
    return { error: `“${v}” is relative — the capture hook, the CLI and both editors start in different directories, so a relative store would scatter one session across several` };
  }
  return { dir: v };
}

/** An editor the options window can offer, and the EXACT command that runs it. */
export interface EditorChoice {
  command: string;
  label: string;
}

/**
 * The editors worth offering, with their wait flags.
 *
 * The flag is the whole reason this is a table and not a bare `command -v` sweep. `code` returns the
 * moment the window opens, so `e` would hand the file to VS Code and repaint the dashboard over it a
 * frame later; `code -w` blocks until the tab is closed, which is what the key is for. Terminal
 * editors block by nature and take no flag.
 *
 * `code -w` and `cursor -w` were confirmed against the installed binaries' own `--help` ("Wait for the
 * files to be closed") rather than from memory. The rest carry their documented flag — and because
 * nothing is offered unless its binary is present, and the row shows the command in full, a wrong flag
 * is visible before it is ever run.
 */
const KNOWN_EDITORS: readonly { bin: string; command: string; label: string }[] = [
  { bin: 'nvim', command: 'nvim', label: 'Neovim' },
  { bin: 'vim', command: 'vim', label: 'Vim' },
  { bin: 'hx', command: 'hx', label: 'Helix' },
  { bin: 'helix', command: 'helix', label: 'Helix' },
  { bin: 'kak', command: 'kak', label: 'Kakoune' },
  { bin: 'micro', command: 'micro', label: 'micro' },
  { bin: 'nano', command: 'nano', label: 'nano' },
  { bin: 'emacs', command: 'emacs -nw', label: 'Emacs, in this terminal' },
  { bin: 'vi', command: 'vi', label: 'vi' },
  { bin: 'code', command: 'code -w', label: 'VS Code' },
  { bin: 'code-insiders', command: 'code-insiders -w', label: 'VS Code Insiders' },
  { bin: 'cursor', command: 'cursor -w', label: 'Cursor' },
  { bin: 'windsurf', command: 'windsurf -w', label: 'Windsurf' },
  { bin: 'zed', command: 'zed -w', label: 'Zed' },
  { bin: 'subl', command: 'subl -w', label: 'Sublime Text' },
  { bin: 'mate', command: 'mate -w', label: 'TextMate' },
];

/**
 * Which of them are actually on this machine, in `KNOWN_EDITORS` order.
 *
 * Every input is injectable so this can be asserted without a filesystem — the Windows branch in
 * particular has no other way to be tested from macOS, and it is the branch most likely to be wrong
 * (`code` there is `code.cmd`, which an extension-less probe never finds).
 */
export function detectEditors(
  opts: { path?: string; pathext?: string; win?: boolean; isExec?: (p: string) => boolean } = {}
): EditorChoice[] {
  const win = opts.win ?? process.platform === 'win32';
  const dirs = (opts.path ?? process.env.PATH ?? '').split(win ? ';' : ':').filter(Boolean);
  const exts = win
    ? (opts.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const isExec =
    opts.isExec ??
    ((p: string) => {
      try {
        // A DIRECTORY named `code` on the PATH is not an editor. statSync first would double the
        // syscalls for the common miss, so the cheap access check gates it.
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const out: EditorChoice[] = [];
  const seenLabel = new Set<string>();
  for (const e of KNOWN_EDITORS) {
    // One entry per EDITOR, not per binary: `hx` and `helix` are the same program, and offering both
    // makes the reader step past a duplicate to reach the next real choice.
    if (seenLabel.has(e.label)) continue;
    const found = dirs.some((d) => exts.some((x) => isExec(path.join(d, e.bin + x))));
    if (!found) continue;
    seenLabel.add(e.label);
    out.push({ command: e.command, label: e.label });
  }
  return out;
}

/** What a detected command is called, for the row that names it. Empty for anything hand-typed. */
export function editorLabel(command: string, editors: readonly EditorChoice[]): string {
  return editors.find((e) => e.command === command)?.label ?? '';
}

export type StartFocus = 'traces' | 'prompts' | 'detail' | 'dashboards';
/** How the Traces list is ordered. `recent` is the payload's own order — newest first. */
export type SortKey = 'recent' | 'path' | 'churn';
export const SORT_KEYS: SortKey[] = ['recent', 'path', 'churn'];

/** The palettes this build ships. Named here rather than in the renderer so the settings layer can
 *  validate a hand-edited value without importing the terminal. */
export const THEME_NAMES = ['default', 'colorblind', 'mono'];
export type StartFace = 'auto' | 'map' | 'diff';

const COLORS: ColorPref[] = ['auto', 'truecolor', '256', '16', 'none'];
export const START_FOCUS: StartFocus[] = ['traces', 'prompts', 'detail', 'dashboards'];
export const START_FACE: StartFace[] = ['auto', 'map', 'diff'];
const GLYPHS: GlyphPref[] = ['auto', 'ascii', 'safe', 'block'];

/**
 * Read and VALIDATE. Never throws, and never returns a value the rest of the product cannot use: a
 * missing file, a truncated one, a hand-edited string where a number belongs, and a rebind onto a
 * key the decoder never emits all resolve to the same thing as "not set".
 */
export function readPrefs(file = prefsPath()): Prefs {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {}; // absent or unparseable — both mean "no preferences", and neither is an error
  }
  const d = (raw ?? {}) as Record<string, unknown>;
  const out: Prefs = {};
  if (typeof d.editor === 'string' && d.editor.trim()) out.editor = d.editor.trim();
  if (typeof d.color === 'string' && (COLORS as string[]).includes(d.color)) out.color = d.color as ColorPref;
  if (typeof d.glyphs === 'string' && (GLYPHS as string[]).includes(d.glyphs)) out.glyphs = d.glyphs as GlyphPref;
  if (typeof d.mouse === 'boolean') out.mouse = d.mouse;
  // Absolute or `~` only. A RELATIVE store path would resolve against whatever directory the process
  // happens to start in — the capture hook, the CLI and two editors all differ — so one setting would
  // scatter a session's history across several stores and none of them would look wrong.
  if (typeof d.storeDir === 'string' && d.storeDir.trim() && isAbsoluteStorePath(d.storeDir.trim())) {
    out.storeDir = d.storeDir.trim();
  }
  if (typeof d.startFocus === 'string' && (START_FOCUS as string[]).includes(d.startFocus)) out.startFocus = d.startFocus as StartFocus;
  if (typeof d.startFace === 'string' && (START_FACE as string[]).includes(d.startFace)) out.startFace = d.startFace as StartFace;
  if (typeof d.sort === 'string' && (SORT_KEYS as string[]).includes(d.sort)) out.sort = d.sort as SortKey;
  // Validated against a list core owns, so this module stays free of the renderer. The tui package
  // exports the palettes; the NAMES are the contract, and they live here beside every other setting.
  if (typeof d.theme === 'string' && (THEME_NAMES as string[]).includes(d.theme)) out.theme = d.theme;
  if (typeof d.syntax === 'boolean') out.syntax = d.syntax;
  if (typeof d.refreshSeconds === 'number' && Number.isFinite(d.refreshSeconds)) {
    // Floored at one second. A zero or a negative would poll as fast as the loop can spawn, and this
    // dashboard shells out to a child process per refresh.
    out.refreshSeconds = Math.max(1, Math.min(3600, Math.round(d.refreshSeconds)));
  }
  if (Array.isArray(d.remotes)) {
    const remotes: NonNullable<Prefs['remotes']> = [];
    for (const r of d.remotes as Record<string, unknown>[]) {
      const host = typeof r?.host === 'string' ? r.host.trim() : '';
      // A host that ssh could not accept is dropped rather than kept and failed at every refresh —
      // and the character set is the same one `listRemoteSessions` validates, so a stored value can
      // never be one this build would refuse.
      if (!host || !/^[A-Za-z0-9._@-]+$/.test(host)) continue;
      const name = (typeof r?.name === 'string' && r.name.trim()) || host;
      // Validated like the host, and for the same reason: this string is interpolated into a shell
      // command that runs on ANOTHER machine. The $-leading form is allowed on purpose so
      // $HOME/.claude works, which is exactly why it cannot be a free string: $(...) in that
      // position is command substitution, executed there. One variable reference or a plain path.
      const rawDir = typeof r?.configDir === 'string' ? r.configDir.trim() : '';
      const configDir = rawDir && CONFIG_DIR_OK.test(rawDir) ? rawDir : undefined;
      remotes.push({ name, host, configDir, enabled: r?.enabled !== false });
    }
    if (remotes.length) out.remotes = remotes;
  }
  if (d.keys && typeof d.keys === 'object') {
    const keys: Partial<Record<Action, string>> = {};
    const known = new Set<string>(REBINDABLE.map((r) => r.action));
    for (const [k, v] of Object.entries(d.keys as Record<string, unknown>)) {
      // One printable character, and an action this build knows. A multi-character "binding" would
      // never match a decoded key, so accepting it would produce a verb that silently stopped working.
      if (known.has(k) && typeof v === 'string' && [...v].length === 1 && v >= ' ') keys[k as Action] = v;
    }
    if (Object.keys(keys).length) out.keys = keys;
  }
  return out;
}

/**
 * Write, atomically, keeping only what differs from the defaults.
 *
 * Temp-then-rename, like every other writer here: a crash mid-write must never leave a truncated
 * prefs file, because the next start would read it as "no preferences" and silently discard
 * everything the reader had set.
 */
export function writePrefs(p: Prefs, file = prefsPath()): void {
  const clean: Prefs = {};
  if (p.editor && p.editor.trim()) clean.editor = p.editor.trim();
  if (p.color && p.color !== 'auto') clean.color = p.color;
  if (p.glyphs && p.glyphs !== 'auto') clean.glyphs = p.glyphs;
  if (p.mouse === false) clean.mouse = false;
  if (p.refreshSeconds && p.refreshSeconds !== 3) clean.refreshSeconds = p.refreshSeconds;
  if (p.startFocus && p.startFocus !== 'traces') clean.startFocus = p.startFocus;
  if (p.startFace && p.startFace !== 'auto') clean.startFace = p.startFace;
  if (p.sort && p.sort !== 'recent') clean.sort = p.sort;
  if (p.theme && p.theme !== 'default') clean.theme = p.theme;
  if (p.syntax) clean.syntax = true;
  if (p.storeDir && p.storeDir.trim()) clean.storeDir = p.storeDir.trim();
  // `__reject` is deliberately absent: it is a message about a value that did NOT become a setting.
  const keys: Partial<Record<Action, string>> = {};
  for (const r of REBINDABLE) {
    const v = p.keys?.[r.action];
    if (v && v !== r.fallback) keys[r.action] = v;
  }
  if (Object.keys(keys).length) clean.keys = keys;
  if (p.remotes?.length) clean.remotes = p.remotes;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
  fs.renameSync(tmp, file);
  // `rootDir()` memoizes the store location for the life of the process, so a storeDir written here
  // has to invalidate it or the options window would save a setting this process keeps ignoring.
  // Late-required to keep this module free of a store import at load time.
  try {
    (require('./store') as { clearRootMemo(): void }).clearRootMemo();
  } catch {
    /* store not loaded in this process — nothing memoized to clear */
  }
}

/**
 * The full key -> action map, defaults folded with the reader's rebinds.
 *
 * A rebind that COLLIDES with another action's key wins for itself and leaves the loser unbound —
 * reported by `keyConflicts`, so the options window can say so instead of the reader discovering it
 * by pressing a key that stopped working.
 */
export function keymap(p: Prefs): Map<string, Action> {
  const out = new Map<string, Action>();
  // Defaults FIRST, then the reader's rebinds over the top. One pass in declaration order gave the
  // contested key to whichever action happened to be declared last — so rebinding Keep onto `u` left
  // `u` still running Undo, and the setting the reader had just made appeared to do nothing.
  for (const r of REBINDABLE) if (!p.keys?.[r.action]) out.set(r.fallback, r.action);
  for (const r of REBINDABLE) {
    const k = p.keys?.[r.action];
    if (k) out.set(k, r.action);
  }
  return out;
}

/** Actions whose key is claimed by another action, and by which — empty when the map is clean. */
export function keyConflicts(p: Prefs): { action: Action; key: string; takenBy: Action }[] {
  // Resolved against the SAME map the runtime dispatches through, rather than by re-deriving the
  // precedence here — a conflict report that disagrees with the dispatcher is worse than none.
  const map = keymap(p);
  const out: { action: Action; key: string; takenBy: Action }[] = [];
  for (const r of REBINDABLE) {
    const key = p.keys?.[r.action] ?? r.fallback;
    const winner = map.get(key);
    if (winner && winner !== r.action) out.push({ action: r.action, key, takenBy: winner });
  }
  return out;
}
