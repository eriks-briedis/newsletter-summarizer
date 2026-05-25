// Shared assertion helpers for promptfoo.
//
// Each exported function is referenced from promptfooconfig.yaml like:
//   - type: javascript
//     value: file://evals/assertions.ts:matchesSchema
//
// Contract: receive the model output string, throw with a useful message
// to fail (promptfoo surfaces `.message`), or return true to pass. You can
// also return `{ pass, score, reason }` for partial credit.

import { z } from "zod";
import { GOLD_TOPICS } from "./gold-standard.js";

const READ_PRIORITIES = ["skip", "skim", "read", "deep-read"] as const;

// Single source of truth for the expected output shape. Adding a field here
// (or tightening a constraint) automatically tightens the eval — much less
// error-prone than maintaining five hand-rolled checks in YAML.
const ArticleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  is_sponsored: z.boolean(),
  tldr: z.string().min(1),
  key_points: z.array(z.string().min(1)),
  topics: z.array(z.string().min(1)),
  read_priority: z.enum(READ_PRIORITIES),
});

const NewsletterSchema = z.object({
  newsletter: z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    published_at: z.string().min(1),
    article_count: z.number().int().nonnegative(),
    sponsored_count: z.number().int().nonnegative(),
    articles: z.array(ArticleSchema),
  }),
});

type Newsletter = z.infer<typeof NewsletterSchema>;

// Promptfoo's GradingResult shape. Returning this (rather than throwing) keeps
// the row's status as a normal pass/fail so other assertions still run and
// show up in the viewer — a thrown error marks the row ERROR and skips the
// rest of the asserts.
interface Result {
  pass: boolean;
  score: number;
  reason: string;
}
const ok = (reason = "ok"): Result => ({ pass: true, score: 1, reason });
const fail = (reason: string): Result => ({ pass: false, score: 0, reason });

type ParseResult =
  | { ok: true; data: Newsletter }
  | { ok: false; reason: string };

function tryParse(output: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch (err) {
    return { ok: false, reason: `output is not valid JSON: ${(err as Error).message}` };
  }
  const result = NewsletterSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, reason: `schema mismatch:\n${z.prettifyError(result.error)}` };
  }
  return { ok: true, data: result.data };
}

// For asserts that can't meaningfully grade unparseable output: skip with a
// pass so the grid only surfaces the real failure (which matchesSchema /
// is-json will already report).
const SKIP_UNPARSEABLE = ok("skipped: output not parseable (see matchesSchema)");

// Structural validation: shape, types, URL format, enum values — all in one.
// Replaces several hand-rolled `javascript` asserts.
export function matchesSchema(output: string): Result {
  const p = tryParse(output);
  return p.ok ? ok("schema valid") : fail(p.reason);
}

// Self-consistency: declared counts must match the actual articles array.
// Catches off-by-one hallucinations where the model invents a count.
export function countsMatch(output: string): Result {
  const p = tryParse(output);
  if (!p.ok) return SKIP_UNPARSEABLE;
  const n = p.data.newsletter;
  const errs: string[] = [];
  if (n.article_count !== n.articles.length) {
    errs.push(
      `article_count ${n.article_count} != articles.length ${n.articles.length}`,
    );
  }
  const sponsored = n.articles.filter((a) => a.is_sponsored).length;
  if (n.sponsored_count !== sponsored) {
    errs.push(`sponsored_count ${n.sponsored_count} != actual ${sponsored}`);
  }
  return errs.length ? fail(errs.join("; ")) : ok("counts match");
}

// Each article's `tldr` should be a single sentence. Heuristic: split on
// sentence-terminating punctuation followed by whitespace + a capital
// letter (which avoids tripping on "U.S." or "v1.2"). More than one
// resulting chunk = multiple sentences.
export function tldrIsOneSentence(output: string): Result {
  const p = tryParse(output);
  if (!p.ok) return SKIP_UNPARSEABLE;
  const splitter = /[.!?]\s+(?=[A-Z])/;
  const offenders: string[] = [];
  for (const a of p.data.newsletter.articles) {
    const tldr = a.tldr.trim();
    const sentences = tldr.split(splitter).filter((s) => s.length > 0);
    if (sentences.length > 1) {
      offenders.push(`${a.id} (${sentences.length} sentences): ${tldr}`);
    }
  }
  return offenders.length
    ? fail(`multi-sentence tldrs:\n${offenders.join("\n")}`)
    : ok("all tldrs single-sentence");
}

// Reject filler phrases that add words but no information. Checked across
// every `tldr` and `key_points` entry. Add to this list as you spot new
// offenders in the viewer.
const BANNED_PHRASES = [
  /\bin this newsletter\b/i,
  /\bthe author discusses\b/i,
  /\bstay tuned\b/i,
  /\bthis article (talks about|covers|discusses)\b/i,
  /\bclick (here|the link)\b/i,
  /\bread (more|on)\b/i,
];

