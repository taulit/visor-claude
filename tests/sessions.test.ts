import { describe, expect, it } from 'vitest';
import {
  DONE_MS,
  EMPTY_TAIL,
  MAX_SESSION_FILE,
  clean,
  doneAtOf,
  isAlive,
  isJsonObject,
  isWaiting,
  parentOf,
  parseSessionFile,
  parseTail,
  pidOfFileName,
  procStartOf,
  projectDir,
  projectName,
  sessionsOf,
  visibleSessions,
  type Known,
  type SessionFile,
} from '../src/sessions.js';

// Everything here is invented: no line comes from a real session.
const T0 = 1_800_000_000_000;

const fileJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    pid: 4242,
    sessionId: '11111111-2222-3333-4444-555555555555',
    cwd: '/home/ada/code/lighthouse',
    startedAt: T0,
    procStart: '987654',
    version: '2.1.327',
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'Harbour map',
    nameSource: 'user',
    status: 'busy',
    updatedAt: T0 + 9000,
    statusUpdatedAt: T0 + 8000,
    ...over,
  });

const file = (over: Record<string, unknown> = {}): SessionFile =>
  parseSessionFile(fileJson(over), 4242)!;

describe('the name of a session file', () => {
  it('is the pid and .json', () => {
    expect(pidOfFileName('4242.json')).toBe(4242);
  });
  it('is nothing else', () => {
    for (const name of [
      '4242.abcdef.key',
      '4242.json.tmp',
      '0.json',
      '-1.json',
      '042.json',
      'x.json',
      '12345678901.json',
      '',
    ])
      expect(pidOfFileName(name)).toBeNull();
  });
});

describe('parseSessionFile', () => {
  it('reads a working session', () => {
    expect(file()).toEqual({
      pid: 4242,
      sessionId: '11111111-2222-3333-4444-555555555555',
      cwd: '/home/ada/code/lighthouse',
      name: 'Harbour map',
      status: 'busy',
      waiting: null,
      startedAt: T0,
      statusAt: T0 + 8000,
      procStart: '987654',
    });
  });

  it('tells what a waiting session waits for', () => {
    const waiting = (waitingFor: unknown): unknown =>
      file({ status: 'waiting', waitingFor }).waiting;
    expect(waiting('permission prompt')).toBe('approval');
    expect(waiting('sandbox request')).toBe('approval');
    expect(waiting('worker request')).toBe('approval');
    expect(waiting('goal proposal')).toBe('approval');
    expect(waiting('input needed')).toBe('question');
  });

  it('takes a reason it does not know, or none, as waiting for something', () => {
    expect(file({ status: 'waiting', waitingFor: 'a new kind of prompt' }).waiting).toBe('other');
    expect(file({ status: 'waiting' }).waiting).toBe('other');
    expect(file({ status: 'waiting', waitingFor: 7 }).waiting).toBe('other');
    expect(file({ status: 'waiting', waitingFor: 'constructor' }).waiting).toBe('other');
  });

  it('takes a dialog the user opened as a session at rest', () => {
    const resting = file({ status: 'waiting', waitingFor: 'dialog open' });
    expect(resting.status).toBe('idle');
    expect(resting.waiting).toBeNull();
  });

  it('takes a finished turn with a background command as idle', () => {
    expect(file({ status: 'shell' }).status).toBe('idle');
  });

  it('ignores waitingFor while the session does not wait', () => {
    expect(file({ status: 'busy', waitingFor: 'permission prompt' }).waiting).toBeNull();
  });

  it('drops a name that was made from the directory', () => {
    expect(file({ nameSource: 'derived' }).name).toBe('');
    expect(file({ name: undefined }).name).toBe('');
    expect(file({ name: 42 }).name).toBe('');
  });

  it('puts a name on one line and without invisible characters', () => {
    expect(file({ name: 'Fix\nthe \u202Etide\u0007 table' }).name).toBe('Fix the tide table');
  });

  it('falls back to updatedAt for the time of the status', () => {
    expect(file({ statusUpdatedAt: undefined }).statusAt).toBe(T0 + 9000);
    expect(file({ statusUpdatedAt: 'soon', updatedAt: -1 }).statusAt).toBeNull();
  });

  it('is null for what is no session to show', () => {
    const none = (content: string, pid = 4242): void =>
      expect(parseSessionFile(content, pid)).toBeNull();
    none('');
    none('{');
    none('[]');
    none('null');
    none('"busy"');
    none(fileJson(), 4243);
    none(fileJson({ pid: '4242' }));
    none(fileJson({ sessionId: undefined }));
    none(fileJson({ sessionId: '../../etc/passwd' }));
    none(fileJson({ sessionId: 'a/b' }));
    none(fileJson({ status: undefined }));
    none(fileJson({ status: 'sleeping' }));
    none(fileJson({ spare: true }));
    none(fileJson({ kind: 'daemon' }));
    none(fileJson({ name: 'x'.repeat(MAX_SESSION_FILE) }));
  });

  it('keeps a session without the optional fields', () => {
    const bare = parseSessionFile(JSON.stringify({ pid: 7, sessionId: 'abc', status: 'idle' }), 7);
    expect(bare).toEqual({
      pid: 7,
      sessionId: 'abc',
      cwd: '',
      name: '',
      status: 'idle',
      waiting: null,
      startedAt: null,
      statusAt: null,
      procStart: null,
    });
  });

  it('shows a background session', () => {
    expect(file({ kind: 'bg' }).status).toBe('busy');
  });
});

