// Custom promptfoo provider.
// Docs: https://www.promptfoo.dev/docs/providers/custom-api/
//
// A provider's job is to take a prompt + vars and return an output to grade.
// Built-in providers (e.g. `openai:chat:gpt-4o-mini`) call the LLM directly
// with the rendered prompt — fine if the prompt IS the whole pipeline.
//
// Our pipeline is more than just a prompt: it reads HTML, strips tags, then
// substitutes the cleaned text into a template. To eval the real behavior we
// reuse the same `summarize()` used by the CLI. That way prompt evals also
// catch regressions in htmlToText / template assembly, not just wording.
//
// Promptfoo loads this file (because promptfooconfig.yaml has
// `id: file://evals/provider.ts`) and invokes `callApi()` once per
// (prompt × test) combination.

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { summarize, type PromptId } from "../src/summarize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Shape promptfoo passes in. We only need `vars` here — the rendered `prompt`
// string is ignored because our provider reconstructs the prompt itself from
// `vars.promptId` so the eval exercises the same code path as the CLI.
interface ProviderContext {
  vars: Record<string, string>;
}

// Shape promptfoo expects back. `output` is what assertions grade against.
// `tokenUsage` / `cost` / `error` are optional but show up in the viewer.
interface ProviderResponse {
  output?: string;
  error?: string;
}

export default class NewsletterSummarizerProvider {
  id() {
    return "newsletter-summarizer";
  }

  async callApi(
    _prompt: string,
    context: ProviderContext,
  ): Promise<ProviderResponse> {
    const promptId = context.vars.promptId as PromptId;
    const file = context.vars.file;

    if (!promptId || !file) {
      return { error: "Missing required vars: promptId and file" };
    }

    const htmlPath = join(projectRoot, "data", file);

    try {
      const html = readFileSync(htmlPath, "utf8");
      const { raw } = await summarize({ promptId, html });
      return { output: raw };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
