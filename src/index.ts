#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import "dotenv/config";
import OpenAI from "openai";
import { htmlToText } from "./utils/html-to-text.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

function usage(): never {
  console.error(
    "Usage: summarize --prompt <1|2|3> --file <name.html>\n" +
      "  -p, --prompt   Prompt variant to use (1, 2, or 3)\n" +
      "  -f, --file     Newsletter HTML file in data/ (name or path)",
  );
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    prompt: { type: "string", short: "p" },
    file: { type: "string", short: "f" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help || !values.prompt || !values.file) usage();

const promptId = values.prompt!;
if (!["1", "2", "3"].includes(promptId)) {
  console.error(`Invalid --prompt "${promptId}". Must be 1, 2, or 3.`);
  process.exit(1);
}

const fileArg = values.file!;
const filePath = fileArg.includes("/")
  ? resolve(fileArg)
  : join(projectRoot, "data", fileArg);

const promptPath = join(
  projectRoot,
  "src",
  "prompts",
  `summarize-${promptId}.prompt.md`,
);

const promptTemplate = readFileSync(promptPath, "utf8");
const newsletterHtml = readFileSync(filePath, "utf8");
const newsletter = htmlToText(newsletterHtml);
const prompt = promptTemplate.includes("{{newsletter_content}}")
  ? promptTemplate.replace("{{newsletter_content}}", newsletter)
  : `${promptTemplate}\n\n${newsletter}`;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY missing. Set it in .env");
  process.exit(1);
}

const client = new OpenAI({ apiKey });
const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const response = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: prompt }],
  response_format: { type: "json_object" },
});

const content = response.choices[0]?.message?.content ?? "";
try {
  console.log(JSON.stringify(JSON.parse(content), null, 2));
} catch {
  console.log(content);
}