describe('isJsonObject', () => {
  it('tells a half written file from one that is whole', () => {
    expect(isJsonObject('')).toBe(false);
    expect(isJsonObject('{"pid": 42, "sta')).toBe(false);
    expect(isJsonObject('{"pid": 42}')).toBe(true);
  });
});

describe('the process of a session', () => {
  const stat = (name: string, parent = 4100, start = '987654'): string =>
    `4242 (${name}) S ${parent} 4242 4100 34816 4242 4194304 1 2 3 4 5 6 7 8 20 0 12 0 ${start} 1000 2000 18446744073709551615`;

  it('finds the start time and the parent in /proc/<pid>/stat', () => {
    expect(procStartOf(stat('claude'))).toBe('987654');
    expect(parentOf(stat('claude'))).toBe(4100);
  });

  it('is not fooled by a process name with spaces and brackets', () => {
    expect(procStartOf(stat('a) R 1 (b c'))).toBe('987654');
    expect(parentOf(stat('a) R 1 (b c'))).toBe(4100);
  });

  it('has no parent at the top', () => {
    expect(parentOf(stat('systemd', 1))).toBeNull();
    expect(parentOf(stat('init', 0))).toBeNull();
  });

  it('is null for anything else', () => {
    expect(procStartOf('')).toBeNull();
    expect(procStartOf('4242 (claude) S 1')).toBeNull();
    expect(parentOf('nonsense')).toBeNull();
  });

  it('is alive when the start time is the one of the file', () => {
    expect(isAlive(file(), stat('claude'))).toBe(true);
  });

  it('is gone without a process, or when the pid belongs to another one', () => {
    expect(isAlive(file(), null)).toBe(false);
    expect(isAlive(file(), stat('bash', 4100, '999999'))).toBe(false);
  });

  it('is believed when there is nothing to compare', () => {
    expect(isAlive(file({ procStart: undefined }), stat('claude'))).toBe(true);
    expect(isAlive(file(), 'not a stat line')).toBe(true);
  });
});

describe('doneAtOf', () => {
  it('is null while the session works or waits', () => {
    expect(doneAtOf(file(), undefined)).toBeNull();
    expect(doneAtOf(file({ status: 'waiting', waitingFor: 'input needed' }), undefined)).toBeNull();
  });

  it('is the moment the status became idle', () => {
    const before = { file: file(), doneAt: null };
    const idle = file({ status: 'idle', statusUpdatedAt: T0 + 60_000 });
    expect(doneAtOf(idle, before)).toBe(T0 + 60_000);
  });

  it('stays what it was while an idle session is written again', () => {
    const idle = file({ status: 'idle', statusUpdatedAt: T0 + 60_000 });
    const renamed = file({ status: 'idle', statusUpdatedAt: T0 + 60_000, name: 'Another name' });
    expect(doneAtOf(renamed, { file: idle, doneAt: T0 + 60_000 })).toBe(T0 + 60_000);
  });

  it('does not take a closed dialog for a finished turn', () => {
    const idle = file({ status: 'idle', statusUpdatedAt: T0 + 100 });
    const dialog = file({
      status: 'waiting',
      waitingFor: 'dialog open',
      statusUpdatedAt: T0 + 90_000,
    });
    const closed = file({ status: 'idle', statusUpdatedAt: T0 + 95_000 });
    expect(doneAtOf(idle, undefined)).toBeNull();
    expect(doneAtOf(dialog, { file: idle, doneAt: null })).toBeNull();
    expect(doneAtOf(closed, { file: dialog, doneAt: null })).toBeNull();
  });

  it('takes an idle session seen for the first time as finished when its status changed', () => {
    const idle = file({ status: 'idle', statusUpdatedAt: T0 + 60_000 });
    expect(doneAtOf(idle, undefined)).toBe(T0 + 60_000);
  });

  it('but not one that has not worked since it started', () => {
    expect(doneAtOf(file({ status: 'idle', statusUpdatedAt: T0 + 300 }), undefined)).toBeNull();
    expect(
      doneAtOf(file({ status: 'idle', statusUpdatedAt: undefined, updatedAt: undefined })),
    ).toBeNull();
  });

  it('starts again for another session in the same process', () => {
    const before = { file: file({ status: 'idle' }), doneAt: T0 + 8000 };
    const next = file({ sessionId: 'another', status: 'idle', statusUpdatedAt: T0 + 200 });
    expect(doneAtOf(next, before)).toBeNull();
  });
});

