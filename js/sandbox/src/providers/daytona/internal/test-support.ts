/**
 * Test-only fake of the Daytona `process` session surface.
 *
 * Daytona commands run through a throwaway session (see `commands.ts`) so the
 * two output streams stay separate, which means a test can no longer stub a
 * single `process.executeCommand`. This fake records each session command and
 * replays scripted stdout/stderr/exit codes. Deliberately free of any test-
 * framework import so it stays a plain module.
 */

export interface FakeSessionCommand {
  /** The full on-box command string the session was asked to run. */
  command: string;
  /** Bytes sent to the command's stdin, when the caller passed input. */
  input?: string;
}

export interface FakeSessionResponse {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface FakeDaytonaSandbox {
  /** Pass where a Daytona `Sandbox` is expected. */
  sandbox: unknown;
  /** Every session command run, in order. */
  commands: FakeSessionCommand[];
  /** Sessions created but never deleted; non-empty means a leak. */
  openSessions: Set<string>;
}

/**
 * Build a fake sandbox whose session commands resolve to `respond(command)`,
 * defaulting to a clean zero-exit with empty streams. One command per session,
 * matching how `commands.ts` uses the API.
 */
export function fakeDaytonaSandbox(
  respond: (command: string) => FakeSessionResponse = () => ({}),
): FakeDaytonaSandbox {
  const commands: FakeSessionCommand[] = [];
  const openSessions = new Set<string>();
  let response: FakeSessionResponse = {};

  const process = {
    createSession(sessionId: string): Promise<void> {
      openSessions.add(sessionId);
      return Promise.resolve();
    },
    executeSessionCommand(
      _sessionId: string,
      request: { command: string; runAsync?: boolean },
    ): Promise<{
      cmdId: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    }> {
      commands.push({ command: request.command });
      response = respond(request.command);
      const cmdId = `cmd-${commands.length}`;
      // A detached run reports only the id; a synchronous one carries the
      // finished command's streams, exactly as the Daytona API does.
      return Promise.resolve(
        request.runAsync
          ? { cmdId }
          : {
              cmdId,
              exitCode: response.exitCode ?? 0,
              stdout: response.stdout ?? "",
              stderr: response.stderr ?? "",
            },
      );
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
