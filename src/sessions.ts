// What Claude Code leaves on disk about its sessions, read without trusting it:
// the session file of each process (`~/.claude/sessions/<pid>.json`) and the
// end of a transcript (`~/.claude/projects/<project>/<session>.jsonl`). Neither
// format is documented; docs/data-source.md lists every field used here and
// the version it was read from. Nothing in this file touches the disk, so the
// unit tests cover all of it.

/** How long a finished session keeps its row. */
export const DONE_MS = 120_000;
/** Rows before "+ n more". */
export const MAX_ROWS = 3;
/** A session file is a few hundred bytes; more than this is not one. */
export const MAX_SESSION_FILE = 64 * 1024;
/** How much of the end of a transcript is read. */
export const TAIL_BYTES = 256 * 1024;
const MAX_MESSAGE = 600;
const MAX_DETAIL = 200;
const MAX_TITLE = 120;
/** An idle session whose status is no older than its start has not worked yet. */
const FRESH_MS = 5000;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, max = 4096): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

const time = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 4e15 ? value : null;

function parse(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * One line without control characters, at most `max` characters. Format
 * characters go too: they are invisible, and the bidi ones reorder what follows.
 */
export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // The slice keeps a huge input from being scanned in full.
  const line = value
    .slice(0, max * 4)
    .replace(/[\p{Cf}\p{Cs}]+/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** True for text that is a JSON object, whatever is in it. */
export const isJsonObject = (content: string): boolean => parse(content) !== null;

// --- the session file of a process ---

/** What the session waits for, as Claude Code groups its own `waitingFor` texts. */
export type Waiting = 'approval' | 'question' | 'other';

export interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  /** The name of the session, empty when it has none or only one made from the directory. */
  name: string;
  status: 'busy' | 'idle' | 'waiting';
  /** Set while `status` is 'waiting'; null for a dialog the user opened themselves. */
  waiting: Waiting | null;
  startedAt: number | null;
  /** When `status` last changed, in milliseconds since the epoch. */
  statusAt: number | null;
  /** Start time of the process as in `/proc/<pid>/stat`, to tell a reused pid. */
  procStart: string | null;
}

/** The pid of `<pid>.json`, null for any other file of the directory. */
export function pidOfFileName(name: string): number | null {
  const match = /^([1-9]\d{0,9})\.json$/.exec(name);
  return match ? Number(match[1]) : null;
}

const WAITING: Record<string, Waiting | null> = {
  'permission prompt': 'approval',
  'sandbox request': 'approval',
  'worker request': 'approval',
  'goal proposal': 'approval',
  'input needed': 'question',
  // A menu the user opened in the terminal: they are there already.
  'dialog open': null,
};

/**
 * The session a file describes, null when it is none Visor shows: not JSON, no
 * session id, a pid that is not the one of the file name, a spare or a daemon
 * process, or a status this version does not know.
 */
export function parseSessionFile(content: string, pid: number): SessionFile | null {
  if (content.length > MAX_SESSION_FILE) return null;
  const file = parse(content);
  if (!file || file.pid !== pid) return null;
  const sessionId = text(file.sessionId, 128);
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  if (file.spare === true || file.kind === 'daemon') return null;
  let status: SessionFile['status'];
  // 'shell': the turn is over and a background command still runs.
  if (file.status === 'idle' || file.status === 'shell') status = 'idle';
  else if (file.status === 'busy' || file.status === 'waiting') status = file.status;
  else return null;
  let waiting: Waiting | null = null;
  if (status === 'waiting') {
    const reason = text(file.waitingFor, 64);
    waiting =
      reason !== null && Object.hasOwn(WAITING, reason) ? (WAITING[reason] ?? null) : 'other';
    // Its own dialog is no reason to call the user: the session rests.
    if (waiting === null) status = 'idle';
  }
  // A name Claude Code made from the directory says nothing the project does not.
  const named = file.nameSource === 'derived' ? '' : clean(file.name, MAX_TITLE);
  return {
    pid,
    sessionId,
    cwd: text(file.cwd) ?? '',
    name: named,
    status,
    waiting,
    startedAt: time(file.startedAt),
    statusAt: time(file.statusUpdatedAt) ?? time(file.updatedAt),
    procStart: text(file.procStart, 32),
  };
}

/**
 * The start time of a process (field 22 of `/proc/<pid>/stat`), null when the
 * text is not such a line. The name of the process may hold spaces and
 * brackets, so the fields are counted from the last closing bracket.
 */
export function procStartOf(stat: string): string | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const start = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/)[19];
  return start !== undefined && /^\d+$/.test(start) ? start : null;
}