describe('projectDir and projectName', () => {
  it('turns everything but letters and digits into dashes', () => {
    expect(projectDir('/home/ada/code/light_house.v2')).toBe('-home-ada-code-light-house-v2');
    expect(projectDir('/srv/Größe 9')).toBe('-srv-Gr--e-9');
  });
  it('is null for a relative path and for one too long to be kept whole', () => {
    expect(projectDir('')).toBeNull();
    expect(projectDir('?')).toBeNull();
    expect(projectDir(`/${'a'.repeat(200)}`)).toBeNull();
    expect(projectDir(`/${'a'.repeat(199)}`)).toHaveLength(200);
  });
  it('names a project after its directory', () => {
    expect(projectName('/home/ada/code/lighthouse')).toBe('lighthouse');
    expect(projectName('/home/ada/code/lighthouse/')).toBe('lighthouse');
    expect(projectName('/')).toBe('');
    expect(projectName('')).toBe('');
  });
});

// --- the transcript ---

let serial = 0;
const base = (): Record<string, unknown> => ({
  uuid: `line-${++serial}`,
  sessionId: '11111111-2222-3333-4444-555555555555',
  isSidechain: false,
  timestamp: '2027-01-15T10:00:00.000Z',
});
const prompt = (content: unknown): string =>
  JSON.stringify({ ...base(), type: 'user', message: { role: 'user', content } });
const says = (text: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ...base(),
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...over,
  });
const calls = (id: string, name: string, input: unknown, over = {}): string =>
  JSON.stringify({
    ...base(),
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    ...over,
  });
const result = (id: string): string =>
  JSON.stringify({
    ...base(),
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });
const title = (kind: 'custom-title' | 'ai-title', text: string): string =>
  JSON.stringify(
    kind === 'custom-title'
      ? { type: kind, customTitle: text, sessionId: 's' }
      : { type: kind, aiTitle: text, sessionId: 's' },
  );
const tail = (...lines: string[]): ReturnType<typeof parseTail> =>
  parseTail(`${lines.join('\n')}\n`, true);

