export class AmikaError extends Error {
  override name = "AmikaError";
}

export interface CommandFailureDetails {
  args: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export class AmikaCommandError extends AmikaError {
  override name = "AmikaCommandError";
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, details: CommandFailureDetails) {
    super(message);
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
  }
}

export class AmikaBinaryNotFoundError extends AmikaError {
  override name = "AmikaBinaryNotFoundError";
  readonly binary: string;

  constructor(binary: string, cause?: unknown) {
    super(`amika binary not found or not executable: ${binary}`, { cause });
    this.binary = binary;
  }
}