/** The parent of a process (field 4 of `/proc/<pid>/stat`), null when unknown. */
export function parentOf(stat: string): number | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const parent = Number(
    stat
      .slice(end + 1)
      .trim()
      .split(/\s+/)[1],
  );
  return Number.isInteger(parent) && parent > 1 ? parent : null;
}

/** False when the process of a session file is gone or its pid belongs to another one now. */
export function isAlive(file: SessionFile, stat: string | null): boolean {
  if (stat === null) return false;
  if (file.procStart === null) return true;
  const start = procStartOf(stat);
  return start === null || start === file.procStart;
}

/**
 * When a session finished its last turn, as far as it can be known: `previous`
 * is what was known of the same process before this file was read. An idle
 * session counts as finished from the moment its status changed, unless it has
 * not worked since it started or only closed a dialog of its own.
 */
export function doneAtOf(
  file: SessionFile,
  previous: { file: SessionFile; doneAt: number | null } | undefined,
): number | null {
  if (file.status !== 'idle') return null;
  if (previous?.file.sessionId === file.sessionId) {
    if (previous.file.status === 'idle') return previous.doneAt;
    return file.statusAt;
  }
  if (file.statusAt === null) return null;
  if (file.startedAt !== null && file.statusAt - file.startedAt < FRESH_MS) return null;
  return file.statusAt;
}

// --- the transcript ---

/**
 * The directory of a project below `projects/`: every character of the path
 * that is no letter and no digit becomes a dash. Null for a path so long that
 * Claude Code shortens it with a hash that is not known here.
 */
export function projectDir(cwd: string): string | null {
  if (!cwd.startsWith('/')) return null;
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return name.length <= 200 ? name : null;
}

/** The last part of a path, for the project name. */
export function projectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return clean(parts[parts.length - 1] ?? '', 40);
}

/** The tool call a session asks about. */
export interface Pending {
  kind: 'command' | 'file' | 'other';
  /** The command, the path or the address, on one line; may be empty. */
  detail: string;
}

export interface Tail {
  /** The last text the assistant wrote, on one line; empty when none is in reach. */
  lastMessage: string;
  /** The title of the session, empty when none is in reach. */
  title: string;
  /** The one tool call without a result, null when there is none or more than one. */
  pending: Pending | null;
}

export const EMPTY_TAIL: Tail = { lastMessage: '', title: '', pending: null };

const blocksOf = (line: Json): Json[] => {
  const message = line.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isObject);
};

// Tools that only hand the work on: who asks then is a subagent, about something else.
const DELEGATES = new Set(['Agent', 'Task']);

function pendingOf(block: Json): Pending | null {
  if (typeof block.name !== 'string' || DELEGATES.has(block.name)) return null;
  const input = isObject(block.input) ? block.input : {};
  if (typeof input.command === 'string')
    return { kind: 'command', detail: clean(input.command, MAX_DETAIL) };
  for (const key of ['file_path', 'notebook_path', 'path'])
    if (typeof input[key] === 'string')
      return { kind: 'file', detail: clean(input[key], MAX_DETAIL) };
  return { kind: 'other', detail: clean(input.url, MAX_DETAIL) || clean(block.name, 40) };
}

/**
 * Reads the end of a transcript. `content` is its last bytes as text; when it
 * does not start at the beginning of the file (`whole` false) the first line
 * is a rest and is dropped. Lines that are not JSON or of another shape are
 * skipped, and lines of subagents (`isSidechain`) do not count.
 */
