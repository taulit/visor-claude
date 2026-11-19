// The Claude Code sessions of this machine as rows in "Now": what works, what
// finished, and above all what waits for the user. Where the data comes from
// is in docs/data-source.md.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type { ModuleContext, NowRow, PeekChip, VisorModule } from './visor/index.js';
import { formatDuration, truncate } from './format.js';
import { isWaiting, sessionsOf, visibleSessions, type Phase, type Session } from './sessions.js';
import { SessionWatcher } from './watcher.js';

const ICON = 'utilities-terminal-symbolic';
const FLASH_KEY = 'flash-on-waiting-sessions';
const MORE_ID = 'claude:more';
/** How often a process is looked for while its session works or waits. */
const ALIVE_SECONDS = 30;
/** How often the transcripts are read again while the panel is open, in ticks of a second. */
const TAIL_TICKS = 3;

const SHELL_PID = new Gio.Credentials().get_unix_pid();

const ICONS: Record<Phase, string> = {
  working: 'content-loading-symbolic',
  approval: 'dialog-question-symbolic',
  question: 'dialog-question-symbolic',
  waiting: 'dialog-question-symbolic',
  done: 'object-select-symbolic',
};

/** What an expanded row shows. Built once per session and updated in place. */
interface Details {
  expand: () => St.Widget;
  message: St.Label | null;
  hint: St.Label | null;
  show: St.Widget | null;
}

/** The directory of Claude Code: `~/.claude`, or where `CLAUDE_CONFIG_DIR` points. */
function configDir(): string {
  const moved = GLib.getenv('CLAUDE_CONFIG_DIR');
  return moved && moved.startsWith('/')
    ? moved
    : GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
}

class ClaudeModule implements VisorModule {
  readonly id = 'claude';
  readonly name: string;
  readonly icon = ICON;
  readonly slot = 'now';

  private ctx: ModuleContext | null = null;
  private watcher: SessionWatcher | null = null;
  private sessions: Session[] = [];
  private details = new Map<string, Details>();
  /** Waits that already flashed: the session and the moment it began to wait. */
  private announced = new Set<string>();
  private showAll = false;
  /** Ticks once per second while the panel is open and something works. */
  private tickSource = 0;
  private ticks = 0;
  /** Waits for the next finished session to lose its row. */
  private expirySource = 0;
  /** Looks now and then whether the processes are still there. */
  private aliveSource = 0;
  /** Renders once after windows came or went. */
  private windowsSource = 0;
  private reported = false;

  /** `gettext` is the one of the extension; a module context has its own (`ctx.t`) only once it runs. */
  constructor(gettext: (text: string) => string) {
    this.name = gettext('Claude Code');
  }

  enable(ctx: ModuleContext): void {
    this.ctx = ctx;
    this.watcher = new SessionWatcher(configDir(), () => this.safely(() => this.render()));
    ctx.onOpenChanged(open =>
      this.safely(() => {
        if (open) this.watcher?.refresh(true);
        else this.showAll = false;
        this.render();
      }),
    );
    // Whether a session has a window to show changes with the windows.
    global.window_manager.connectObject(
      'map',
      () => this.windowsChanged(),
      'destroy',
      () => this.windowsChanged(),
      this,
    );
    this.watcher.start();
  }

  disable(): void {
    global.window_manager.disconnectObject(this);
    if (this.windowsSource) GLib.source_remove(this.windowsSource);
    this.windowsSource = 0;
    this.watcher?.stop();
    this.watcher = null;
    for (const source of [this.tickSource, this.expirySource, this.aliveSource])
      if (source) GLib.source_remove(source);
    this.tickSource = this.expirySource = this.aliveSource = 0;
    this.sessions = [];
    this.details.clear();
    this.announced.clear();
    this.showAll = false;
    this.ctx = null;
  }

  // --- the window of a session ---

  /**
   * The window a session runs in: the one window of the nearest process above
   * it that has any. A terminal that keeps several windows in one process
   * does not tell which one it is; then there is none to show.
   */
  private windowOf(session: Session): Meta.Window | null {
    const pid = Number(session.id);
    const windows: Meta.Window[] = [];
    for (const actor of global.get_window_actors()) {
      const window = actor.meta_window;
      if (window?.get_window_type() === Meta.WindowType.NORMAL) windows.push(window);
    }
    for (const owner of [pid, ...(this.watcher?.ancestorsOf(pid) ?? [])]) {
      // Apps started from the overview are children of the shell: the walk ends there.
      if (owner === SHELL_PID) break;
      const owned = windows.filter(window => window.get_pid() === owner);
      if (owned.length > 0) return owned.length === 1 ? owned[0]! : null;
    }
    return null;
  }

