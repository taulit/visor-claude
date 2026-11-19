// Keeps what is known about the Claude Code sessions of this machine up to
// date: one directory monitor on `~/.claude/sessions`, the session file of a
// process read again when it changes, and the end of its transcript. All of
// it is asynchronous and bounded; nothing is ever written.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
  EMPTY_TAIL,
  MAX_SESSION_FILE,
  TAIL_BYTES,
  doneAtOf,
  isAlive,
  isJsonObject,
  parseSessionFile,
  parseTail,
  parentOf,
  pidOfFileName,
  projectDir,
  type Known,
  type SessionFile,
} from './sessions.js';

/** Changes of one file within this time are read once. */
const DEBOUNCE_MS = 60;
/** The transcript is written a moment after the status; it is read a second time then. */
const TAIL_AGAIN_MS = 800;
const STAT_BYTES = 1024;

interface Chunk {
  text: string;
  /** True when the text starts at the beginning of the file. */
  whole: boolean;
  /** Size and time of the file, to see that it has not changed. */
  stamp: string;
}

/** Runs one asynchronous call of Gio as a promise. */
function call<T>(
  start: (done: Gio.AsyncReadyCallback) => void,
  finish: (result: Gio.AsyncResult) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    start((_source, result) => {
      try {
        resolve(finish(result));
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

/**
 * At most `max` bytes of a file as text: its beginning, or its end with
 * `fromEnd`. Null when the file cannot be read; `unchanged` when its size and
 * time are the ones of `stamp`.
 */
async function readPart(
  file: Gio.File,
  max: number,
  fromEnd: boolean,
  cancellable: Gio.Cancellable,
  stamp?: string,
): Promise<Chunk | 'unchanged' | null> {
  let stream: Gio.FileInputStream;
  try {
    stream = await call(
      done => file.read_async(GLib.PRIORITY_DEFAULT, cancellable, done),
      result => file.read_finish(result),
    );
  } catch {
    return null;
  }
  try {
    let whole = true;
    let found = '';
    if (fromEnd) {
      const info = await call(
        done =>
          stream.query_info_async(
            'standard::size,time::modified,time::modified-usec',
            GLib.PRIORITY_DEFAULT,
            cancellable,
            done,
          ),
        result => stream.query_info_finish(result),
      );
      const size = info.get_size();
      found = `${size}:${info.get_attribute_uint64('time::modified')}:${info.get_attribute_uint32('time::modified-usec')}`;
      if (found === stamp) return 'unchanged';
      if (size > max) {
        // Moves the position only; nothing is read here.
        stream.seek(size - max, GLib.SeekType.SET, cancellable);
        whole = false;
      }
    }
    const parts: Uint8Array[] = [];
    let length = 0;
    while (length < max) {
      const bytes = await call(
        done => stream.read_bytes_async(max - length, GLib.PRIORITY_DEFAULT, cancellable, done),
        result => stream.read_bytes_finish(result),
      );
      const data = bytes.toArray();
      if (data.length === 0) break;
      parts.push(data);
      length += data.length;
    }
    const all = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      all.set(part, offset);
      offset += part.length;
    }
    return { text: new TextDecoder().decode(all), whole, stamp: found };
  } catch {
    return null;
  } finally {
    stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
  }
}

interface Entry extends Known {
  /** Where the transcript was found, by session id. */
  transcript: Gio.File | null;
  stamp: string;
  /** The parents of the process, nearest first; null until they were asked for. */
  ancestors: number[] | null;
  /** True once the transcript was looked for in every project without finding it. */
  searched: boolean;
}

export class SessionWatcher {
  private readonly sessionsDir: Gio.File;
  private readonly projectsDir: Gio.File;
  private cancellable: Gio.Cancellable | null = null;
  private monitor: Gio.FileMonitor | null = null;
  private entries = new Map<number, Entry>();
  private dirty = new Set<number>();
  private flushSource = 0;
  private armSerial = 0;
  /** The second read of a transcript, by pid. */
  private tailSources = new Map<number, number>();
  /** The newest read of each session file; an older one that ends later is dropped. */
  private reading = new Map<number, object>();
  private tailReading = new Map<number, object>();

  /** `configDir` is the directory of Claude Code, `~/.claude` unless the user moved it. */
  constructor(
    configDir: string,
    private readonly onChange: () => void,
  ) {
    const config = Gio.File.new_for_path(configDir);
    this.sessionsDir = config.get_child('sessions');
    this.projectsDir = config.get_child('projects');
  }

  get known(): Iterable<Known> {
    return this.entries.values();
  }

  /** The pids above the process of a session, nearest first; empty until known. */
  ancestorsOf(pid: number): number[] {
    return this.entries.get(pid)?.ancestors ?? [];
  }

  start(): void {
    this.cancellable = new Gio.Cancellable();
    void this.arm(this.cancellable);
  }

  stop(): void {
    this.cancellable?.cancel();
    this.cancellable = null;
    this.monitor?.cancel();
    this.monitor = null;
    if (this.flushSource) GLib.source_remove(this.flushSource);
    this.flushSource = 0;
    for (const source of this.tailSources.values()) GLib.source_remove(source);
    this.tailSources.clear();
    this.entries.clear();
    this.dirty.clear();
    this.reading.clear();
    this.tailReading.clear();
  }

  /**
   * Looks again at what is shown: a process that is gone loses its session, and
   * with `tails` the transcripts are read again if they changed.
   */
  refresh(tails: boolean): void {
    const cancellable = this.cancellable;
    if (!cancellable) return;
    for (const [pid, entry] of this.entries) {
      void this.statOf(pid, cancellable).then(stat => {
        if (cancellable.is_cancelled() || this.entries.get(pid) !== entry) return;
        if (!isAlive(entry.file, stat)) this.drop(pid);
        else if (tails) void this.readTail(pid, cancellable);
      });
    }
  }

  // --- the directory ---

  /**
   * Watches the directory of the session files, or, while it does not exist,
   * the nearest directory above it that does, for it to appear. A monitor on
   * a missing path would make GLib look for it every few seconds.
   */
  private async arm(cancellable: Gio.Cancellable): Promise<void> {
    const serial = ++this.armSerial;
    const stale = (): boolean => cancellable.is_cancelled() || this.armSerial !== serial;
    const config = this.sessionsDir.get_parent();
    const chain = [this.sessionsDir, config, config?.get_parent() ?? null];
    let index = 0;
    for (; index < chain.length; index++) {
      const dir = chain[index];
      if (dir && (await this.isDirectory(dir, cancellable))) break;
      if (stale()) return;
    }
    const watched = chain[index];
    if (stale() || !watched) return;
    this.monitor?.cancel();
    try {
      this.monitor = watched.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
    } catch {
      this.monitor = null;
      return;
    }
    const monitor = this.monitor;
    const awaited = index > 0 ? chain[index - 1]! : null;
    if (awaited) {
      const name = awaited.get_basename();
      monitor.connect('changed', (_monitor, file, other) => {
        if (this.monitor !== monitor) return;
        if (file.get_basename() === name || other?.get_basename() === name)
          void this.arm(cancellable);
      });
      // Appeared between the look and the monitor?
      if ((await this.isDirectory(awaited, cancellable)) && !stale()) void this.arm(cancellable);
      return;
    }
    monitor.connect('changed', (_monitor, file, other, event) => {
      if (this.monitor !== monitor) return;
      if (event === Gio.FileMonitorEvent.DELETED && file.equal(this.sessionsDir)) {
        // The directory itself went: every session with it, and it may come back.
        for (const pid of this.entries.keys()) this.touch(pid);
        void this.arm(cancellable);
        return;
      }
      for (const changed of [file, other]) {
        const pid = pidOfFileName(changed?.get_basename() ?? '');
        if (pid !== null) this.touch(pid);
      }
    });
    await this.scan(cancellable);
  }

  private async isDirectory(file: Gio.File, cancellable: Gio.Cancellable): Promise<boolean> {
    try {
      const info = await call(
        done =>
          file.query_info_async(
            'standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            done,
          ),
        result => file.query_info_finish(result),
      );
      return info.get_file_type() === Gio.FileType.DIRECTORY;
    } catch {
      return false;
    }
  }

  /** The names in a directory, at most `limit` of them; empty when it cannot be read. */
  private async namesIn(
    dir: Gio.File,
    limit: number,
    cancellable: Gio.Cancellable,
  ): Promise<string[]> {
    const names: string[] = [];
    try {
      const children = await call(
        done =>
          dir.enumerate_children_async(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            done,
          ),
        result => dir.enumerate_children_finish(result),
      );
      while (names.length < limit) {
        const infos = await call(
          done => children.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable, done),
          result => children.next_files_finish(result),
        );
        if (infos.length === 0) break;
        for (const info of infos) names.push(info.get_name());
      }
      children.close_async(GLib.PRIORITY_DEFAULT, null, null);
    } catch {
      // Gone or not readable: what was found so far is all there is.
    }
    return names;
  }

  private async scan(cancellable: Gio.Cancellable): Promise<void> {
    for (const name of await this.namesIn(this.sessionsDir, 4096, cancellable)) {
      const pid = pidOfFileName(name);
      if (pid !== null) this.touch(pid);
    }
  }

  private touch(pid: number): void {
    this.dirty.add(pid);
    if (this.flushSource) return;
    this.flushSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
      this.flushSource = 0;
      const cancellable = this.cancellable;
      const pids = [...this.dirty];
      this.dirty.clear();
      if (cancellable) for (const changed of pids) void this.read(changed, cancellable);
      return GLib.SOURCE_REMOVE;
    });
  }

  // --- one session ---

  private statOf(pid: number, cancellable: Gio.Cancellable): Promise<string | null> {
    return readPart(
      Gio.File.new_for_path(`/proc/${pid}/stat`),
      STAT_BYTES,
      false,
      cancellable,
    ).then(chunk => (chunk === null || chunk === 'unchanged' ? null : chunk.text));
  }

  private async read(pid: number, cancellable: Gio.Cancellable): Promise<void> {
    const token = {};
    this.reading.set(pid, token);
    const file = this.sessionsDir.get_child(`${pid}.json`);
    const chunk = await readPart(file, MAX_SESSION_FILE + 1, false, cancellable);
    const stale = (): boolean => cancellable.is_cancelled() || this.reading.get(pid) !== token;
    if (stale()) return;
    if (chunk === null || chunk === 'unchanged') return this.drop(pid);
    const parsed = parseSessionFile(chunk.text, pid);
    if (!parsed) {
      // A file caught half written: what was known stays until it is whole again.
      if (isJsonObject(chunk.text)) this.drop(pid);
      else this.reading.delete(pid);
      return;
    }
    const stat = await this.statOf(pid, cancellable);
    if (stale()) return;
    if (!isAlive(parsed, stat)) return this.drop(pid);
    this.reading.delete(pid);

    const previous = this.entries.get(pid);
    const same = previous?.file.sessionId === parsed.sessionId;
    const entry: Entry = {
      file: parsed,
      doneAt: doneAtOf(parsed, previous),
      tail: same ? previous.tail : EMPTY_TAIL,
      transcript: same ? previous.transcript : null,
      stamp: same ? previous.stamp : '',
      ancestors: previous?.ancestors ?? null,
      // A transcript that was not found is looked for again when the status changes.
      searched: same && previous.file.status === parsed.status && previous.searched,
    };
    this.entries.set(pid, entry);
    this.onChange();
    if (entry.ancestors === null) void this.readAncestors(pid, entry, stat, cancellable);
    void this.readTail(pid, cancellable);
    // The line the status is about may not be in the transcript yet.
    const again = this.tailSources.get(pid);
    if (again) GLib.source_remove(again);
    this.tailSources.set(
      pid,
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, TAIL_AGAIN_MS, () => {
        this.tailSources.delete(pid);
        if (this.cancellable === cancellable) void this.readTail(pid, cancellable);
        return GLib.SOURCE_REMOVE;
      }),
    );
  }

  private drop(pid: number): void {
    this.reading.delete(pid);
    this.tailReading.delete(pid);
    const again = this.tailSources.get(pid);
    if (again) GLib.source_remove(again);
    this.tailSources.delete(pid);
    if (this.entries.delete(pid)) this.onChange();
  }

  /** Walks up from the process to the one that started the session, for the window it is in. */
  private async readAncestors(
    pid: number,
    entry: Entry,
    stat: string | null,
    cancellable: Gio.Cancellable,
  ): Promise<void> {
    const ancestors: number[] = [];
    let current = stat;
    for (let depth = 0; depth < 24 && current !== null; depth++) {
      const parent = parentOf(current);
      if (parent === null) break;
      ancestors.push(parent);
      current = await this.statOf(parent, cancellable);
      if (cancellable.is_cancelled()) return;
    }
    const now = this.entries.get(pid);
    if (now?.file.sessionId === entry.file.sessionId && now.ancestors === null) {
      now.ancestors = ancestors;
      this.onChange();
    }
  }

  // --- the transcript ---

  private async readTail(pid: number, cancellable: Gio.Cancellable): Promise<void> {
    const entry = this.entries.get(pid);
    // A session at rest has no row, so nobody would see what its transcript says.
    if (!entry || (entry.file.status === 'idle' && entry.doneAt === null)) return;
    const token = {};
    this.tailReading.set(pid, token);
    const { file } = entry;
    const current = (): Entry | null => {
      const now = this.entries.get(pid);
      return !cancellable.is_cancelled() &&
        this.tailReading.get(pid) === token &&
        now?.file.sessionId === file.sessionId
        ? now
        : null;
    };
    let transcript = entry.transcript ?? this.expectedTranscript(file);
    let chunk = transcript
      ? await readPart(transcript, TAIL_BYTES, true, cancellable, entry.stamp)
      : null;
    if (chunk === null && !entry.transcript && !entry.searched) {
      if (!current()) return;
      entry.searched = true;
      // The session moved to another directory since it began: look for its file.
      transcript = await this.findTranscript(file, cancellable);
      chunk = transcript ? await readPart(transcript, TAIL_BYTES, true, cancellable) : null;
    }
    const now = current();
    if (!now || chunk === null || chunk === 'unchanged') return;
    now.transcript = transcript;
    now.stamp = chunk.stamp;
    const tail = parseTail(chunk.text, chunk.whole);
    const before = now.tail;
    // A title that scrolled out of reach is still the title.
    if (!tail.title) tail.title = before.title;
    if (!tail.lastMessage) tail.lastMessage = before.lastMessage;
    now.tail = tail;
    if (
      tail.title !== before.title ||
      tail.lastMessage !== before.lastMessage ||
      tail.pending?.kind !== before.pending?.kind ||
      tail.pending?.detail !== before.pending?.detail
    )
      this.onChange();
  }

  private expectedTranscript(file: SessionFile): Gio.File | null {
    const dir = projectDir(file.cwd);
    return dir ? this.projectsDir.get_child(dir).get_child(`${file.sessionId}.jsonl`) : null;
  }

  private async findTranscript(
    file: SessionFile,
    cancellable: Gio.Cancellable,
  ): Promise<Gio.File | null> {
    for (const name of await this.namesIn(this.projectsDir, 2048, cancellable)) {
      if (cancellable.is_cancelled()) return null;
      const candidate = this.projectsDir.get_child(name).get_child(`${file.sessionId}.jsonl`);
      try {
        await call(
          done =>
            candidate.query_info_async(
              'standard::type',
              Gio.FileQueryInfoFlags.NONE,
              GLib.PRIORITY_DEFAULT,
              cancellable,
              done,
            ),
          result => candidate.query_info_finish(result),
        );
        return candidate;
      } catch {
        // Not in this project.
      }
    }
    return null;
  }
}