export function parseTail(content: string, whole: boolean): Tail {
  const lines = content.split('\n');
  if (!whole) lines.shift();
  let lastMessage = '';
  let customTitle = '';
  let aiTitle = '';
  // Tool calls since the last prompt of the user, and the ones that have a result.
  const calls: Json[] = [];
  const results = new Set<string>();
  let turnSeen = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]!;
    // Most of a transcript is of no interest here; do not parse it.
    const wanted =
      raw.includes('"assistant"') ||
      raw.includes('"user"') ||
      raw.includes('"custom-title"') ||
      raw.includes('"ai-title"');
    if (!wanted) continue;
    const line = parse(raw);
    if (!line || line.isSidechain === true || line.isMeta === true) continue;
    if (line.type === 'custom-title') customTitle ||= clean(line.customTitle, MAX_TITLE);
    else if (line.type === 'ai-title') aiTitle ||= clean(line.aiTitle, MAX_TITLE);
    else if (line.type === 'assistant') {
      const blocks = blocksOf(line);
      if (!lastMessage) {
        const written = blocks
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text as string)
          .join(' ');
        lastMessage = clean(written, MAX_MESSAGE);
      }
      if (!turnSeen) calls.push(...blocks.filter(block => block.type === 'tool_use'));
    } else if (line.type === 'user' && !turnSeen) {
      const message = line.message;
      const blocks = blocksOf(line);
      const answers = blocks.filter(block => block.type === 'tool_result');
      for (const block of answers)
        if (typeof block.tool_use_id === 'string') results.add(block.tool_use_id);
      // Anything else a user line carries is a prompt: what came before is an older turn.
      if (answers.length === 0 && isObject(message)) turnSeen = true;
    }
    if (lastMessage && turnSeen && (customTitle || aiTitle)) break;
  }
  const open = calls.filter(call => typeof call.id !== 'string' || !results.has(call.id));
  return {
    lastMessage,
    title: customTitle || aiTitle,
    pending: open.length === 1 ? pendingOf(open[0]!) : null,
  };
}

// --- what Visor shows ---

export type Phase = 'working' | 'approval' | 'question' | 'waiting' | 'done';

export interface Session {
  /** The pid as text: one row per process. */
  id: string;
  sessionId: string;
  title: string;
  project: string;
  phase: Phase;
  /** When the current status began; null when the file does not say. */
  since: number | null;
  /** When a finished session loses its row; null for the others. */
  until: number | null;
  lastMessage: string;
  /** What an approval is about, as far as the transcript tells. */
  pending: Pending | null;
}

export interface Known {
  file: SessionFile;
  doneAt: number | null;
  tail: Tail;
}

export const isWaiting = (session: Session): boolean =>
  session.phase === 'approval' || session.phase === 'question' || session.phase === 'waiting';

const RANK: Record<Phase, number> = { approval: 0, question: 0, waiting: 0, working: 1, done: 2 };

/**
 * The sessions that have a row at `now`: the ones that wait first, then the
 * ones that work, then the ones that finished within the last two minutes;
 * within a group the newest status first.
 */
export function sessionsOf(known: Iterable<Known>, now: number): Session[] {
  const sessions: Session[] = [];
  for (const { file, doneAt, tail } of known) {
    let phase: Phase;
    let until: number | null = null;
    if (file.status === 'busy') phase = 'working';
    else if (file.status === 'waiting')
      phase = file.waiting === 'other' ? 'waiting' : file.waiting!;
    else {
      if (doneAt === null || now >= doneAt + DONE_MS) continue;
      phase = 'done';
      until = doneAt + DONE_MS;
    }
    const project = projectName(file.cwd);
    sessions.push({
      id: String(file.pid),
      sessionId: file.sessionId,
      title: file.name || tail.title || project,
      project,
      phase,
      since: phase === 'done' ? doneAt : file.statusAt,
      until,
      lastMessage: tail.lastMessage,
      pending: phase === 'approval' ? tail.pending : null,
    });
  }
  return sessions.sort(
    (a, b) =>
      RANK[a.phase] - RANK[b.phase] || (b.since ?? 0) - (a.since ?? 0) || a.id.localeCompare(b.id),
  );
}

/** The rows and how many sessions are behind "+ n more". */
export function visibleSessions(
  sessions: Session[],
  showAll: boolean,
  max = MAX_ROWS,
): { shown: Session[]; more: number } {
  if (showAll || sessions.length <= max) return { shown: sessions, more: 0 };
  return { shown: sessions.slice(0, max), more: sessions.length - max };
}