describe('parseTail', () => {
  it('finds the last text of the assistant', () => {
    const found = tail(
      prompt('Draw the harbour'),
      says('I will start with the quay.'),
      calls('t1', 'Bash', { command: 'make map' }),
      result('t1'),
      says('The map is drawn.\nTwo piers are missing.'),
    );
    expect(found.lastMessage).toBe('The map is drawn. Two piers are missing.');
    expect(found.pending).toBeNull();
  });

  it('skips thinking, tool calls and lines of subagents', () => {
    const found = tail(
      says('From the main session.'),
      JSON.stringify({
        ...base(),
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] },
      }),
      says('From a subagent.', { isSidechain: true }),
    );
    expect(found.lastMessage).toBe('From the main session.');
  });

  it('is empty for an empty or foreign file', () => {
    expect(parseTail('', true)).toEqual(EMPTY_TAIL);
    expect(parseTail('\n\n', true)).toEqual(EMPTY_TAIL);
    expect(
      parseTail('not json\n{"type":"assistant"}\n{"type":"assistant","message":7}\n', true),
    ).toEqual(EMPTY_TAIL);
    expect(
      parseTail('{"type":"assistant","message":{"content":"text, not blocks"}}\n[1,2]\n', true),
    ).toEqual(EMPTY_TAIL);
  });

  it('drops the first line when the text does not start at the beginning of the file', () => {
    const cut = `${says('An older message.').slice(40)}\n${prompt('And now?')}\n`;
    expect(parseTail(cut, false).lastMessage).toBe('');
    // Even a first line that happens to be whole may be the end of a longer one.
    expect(parseTail(`${says('Whole by chance.')}\n`, false).lastMessage).toBe('');
    expect(parseTail(`${says('Whole by chance.')}\n`, true).lastMessage).toBe('Whole by chance.');
  });

  it('copes with a last line that is still being written', () => {
    const found = parseTail(`${says('Complete.')}\n${says('Half').slice(0, 30)}`, true);
    expect(found.lastMessage).toBe('Complete.');
  });

  it('shortens a long message and removes what cannot be seen', () => {
    const found = tail(says(`a\u200Bb\u202Ec ${'word '.repeat(400)}`));
    expect(found.lastMessage.startsWith('abc word word')).toBe(true);
    expect(found.lastMessage).toHaveLength(600);
    expect(found.lastMessage.endsWith('…')).toBe(true);
  });

  it('reads the title, the one of the user before the generated one', () => {
    expect(tail(title('ai-title', 'Tide tables'), says('x')).title).toBe('Tide tables');
    expect(
      tail(title('custom-title', 'My name'), title('ai-title', 'Tide tables'), says('x')).title,
    ).toBe('My name');
    expect(tail(title('ai-title', 'Old'), title('ai-title', 'New')).title).toBe('New');
    expect(tail('{"type":"custom-title","customTitle":42}').title).toBe('');
  });

  describe('the tool call that waits', () => {
    it('is the one without a result', () => {
      const found = tail(
        prompt('Clean up'),
        calls('t1', 'Read', { file_path: '/home/ada/code/lighthouse/Makefile' }),
        result('t1'),
        calls('t2', 'Bash', { command: 'rm -rf   build\n  && make' }),
      );
      expect(found.pending).toEqual({ kind: 'command', detail: 'rm -rf build && make' });
    });

    it('is a file for the tools that take a path', () => {
      expect(
        tail(calls('t1', 'Write', { file_path: '/tmp/quay.txt', content: 'x' })).pending,
      ).toEqual({ kind: 'file', detail: '/tmp/quay.txt' });
      expect(tail(calls('t1', 'NotebookEdit', { notebook_path: '/tmp/a.ipynb' })).pending).toEqual({
        kind: 'file',
        detail: '/tmp/a.ipynb',
      });
    });

    it('is the address or the name of the tool for anything else', () => {
      expect(tail(calls('t1', 'WebFetch', { url: 'https://example.org/tides' })).pending).toEqual({
        kind: 'other',
        detail: 'https://example.org/tides',
      });
      expect(tail(calls('t1', 'mcp__harbour__open_gate', { gate: 3 })).pending).toEqual({
        kind: 'other',
        detail: 'mcp__harbour__open_gate',
      });
      expect(tail(calls('t1', 'Odd', 'not an object')).pending).toEqual({
        kind: 'other',
        detail: 'Odd',
      });
    });

    it('is unknown when more than one call is open', () => {
      const found = tail(
        calls('t1', 'Bash', { command: 'make a' }),
        calls('t2', 'Bash', { command: 'make b' }),
      );
      expect(found.pending).toBeNull();
    });

    it('is not a call of an older turn', () => {
      const found = tail(
        calls('t0', 'Bash', { command: 'sleep 100' }),
        prompt('Never mind, do this'),
        says('Sure.'),
      );
      expect(found.pending).toBeNull();
    });

    it('is not what a subagent was started with, nor a call of a subagent', () => {
      expect(tail(calls('t1', 'Agent', { prompt: 'look around' })).pending).toBeNull();
      expect(tail(calls('t1', 'Task', { prompt: 'look around' })).pending).toBeNull();
      expect(tail(calls('t1', 'Bash', { command: 'ls' }, { isSidechain: true })).pending).toBe(
        null,
      );
    });

    it('survives lines that are put in between', () => {
      const found = tail(
        prompt([{ type: 'text', text: 'Go' }]),
        calls('t1', 'Bash', { command: 'make' }),
        JSON.stringify({ ...base(), type: 'user', isMeta: true, message: { content: 'note' } }),
        JSON.stringify({ type: 'attachment', attachment: { type: 'x' } }),
      );
      expect(found.pending).toEqual({ kind: 'command', detail: 'make' });
    });

    it('has no name and no input it could trust', () => {
      const odd = JSON.stringify({
        ...base(),
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 5 }] },
      });
      expect(tail(odd).pending).toBeNull();
    });
  });
});

// --- what is shown ---