  /** Nobody sees the rows while the panel is closed; opening it renders anyway. */
  private windowsChanged(): void {
    if (!this.ctx?.isOpen || this.sessions.length === 0 || this.windowsSource) return;
    // After the window manager is done with the window: it is still listed while it goes.
    this.windowsSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this.windowsSource = 0;
      this.safely(() => this.render());
      return GLib.SOURCE_REMOVE;
    });
  }

  private showWindow(id: string): void {
    const session = this.sessions.find(s => s.id === id);
    const window = session ? this.windowOf(session) : null;
    if (!window) return;
    this.ctx?.close();
    Main.activateWindow(window);
  }

  // --- what is shown ---

  private render(): void {
    const ctx = this.ctx;
    const watcher = this.watcher;
    if (!ctx || !watcher) return;
    const _ = ctx.t;
    const now = Date.now();
    this.sessions = sessionsOf(watcher.known, now);
    const shownIds = new Set(this.sessions.map(session => session.id));
    for (const id of [...this.details.keys()]) if (!shownIds.has(id)) this.details.delete(id);

    if (this.sessions.length === 0) {
      ctx.now.clear();
    } else {
      const { shown, more } = visibleSessions(this.sessions, this.showAll);
      const rows = shown.map(session => this.row(session, now));
      if (more > 0) {
        rows.push({
          id: MORE_ID,
          icon: 'view-more-symbolic',
          title: _('+ %d more').replace('%d', String(more)),
          status: 'done',
          activate: () => {
            this.showAll = true;
            this.render();
          },
        });
      }
      ctx.now.set(rows);
    }

    const waiting = this.sessions.filter(isWaiting);
    const first = waiting[0];
    ctx.peek.set(first ? this.chip(first) : null);
    ctx.attention(first ? 'waiting' : null);
    const flash = ctx.settings?.get_boolean(FLASH_KEY) ?? true;
    const waits = new Set(waiting.map(session => `${session.id}:${session.since}`));
    for (const key of [...this.announced]) if (!waits.has(key)) this.announced.delete(key);
    for (const session of waiting) {
      const key = `${session.id}:${session.since}`;
      if (this.announced.has(key)) continue;
      this.announced.add(key);
      if (flash) ctx.peek.flash(this.chip(session));
    }

    this.schedule(now);
  }

  private chip(session: Session): PeekChip {
    const _ = this.ctx!.t;
    const name = truncate(session.title, 20) || _('Claude Code');
    return {
      icon: ICONS.approval,
      text: _('%s is waiting').replace('%s', name),
      tone: 'waiting',
      priority: 100,
    };
  }

  private state(session: Session, now: number): string {
    const _ = this.ctx!.t;
    switch (session.phase) {
      case 'working':
        return session.since === null
          ? _('Working')
          : `${_('Working')} · ${formatDuration(Math.max(0, now - session.since))}`;
      case 'approval':
        if (session.pending?.kind === 'command') return _('Wants to run');
        return session.pending?.kind === 'file'
          ? _('Wants to use a file')
          : _('Asks for permission');
      case 'question':
        return _('Has a question');
      case 'waiting':
        return _('Waits for you');
      default:
        return _('Done');
    }
  }

  private row(session: Session, now: number): NowRow {
    const _ = this.ctx!.t;
    const window = this.windowOf(session);
    // A session without a name is called after its project; no need to say it twice.
    const project = session.project === session.title ? '' : session.project;
    const row: NowRow = {
      id: `claude:${session.id}`,
      icon: ICONS[session.phase],
      title: session.title || _('Untitled session'),
      subtitle: [project, this.state(session, now)].filter(Boolean).join(' · '),
    };
    // Nothing to read and nowhere to go: nothing to expand.
    if (session.lastMessage || isWaiting(session) || window)
      row.expand = this.detailsOf(session, window !== null).expand;
    if (session.phase === 'done') return { ...row, status: 'done' };
    if (!isWaiting(session)) return row;
    return {
      ...row,
      status: 'waiting',
      detail: session.pending?.detail || undefined,
      // Short, so that the command next to it keeps its room.
      primary: window
        ? { label: _('Show'), style: 'primary', run: () => this.showWindow(session.id) }
        : undefined,
    };
  }

  /** The function that builds the expanded part; the same one for the life of the row. */
  private detailsOf(session: Session, hasWindow: boolean): Details {
    const { id } = session;
    let details = this.details.get(id);
    if (!details) {
      const created: Details = {
        message: null,
        hint: null,
        show: null,
        expand: () => this.buildDetails(id, created),
      };
      this.details.set(id, (details = created));
    }
    if (details.message) {
      details.message.text = session.lastMessage;
      details.message.visible = session.lastMessage !== '';
    }
    if (details.hint) details.hint.visible = isWaiting(session);
    // A row that waits has the button in the row itself.
    if (details.show) details.show.visible = hasWindow && !isWaiting(session);
    return details;
  }

  private buildDetails(id: string, details: Details): St.Widget {
    const ctx = this.ctx!;
    const _ = ctx.t;
    const session = this.sessions.find(s => s.id === id);
    const hasWindow = session ? this.windowOf(session) !== null : false;
    const box = new St.BoxLayout({
      style_class: 'visor-claude-details',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });

    // Plain text: what an assistant wrote is never markup.
    const message = new St.Label({
      style_class: 'visor-claude-message',
      text: session?.lastMessage ?? '',
      visible: Boolean(session?.lastMessage),
      x_expand: true,
    });
    message.clutter_text.line_wrap = true;
    message.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    message.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(message);

    const hint = new St.Label({
      style_class: 'visor-claude-hint',
      text: _('Answer in the terminal or the app the session runs in.'),
      visible: session ? isWaiting(session) : false,
      x_expand: true,
    });
    hint.clutter_text.line_wrap = true;
    box.add_child(hint);

    // In a box of its own, so that the button keeps its width.
    const show = new St.BoxLayout({
      style_class: 'visor-claude-buttons',
      visible: hasWindow && session !== undefined && !isWaiting(session),
    });
    show.add_child(
      ctx.kit.button({ label: _('Show window'), style: 'ghost', run: () => this.showWindow(id) }),
    );
    box.add_child(show);

    details.message = message;
    details.hint = hint;
    details.show = show;
    box.connect('destroy', () => {
      if (details.message !== message) return;
      details.message = details.hint = null;
      details.show = null;
    });
    return box;
  }

  // --- time ---

  private schedule(now: number): void {
    const ctx = this.ctx!;
    const active = this.sessions.some(session => session.phase !== 'done');

    const ticking = ctx.isOpen && this.sessions.some(session => session.phase === 'working');
    if (ticking && !this.tickSource) {
      this.ticks = 0;
      this.tickSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        this.safely(() => {
          if (++this.ticks % TAIL_TICKS === 0) this.watcher?.refresh(true);
          this.render();
        });
        return this.tickSource ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
      });
    } else if (!ticking && this.tickSource) {
      GLib.source_remove(this.tickSource);
      this.tickSource = 0;
    }

    // A process that was killed leaves its file behind, and nothing tells.
    if (active && !this.aliveSource) {
      this.aliveSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ALIVE_SECONDS, () => {
        this.safely(() => this.watcher?.refresh(false));
        return this.aliveSource ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
      });
    } else if (!active && this.aliveSource) {
      GLib.source_remove(this.aliveSource);
      this.aliveSource = 0;
    }

    if (this.expirySource) GLib.source_remove(this.expirySource);
    this.expirySource = 0;
    const next = Math.min(...this.sessions.map(session => session.until ?? Infinity));
    if (next === Infinity) return;
    this.expirySource = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(50, next - now + 20),
      () => {
        this.expirySource = 0;
        this.safely(() => this.render());
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  /** For callbacks nobody else guards: an exception is logged once and goes no further. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (this.reported) return;
      this.reported = true;
      logError(e as Error, 'Visor: Claude Code');
    }
  }
}

export function claudeModule(gettext: (text: string) => string): VisorModule {
  return new ClaudeModule(gettext);
}
