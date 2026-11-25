import { ApiError, visibleLines } from "./api.ts";
import type { Env } from "./config.ts";

/** Everything a command touches outside itself, so tests can stand in for it. */
export type Io = {
  out(text: string): void;
  err(text: string): void;
  /** Writes text as it is, with no newline added: hook answers are exact. */
  write(text: string): void;
  writeErr(text: string): void;
  env: Env;
  home: string;
  /** The folder the command runs in: a project's commands work there. */
  cwd: string;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
  /** Whether a person is at a terminal to answer questions. */
  interactive: boolean;
  ask(question: string, options?: { hidden?: boolean }): Promise<string>;
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  /** Waits between polls; false means stop. */
  sleep(ms: number): Promise<boolean>;
  clear(): void;
  /** How to run this command line again, for a detached child: by default, this script. */
  self?: string[];
};

/** Something the person asked for that can't be done, said plainly. */
export class UsageError extends Error {
  readonly exitCode = 2;
}

export class CliError extends Error {
  readonly exitCode = 1;
}

const explanations: Record<string, string> = {
  UNAUTHENTICATED:
    "The token was refused: it is missing, revoked or expired, or you are no longer a member. Run `nodrail login` with a new token.",
  INSUFFICIENT_SCOPE:
    "This token doesn't have the scope this needs. Create a token with it under your account → API tokens.",
  FORBIDDEN: "Your role in this workspace can't do this.",
  NOT_FOUND: "Not found, or you can't see it.",
  RULE_CHANGED:
    "The rules changed since the preview. Pull them again, merge your edits and push again.",
  INVALID_INPUT: "Nodrail refused the request as invalid.",
  RATE_LIMITED: "Too many requests with this token. Wait a minute and retry.",
  VERSION_NOT_RENDERABLE:
    "The live rules use numeric budgets or evidence requirements (engine level 5), which Cloud can't show as a file yet. Keep the rules file you published as the source: edit it and push it again.",
};

/** One line for the person, with the code and request id for support. */
export function describeFailure(error: unknown) {
  if (error instanceof ApiError) {
    const said =
      error.detail ?? explanations[error.code] ?? "Nodrail could not do this.";
    const id = error.requestId ? `, request ${error.requestId}` : "";
    const origin =
      error.origin && (error.status === 401 || error.status === 403)
        ? ` at ${error.origin}`
        : "";
    return visibleLines(`${said} (${error.code}${id})${origin}`);
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export const exitCodeOf = (error: unknown) =>
  error instanceof UsageError ? 2 : 1;

/** Asks a yes/no question; anything but yes is no. */
export async function confirm(io: Io, question: string) {
  const answer = await io.ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}