const known = (over: Record<string, unknown> = {}, extra: Partial<Known> = {}): Known => ({
  file: file(over),
  doneAt: null,
  tail: EMPTY_TAIL,
  ...extra,
});

describe('sessionsOf', () => {
  const now = T0 + 100_000;

  it('shows a working session with its name and project', () => {
    expect(sessionsOf([known()], now)).toEqual([
      {
        id: '4242',
        sessionId: '11111111-2222-3333-4444-555555555555',
        title: 'Harbour map',
        project: 'lighthouse',
        phase: 'working',
        since: T0 + 8000,
        until: null,
        lastMessage: '',
        pending: null,
      },
    ]);
  });

  it('names a session after the transcript, then after the project', () => {
    const tailed = { ...EMPTY_TAIL, title: 'Tide tables' };
    expect(sessionsOf([known({ name: undefined }, { tail: tailed })], now)[0]!.title).toBe(
      'Tide tables',
    );
    expect(sessionsOf([known({ name: undefined })], now)[0]!.title).toBe('lighthouse');
    expect(sessionsOf([known({ name: undefined, cwd: undefined })], now)[0]!.title).toBe('');
  });

  it('tells the phases apart', () => {
    const phase = (over: Record<string, unknown>): string =>
      sessionsOf([known({ status: 'waiting', ...over })], now)[0]!.phase;
    expect(phase({ waitingFor: 'permission prompt' })).toBe('approval');
    expect(phase({ waitingFor: 'input needed' })).toBe('question');
    expect(phase({ waitingFor: 'something new' })).toBe('waiting');
    expect(sessionsOf([known({ status: 'waiting', waitingFor: 'input needed' })], now)).toSatisfy(
      (sessions: ReturnType<typeof sessionsOf>) => sessions.every(isWaiting),
    );
  });

  it('shows what an approval is about, and only then', () => {
    const pending = { kind: 'command' as const, detail: 'make map' };
    const tailed = { ...EMPTY_TAIL, lastMessage: 'Shall I?', pending };
    const approval = known(
      { status: 'waiting', waitingFor: 'permission prompt' },
      { tail: tailed },
    );
    expect(sessionsOf([approval], now)[0]).toMatchObject({ pending, lastMessage: 'Shall I?' });
    expect(sessionsOf([known({}, { tail: tailed })], now)[0]!.pending).toBeNull();
    const question = known({ status: 'waiting', waitingFor: 'input needed' }, { tail: tailed });
    expect(sessionsOf([question], now)[0]!.pending).toBeNull();
  });

  it('keeps a finished session for two minutes', () => {
    const done = known({ status: 'idle' }, { doneAt: T0 });
    expect(sessionsOf([done], T0 + DONE_MS - 1)[0]).toMatchObject({
      phase: 'done',
      since: T0,
      until: T0 + DONE_MS,
    });
    expect(sessionsOf([done], T0 + DONE_MS)).toEqual([]);
  });

  it('has no row for a session at rest', () => {
    expect(sessionsOf([known({ status: 'idle' })], now)).toEqual([]);
  });

  it('puts the waiting ones first, then the working ones, then the finished ones', () => {
    const list = [
      known({ status: 'idle' }, { doneAt: T0 + 90_000 }),
      known({ statusUpdatedAt: T0 + 1000 }),
      known({ status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: T0 + 5 }),
      known({ statusUpdatedAt: T0 + 2000 }),
      known({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: T0 + 9 }),
    ].map((entry, index) => ({ ...entry, file: { ...entry.file, pid: index + 1 } }));
    expect(sessionsOf(list, now).map(session => session.id)).toEqual(['5', '3', '4', '2', '1']);
  });
});

describe('visibleSessions', () => {
  const list = sessionsOf(
    [1, 2, 3, 4, 5].map(pid => ({ ...known(), file: { ...file(), pid } })),
    T0,
  );
  it('shows three and counts the rest', () => {
    expect(visibleSessions(list, false)).toMatchObject({ more: 2, shown: { length: 3 } });
    expect(visibleSessions(list.slice(0, 3), false).more).toBe(0);
  });
  it('shows all when asked', () => {
    expect(visibleSessions(list, true)).toMatchObject({ more: 0, shown: { length: 5 } });
  });
});

describe('clean', () => {
  it('is empty for anything that is no text', () => {
    expect(clean(undefined, 10)).toBe('');
    expect(clean({ text: 'x' }, 10)).toBe('');
  });
  it('cuts with an ellipsis', () => {
    expect(clean('abcdefghij', 5)).toBe('abcd…');
  });
});
