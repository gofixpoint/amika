/** The operator-prompt contract shared by `up` and `setup`. */

/**
 * Ask the operator a question; resolves to `undefined` on end of input
 * (Ctrl-D) and rejects with `PromptCancelled` on Ctrl-C.
 */
export type Prompt = (question: string) => Promise<string | undefined>;

/** The operator pressed Ctrl-C at a prompt; the command stops there. */
export class PromptCancelled extends Error {
  override name = "PromptCancelled";
}
