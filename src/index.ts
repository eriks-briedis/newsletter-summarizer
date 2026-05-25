#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import "dotenv/config";
import { summarize, type PromptId } from "./summarize.js";

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

const html = readFileSync(filePath, "utf8");

const { raw, json } = await summarize({
  promptId: promptId as PromptId,
  html,
});

console.log(json ? JSON.stringify(json, null, 2) : raw);