export function noBannedPhrases(output: string): Result {
  const p = tryParse(output);
  if (!p.ok) return SKIP_UNPARSEABLE;
  const hits: string[] = [];
  for (const a of p.data.newsletter.articles) {
    const haystacks = [a.tldr, ...a.key_points];
    for (const text of haystacks) {
      for (const re of BANNED_PHRASES) {
        if (re.test(text)) {
          hits.push(`${a.id}: ${re} in "${text}"`);
        }
      }
    }
  }
  return hits.length
    ? fail(`banned phrases:\n${hits.join("\n")}`)
    : ok("no banned phrases");
}

// Bag-of-words cosine similarity. Cheap and offline — no embeddings call.
// Good enough to catch near-duplicate titles/summaries; for paraphrase-level
// duplicates you'd want a real embedding model.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2); // drop "a", "of", "is", ...
}

function cosineSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const freq = (tokens: string[]) => {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const fa = freq(ta);
  const fb = freq(tb);

  let dot = 0;
  for (const [tok, count] of fa) {
    const other = fb.get(tok);
    if (other) dot += count * other;
  }
  const mag = (m: Map<string, number>) =>
    Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0));
  return dot / (mag(fa) * mag(fb));
}

const DEDUP_THRESHOLD = 0.85;

// Fail if any two articles are near-duplicates by title OR by tldr.
// Common failure mode: the model summarizes the same story twice when an
// item is mentioned under multiple sections.
export function dedupCheck(output: string): Result {
  const p = tryParse(output);
  if (!p.ok) return SKIP_UNPARSEABLE;
  const articles = p.data.newsletter.articles;
  const dups: string[] = [];
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const titleSim = cosineSimilarity(articles[i].title, articles[j].title);
      const tldrSim = cosineSimilarity(articles[i].tldr, articles[j].tldr);
      if (titleSim > DEDUP_THRESHOLD || tldrSim > DEDUP_THRESHOLD) {
        dups.push(
          `${articles[i].id} vs ${articles[j].id} ` +
            `(title=${titleSim.toFixed(2)}, tldr=${tldrSim.toFixed(2)})`,
        );
      }
    }
  }
  return dups.length
    ? fail(`near-duplicates:\n${dups.join("\n")}`)
    : ok("no near-duplicates");
}

// Compare the model's `topics` against a hand-annotated gold standard.
// Score = mean recall across articles that have a gold entry (recall =
// fraction of gold topics that appear, case-insensitive, in the model's
// topic list). Articles without a gold entry are skipped so the eval can
// be added per-fixture without forcing 100% coverage.
//
// Returns a promptfoo GradingResult so we get a numeric score in the
// viewer — handy for ranking prompt variants. Threshold is set per
// assertion in the YAML via `threshold:`.
//
// Signature `(output, context)` is what promptfoo passes to file://
// javascript assertions. `context.vars.file` tells us which fixture to
// look up in GOLD_TOPICS.
interface AssertContext {
  vars: { file?: string; [k: string]: unknown };
}

function norm(t: string): string {
  return t.toLowerCase().trim();
}

export function topicsMatchGoldStandard(
  output: string,
  context: AssertContext,
): Result {
  const file = context.vars.file;
  const gold = file ? GOLD_TOPICS[file] : undefined;
  if (!gold) {
    // No gold standard for this fixture — pass with score 1 so the eval
    // doesn't penalize fixtures we haven't annotated yet.
    return ok(`no gold standard for ${file}`);
  }

  const p = tryParse(output);
  if (!p.ok) return SKIP_UNPARSEABLE;
  const n = p.data.newsletter;
  const articleByUrl = new Map(n.articles.map((a) => [a.url, a]));

  const perArticle: { url: string; recall: number; missing: string[] }[] = [];
  for (const [url, goldTopics] of Object.entries(gold)) {
    const article = articleByUrl.get(url);
    if (!article) {
      perArticle.push({ url, recall: 0, missing: goldTopics });
      continue;
    }
    const modelTopics = new Set(article.topics.map(norm));
    const hits = goldTopics.filter((t) => modelTopics.has(norm(t)));
    const missing = goldTopics.filter((t) => !modelTopics.has(norm(t)));
    perArticle.push({
      url,
      recall: hits.length / goldTopics.length,
      missing,
    });
  }

  const meanRecall =
    perArticle.reduce((s, a) => s + a.recall, 0) / perArticle.length;

  // Default pass bar: recall >= 0.5. Override per-row with `threshold:`.
  const pass = meanRecall >= 0.5;
  const worst = perArticle
    .filter((a) => a.recall < 1)
    .sort((a, b) => a.recall - b.recall)
    .slice(0, 3)
    .map((a) => `  ${a.url}: missing [${a.missing.join(", ")}]`)
    .join("\n");

  return {
    pass,
    score: meanRecall,
    reason:
      `mean topic recall vs gold = ${meanRecall.toFixed(2)} ` +
      `(${perArticle.length} annotated articles)` +
      (worst ? `\nworst misses:\n${worst}` : ""),
  };
}

// Fixture-specific source check stays inline in tests.yaml (per-row
// `icontains` assert) — the expected source name lives next to the fixture
// it applies to, and a factory here would be overkill for a substring match.
