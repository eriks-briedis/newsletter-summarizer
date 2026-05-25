import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { htmlToText } from "./utils/html-to-text.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

export type PromptId = "1" | "2" | "3";

export interface SummarizeOptions {
  promptId: PromptId;
  html: string;
  model?: string;
  apiKey?: string;
}

export interface SummarizeResult {
  raw: string;
  json: unknown | null;
}

export function loadPromptTemplate(promptId: PromptId): string {
  const promptPath = join(
    projectRoot,
    "src",
    "prompts",
    `summarize-${promptId}.prompt.md`,
  );
  return readFileSync(promptPath, "utf8");
}

export function buildPrompt(promptTemplate: string, html: string): string {
  const newsletter = htmlToText(html);
  return promptTemplate.includes("{{newsletter_content}}")
    ? promptTemplate.replace("{{newsletter_content}}", newsletter)
    : `${promptTemplate}\n\n${newsletter}`;
}

export async function summarize(
  options: SummarizeOptions,
): Promise<SummarizeResult> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const promptTemplate = loadPromptTemplate(options.promptId);
  const prompt = buildPrompt(promptTemplate, options.html);

  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content ?? "";
  let json: unknown | null = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { raw, json };
}
