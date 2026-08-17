/**
 * Test-only fake of the Daytona `process` surface.
 *
 * `commands.ts` runs ordinary commands through the one-shot `executeCommand`
 * and stdin-carrying ones through a session (see there for why), so this fake
 * models both and records every command in the order it ran.
 *
 * The one-shot half reproduces the property the code under test exists to work
 * around: the real API reports a *single* combined `result` string. So the fake
 * concatenates the scripted stdout, the stream marker it finds in the script it
 * was handed, and the scripted stderr — and leaves `commands.ts` to cut them
 * apart again. A test that gets its two streams back has exercised the split,
 * not a stub of it.
 *
 * Deliberately free of any test-framework import so it stays a plain module.
 */

/** The delimiter `buildStreamSplitCommand` emits between the two streams. */
const STREAM_MARKER_RE = /--amika-stderr-[0-9a-fA-F-]+--/u;

export interface FakeCommand {
  /** The full on-box command string the sandbox was asked to run. */
  command: string;
  /** Working directory, when the caller passed one (one-shot path only). */
  cwd?: string;
  /** Environment, when the caller passed one (one-shot path only). */
  env?: Record<string, string>;
  /** Bytes sent to the command's stdin, when the caller passed input. */
  input?: string;
}

export interface FakeResponse {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface FakeDaytonaSandbox {
  /** Pass where a Daytona `Sandbox` is expected. */
  sandbox: unknown;
  /** Every command run, in order, across both paths. */
  commands: FakeCommand[];
  /**
   * Sessions currently open. Empty after an ordinary command, which must not
   * open one at all — a session owns its processes and kills them on delete.
   */
  openSessions: Set<string>;
}

/**
 * Build a fake sandbox whose commands resolve to `respond(command)`, defaulting
 * to a clean zero-exit with empty streams. `command` is the full on-box string,
 * so a caller can key its response off the command it recognizes.
 */
export function fakeDaytonaSandbox(
  respond: (command: string) => FakeResponse = () => ({}),
): FakeDaytonaSandbox {
  const commands: FakeCommand[] = [];
  const openSessions = new Set<string>();
  let response: FakeResponse = {};

  const process = {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
    ): Promise<{ exitCode: number; result: string }> {
      commands.push({ command, cwd, env });
      response = respond(command);
      const marker = STREAM_MARKER_RE.exec(command)?.[0] ?? "";
      return Promise.resolve({
        exitCode: response.exitCode ?? 0,
        result: `${response.stdout ?? ""}${marker}${response.stderr ?? ""}`,
      });
    },
    createSession(sessionId: string): Promise<void> {
      openSessions.add(sessionId);
      return Promise.resolve();
    },
    // Only the stdin path reaches a session, and it always runs detached, so a
    // session command reports just the id and its streams arrive via the logs.
    executeSessionCommand(
      _sessionId: string,
      request: { command: string },
    ): Promise<{ cmdId: string }> {
      commands.push({ command: request.command });
      response = respond(request.command);
      return Promise.resolve({ cmdId: `cmd-${commands.length}` });
    },
    sendSessionCommandInput(
      _sessionId: string,
      _cmdId: string,
      input: string,
    ): Promise<void> {
      commands[commands.length - 1]!.input = input;
      return Promise.resolve();
    },
    getSessionCommandLogs(
      _sessionId: string,
      _cmdId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<void> {
      if (response.stdout) onStdout(response.stdout);
      if (response.stderr) onStderr(response.stderr);
      return Promise.resolve();
    },
    getSessionCommand(): Promise<{ exitCode: number }> {
      return Promise.resolve({ exitCode: response.exitCode ?? 0 });
    },
    deleteSession(sessionId: string): Promise<void> {
      openSessions.delete(sessionId);
      return Promise.resolve();
    },
  };

  return { sandbox: { process }, commands, openSessions };
}
