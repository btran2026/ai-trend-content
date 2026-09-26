/**
 * The AI layer of the shared backend. This is the whole point of the
 * architecture: one run here, server-side, on one API key, and every AI Trend
 * install reads the result. The app's own BYOK key is reserved for things that
 * are personal (a deep dive, a "why this matters to me") or urgent (ad-hoc
 * research before the next cron tick).
 *
 * Three calls per aggregation run:
 *   1. curate  — batched. Per item: keep/drop, one-line TL;DR, why it matters,
 *                category, importance. This is where most tokens go.
 *   2. brief   — one call over the kept items. Headline, framing, clusters.
 *   3. radar   — one call. Extracts model releases for models/radar.json.
 *
 * Model: claude-opus-5. Override with AGGREGATOR_MODEL if you want to trade
 * quality for spend — see README.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.AGGREGATOR_MODEL || 'claude-opus-5';
const CURATION_BATCH_SIZE = 20;

/**
 * Which way we reach the model.
 *
 *   api     — the Anthropic SDK on ANTHROPIC_API_KEY. What Actions uses. Gets
 *             real structured outputs and the refusal fallback.
 *   cli     — `claude -p` against whatever session you're already logged into,
 *             so a local run bills your subscription instead of API credits.
 *   copilot — `copilot -p` against your GitHub Copilot subscription. Same
 *             motive as `cli`, different subscription — and it opens up the
 *             GPT-5.6 / Gemini tiers for the cheap bulk-curation stage.
 *
 * Auto-selects: a key means api, no key means cli. Actions always has the key,
 * so the hosted path is untouched. Force any of them with AI_BACKEND.
 */
const BACKEND = process.env.AI_BACKEND || (process.env.ANTHROPIC_API_KEY ? 'api' : 'cli');
const CLI_BIN = process.env.CLAUDE_BIN || 'claude';
const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';
const CLI_TIMEOUT_MS = 10 * 60_000;

/** Server-side refusal fallback. Opus 5's safety classifiers can decline a
 * request (HTTP 200, stop_reason "refusal") — AI-security stories are exactly
 * the kind of benign-adjacent content that occasionally trips them. "default"
 * routes by refusal category so we don't maintain a model list. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Lazy: constructing the SDK client is pointless (and needs a key) on the CLI
// path, and `aggregate.mjs --dry-run` imports this module with neither.
let _client = null;
const client = () => (_client ??= new Anthropic());

/** Accumulated across every call in a run; written into the digest's `cost`. */
export const usage = {
  inputTokens: 0,
  outputTokens: 0,
  calls: 0,
  model: MODEL,
  backend: BACKEND,
  /** What the CLI reported this run would have cost. Zero on the API path,
   *  where we price it from token counts instead. */
  reportedUsd: 0,
};

const PRICING = {
  // USD per 1M tokens. Opus 5 rates; edit if AGGREGATOR_MODEL points elsewhere.
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export function estimateUsd() {
  // Copilot reports no token counts and no cost, so there is no honest figure
  // to give. Zero here means "unknown", which the digest marks via billing.
  if (BACKEND === 'copilot') return 0;
  // The CLI reports what each call would have cost at API rates; on a
  // subscription that's notional, not a charge, but it's the honest number to
  // record and it already accounts for cache reads we can't see from here.
  if (BACKEND === 'cli') return usage.reportedUsd;
  const p = PRICING[MODEL] ?? PRICING['claude-opus-5'];
  return (usage.inputTokens / 1e6) * p.in + (usage.outputTokens / 1e6) * p.out;
}

const CATEGORIES = [
  'open-models',
  'closed-models',
  'agentic',
  'adoption',
  'tooling',
  'research',
  'use-cases',
  'business',
  // Added: an item that hands the reader a command, flag, config or repo. This
  // is the category the digest exists for; the app maps unknown values to
  // `other`, so older binaries degrade instead of breaking.
  'technique',
];

/**
 * Who this digest is for. Written once, here, so every call shares it — and so
 * the editorial voice is reviewable in one place rather than smeared across
 * three prompts.
 */
const AUDIENCE = `The reader is a development manager who ships production mobile apps largely solo, using AI coding agents as his team. He runs Claude Code with git worktrees, subagents, hooks and skills, and he is trying to get closer to one thing: describe the work, go to sleep, review a finished pull request in the morning.

What he wants from this digest, in priority order:

1. Techniques he can apply tonight. A flag, a command, a config file, a hook, a repo to clone, a prompt structure. Anything that makes an agent run longer unattended, ask fewer questions, verify its own work, or produce a reviewable PR.
2. Ways to spend less. Routing cheap work to local or open-weight models, prompt caching, batch calls, model tiering per subagent, self-hosted harnesses. Concrete costs and hardware requirements, not leaderboard positions.
3. Controlling agents away from the desk. Phone, voice, chat bridges, remote and cloud sessions, scheduled and event-triggered runs.
4. Honest failure reports. "We ran this unattended for six hours and here is exactly how it broke" is worth more than any launch announcement.

THE TEST FOR EVERY ITEM: after reading it, is there something he can DO? If the answer is "now he knows a fact about a model or a specification", that item is noise no matter how important it sounds.

Concretely, this is what he does NOT want, and what the feed has been failing on:
- Protocol and spec revisions described in terms of their own internals ("the MCP spec makes transport stateless").
- Model releases reported as spec sheets — parameter counts, context windows, MoE architecture, memory footprints, benchmark placings — with no action attached.
- Research papers proposing frameworks nobody has shipped.
- Funding, org and market news.

The same underlying event can be either. "Gemma 3 runs in 2GB of RAM" is a spec sheet. "You can now run a coding-capable model on a 16GB laptop, here is the command" is a technique. Report the second version or drop the item.

He is technical. Do not explain what an LLM is. Do not hedge. He reads this once a day, on a phone.`;

/**
 * One shared JSON-schema helper. Structured outputs reject the numeric/string
 * constraint keywords (minimum, maxLength, …) and require additionalProperties
 * false plus a complete `required` list on every object — so build objects here
 * rather than hand-writing each schema and tripping over it.
 */
export function obj(properties) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export const strArray = { type: 'array', items: { type: 'string' } };

const CURATION_SCHEMA = obj({
  items: {
    type: 'array',
    items: obj({
      id: { type: 'string' },
      keep: { type: 'boolean' },
      tldr: { type: 'string' },
      whyItMatters: { type: 'string' },
      category: { type: 'string', enum: CATEGORIES },
      tags: strArray,
      entities: strArray,
      models: strArray,
      importance: { type: 'integer', enum: [1, 2, 3, 4, 5] },
      // The ranking axis. `importance` measures how consequential a story is,
      // which is why a spec revision used to lead the digest; `actionability`
      // measures whether the reader can do anything about it.
      actionability: { type: 'integer', enum: [1, 2, 3, 4, 5] },
      // The concrete thing to do, or empty. Rendering this under the TL;DR is
      // what turns a headline into a to-do.
      tryThis: { type: 'string' },
      // Set when the item reports something that broke in real use. Boosted on
      // purpose: failure reports are how the reader avoids losing a night.
      hasFailureReport: { type: 'boolean' },
    }),
  },
});

const BRIEF_SCHEMA = obj({
  headline: { type: 'string' },
  summary: { type: 'string' },
  bullets: strArray,
  signals: {
    type: 'array',
    items: obj({
      label: { type: 'string' },
      direction: { type: 'string', enum: ['up', 'down', 'flat'] },
      note: { type: 'string' },
    }),
  },
  clusters: {
    type: 'array',
    items: obj({
      title: { type: 'string' },
      summary: { type: 'string' },
      itemIds: strArray,
    }),
  },
});

const RADAR_SCHEMA = obj({
  models: {
    type: 'array',
    items: obj({
      id: { type: 'string' },
      name: { type: 'string' },
      vendor: { type: 'string' },
      openness: { type: 'string', enum: ['open-weights', 'open-source', 'closed', 'unknown'] },
      license: { type: 'string' },
      // Strings, not integers: structured outputs can't express "integer or
      // null", and "unknown" is a real and common answer here.
      contextTokens: { type: 'string' },
      status: { type: 'string', enum: ['current', 'preview', 'deprecated', 'rumored'] },
      what: { type: 'string' },
      url: { type: 'string' },
    }),
  },
});

/**
 * Pull a JSON object out of model prose.
 *
 * The API path gets schema-validated JSON from the server. The CLI path does
 * not — there is no json_schema output format on `claude -p` — so we ask for
 * bare JSON and then cope with the two things that still happen: a markdown
 * fence, and a sentence of preamble before the brace.
 */
function extractJson(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // Widest brace span — object bodies contain braces, so first-to-last is
    // right where a naive first-to-first would truncate.
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * One call through `claude -p`, using whatever session the CLI is logged into.
 *
 * Flags chosen deliberately:
 *   --system-prompt      replaces Claude Code's coding-agent prompt rather than
 *                        appending to it — we want an editor, not an engineer.
 *   --allowed-tools ""   this is a text transform; it must not touch the repo.
 *   --strict-mcp-config  no MCP servers, so the run doesn't depend on whatever
 *                        the developer happens to have connected.
 */
function callCli({ system, prompt, schema }) {
  const sys = `${system}

Return ONLY a single JSON object conforming to this JSON Schema. No prose before or after it, no markdown code fence.

${JSON.stringify(schema)}`;

  return new Promise(resolve => {
    const child = spawn(
      CLI_BIN,
      [
        '-p',
        '--output-format', 'json',
        '--model', MODEL,
        '--allowed-tools', '',
        '--strict-mcp-config',
        '--system-prompt', sys,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      console.warn(`  ! claude CLI timed out after ${CLI_TIMEOUT_MS / 60000}m — skipping stage`);
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));

    child.on('error', e => {
      clearTimeout(timer);
      console.warn(`  ! cannot run "${CLI_BIN}": ${e.message}`);
      resolve(null);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) {
        console.warn(`  ! claude CLI exited ${code}: ${err.trim().slice(0, 300) || 'no output'}`);
        return resolve(null);
      }

      let envelope;
      try {
        envelope = JSON.parse(out);
      } catch {
        console.warn('  ! claude CLI returned unparseable envelope');
        return resolve(null);
      }

      usage.calls += 1;
      usage.inputTokens += envelope.usage?.input_tokens ?? 0;
      usage.outputTokens += envelope.usage?.output_tokens ?? 0;
      usage.reportedUsd += envelope.total_cost_usd ?? 0;

      if (envelope.is_error) {
        console.warn(`  ! claude CLI error: ${String(envelope.result).slice(0, 200)}`);
        return resolve(null);
      }

      const parsed = extractJson(envelope.result);
      if (!parsed) console.warn('  ! could not extract JSON from CLI output — skipping stage');
      resolve(parsed);
    });

    child.stdin.end(prompt);
  });
}

/**
 * One call through `copilot -p`, on your GitHub Copilot subscription.
 *
 * Copilot narrates to stdout — progress, tool calls, commentary — so parsing
 * its stdout for JSON is unreliable. Instead we do what this environment has
 * already proven works: give it a scratch directory, tell it to WRITE the JSON
 * to a file, and read the file. stdout is then only useful for diagnostics.
 *
 * The prompt goes in via a file and shell redirection rather than argv, because
 * a curation batch is tens of kilobytes and would blow the argument limit.
 */
async function callCopilot({ system, prompt, schema }) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-trend-copilot-'));
  const outPath = join(dir, 'out.json');
  const promptPath = join(dir, 'prompt.txt');

  const body = `${system}

Write ONLY a single JSON object conforming to the schema below to the file ${outPath}. Create that file. Do not print the JSON to stdout, do not wrap it in a code fence, and do not write anything else to that file.

${JSON.stringify(schema)}

--- INPUT ---

${prompt}`;

  try {
    await writeFile(promptPath, body, 'utf8');

    // Least privilege, deliberately narrower than the PR risk analyser's
    // --allow-all-tools: this stage is a text transform whose only legitimate
    // side effect is creating one JSON file in a scratch dir. `write` is the
    // only tool it needs; shell is denied outright so an unattended,
    // cron-triggered run cannot execute anything against the repo.
    const model = MODEL ? `--model ${shellEscape(MODEL)} ` : '';
    const shellCommand =
      `${shellEscape(COPILOT_BIN)} --no-ask-user ` +
      `--allow-tool ${shellEscape('write')} --deny-tool ${shellEscape('shell')} ${model}` +
      `--add-dir ${shellEscape(dir)} < ${shellEscape(promptPath)}`;

    // Retry: `Model "…" from --model flag is not available` is a transient
    // failure, not a bad slug — measured, the same slug that failed one call
    // answered fine on the next. The PR risk analyser retries 3× for the same
    // class of reason. Without this a whole run dies on one flaky stage.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { code, stderr } = await runShell(shellCommand, dir);

      let raw = null;
      try {
        raw = await readFile(outPath, 'utf8');
      } catch {
        /* no file — fall through to the retry decision */
      }

      if (raw !== null) {
        usage.calls += 1; // Copilot reports no token counts, so that's all we know.
        const parsed = extractJson(raw);
        if (parsed) return parsed;
        console.warn(`  ! copilot output was not parseable JSON (attempt ${attempt}/3)`);
      } else {
        const why = stderr.trim().slice(0, 200) || `exit ${code}`;
        console.warn(`  ! copilot wrote no output file (attempt ${attempt}/3): ${why}`);
      }

      if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
    }
    console.warn('  ! copilot failed 3 times — skipping stage');
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Single-quote for `bash -c`, the way the Preflight risk analyser does it. */
function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a shell command, hardened the way this environment requires: the CLIs are
 * Node programs installed under nvm/superset, so PATH has to be augmented or a
 * non-interactive parent process cannot find node.
 */
function runShell(shellCommand, cwd) {
  const extra = [
    `${process.env.HOME}/.superset/bin`,
    `${process.env.HOME}/.npm-global/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', shellCommand], {
      cwd,
      env: {
        ...process.env,
        PATH: [...extra, process.env.PATH ?? ''].join(':'),
        NODE_OPTIONS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), CLI_TIMEOUT_MS);
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: e.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * One structured call. Returns the validated object, or null if the model
 * refused (after the server-side fallback also declined) — callers treat null
 * as "this stage produced nothing" and carry on.
 *
 * `effort` is a real quality knob, so it's set per call site rather than
 * globally: curation is bulk classification, the brief is the editorial work.
 *
 * Exported so the news pipeline (scripts/lib/news-ai.mjs) reuses the exact
 * same backend selection, refusal handling and CLI/API fallback instead of
 * re-implementing it.
 */
export async function callJson({ system, prompt, schema, maxTokens = 16000, effort = 'high' }) {
  if (BACKEND === 'cli') return callCli({ system, prompt, schema });
  if (BACKEND === 'copilot') return callCopilot({ system, prompt, schema });
  return callApi({ system, prompt, schema, maxTokens, effort });
}

async function callApi({ system, prompt, schema, maxTokens, effort }) {
  const supportsFallback = MODEL === 'claude-opus-5';
  const res = await client().beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    ...(supportsFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    system,
    output_config: { format: { type: 'json_schema', schema }, effort },
    messages: [{ role: 'user', content: prompt }],
  });

  usage.calls += 1;
  usage.inputTokens += res.usage?.input_tokens ?? 0;
  usage.outputTokens += res.usage?.output_tokens ?? 0;

  // Check stop_reason before touching content: on a refusal `content` is empty
  // (pre-output) or a partial we must discard, and indexing it would throw.
  if (res.stop_reason === 'refusal') {
    console.warn(`  ! model refused (${res.stop_details?.category ?? 'unknown'}) — skipping stage`);
    return null;
  }
  if (res.stop_reason === 'max_tokens') {
    console.warn('  ! hit max_tokens — output truncated, skipping stage');
    return null;
  }

  const text = res.content.find(b => b.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    console.warn(`  ! unparseable JSON despite schema: ${err.message}`);
    return null;
  }
}

/** Trim a raw item down to what the model needs, to keep input tokens honest. */
function itemForPrompt(item) {
  return {
    id: item.id,
    title: item.title,
    source: item.source,
    kind: item.sourceKind,
    publishedAt: item.publishedAt,
    engagement: item.score ?? 0,
    snippet: (item.snippet || '').slice(0, 700),
  };
}

/**
 * Stage 1 — curate. Batched at CURATION_BATCH_SIZE so one bad batch costs one
 * batch, and so we stay well inside the context window on a heavy news day.
 * Batches run sequentially: this is a cron job, not an interactive request, and
 * serial keeps us clear of rate limits on a shared org key.
 */
export async function curateItems(items, { query = null } = {}) {
  const system = `You are the editor of a daily AI-trends digest.

${AUDIENCE}

For each item you are given, decide whether it belongs in the digest, then describe it.

Apply these filters in order. They exist because this digest has been publishing
technically-correct, entirely useless items.

1. NO VERB, NO KEEP. If you cannot name something the reader could do — a command, flag, config change, repo to clone, setting to flip, decision to revisit — set keep: false. A protocol or spec revision described in terms of its own internals always fails this.
2. A model release is keepable ONLY with a delta he can act on: a price cut he can switch to, a license change that unblocks shipping, a deprecation that breaks him, or a capability that now fits hardware he owns. Parameter counts, context windows, architecture and benchmark placings are not deltas.
3. Require a named artifact. Reward items naming a real repo, flag, file, endpoint or command. Drop "researchers propose a framework".
4. Benchmarks count only with cost or hardware attached. A leaderboard position is noise; "$X per task" or "runs in 48GB" is signal.
5. Prefer first-person operator accounts over announcements. Someone reporting what they ran, and what it cost, outranks any vendor post about the same thing.
6. Failure reports are a POSITIVE signal. An honest "this broke after six hours and here's why" is among the most valuable things you can keep. Set hasFailureReport: true.
7. At most ONE research paper per batch, and only if it already changed someone's tooling.
8. Be harsh. Dropping most of a batch is the normal and correct outcome. An empty-handed batch is better than a padded one.

Then describe what survives:
- tldr: ONE sentence. What happened. No preamble, no "This article discusses". Present tense.
- whyItMatters: at most two sentences. What it changes for the reader. If you cannot answer without filler, set keep: false instead.
- tryThis: the concrete next step, imperative, one line, naming the actual command/flag/repo where there is one ("Set the router's background slot to a local Qwen"). Empty string if the item is worth knowing but has no direct action — but if tryThis is empty AND actionability is below 3, prefer keep: false.
- actionability: 5 = there is a command in here he can run tonight. 4 = a config or workflow change he can make this week. 3 = changes a decision he is going to make. 2 = background worth carrying. 1 = nothing to do.
- importance: how consequential the news is in itself. 5 = something he depends on broke or shipped. 1 = marginal. Keep this honest and independent of actionability — ranking uses actionability first, and a high-importance/low-actionability item is exactly what we have been over-publishing.
- models: only concrete model names actually involved ("Hermes 4", "Claude Opus 5"). Empty array if none.
- entities: organizations, labs, or projects. Empty array if none.
- tags: 2-4 lowercase keywords.
- Ground everything in the title and snippet you are given. Do not invent version numbers, benchmark figures, or dates that aren't there.
- Return every id you were given, including the ones you drop.`;

  const kept = [];
  const batches = [];
  for (let i = 0; i < items.length; i += CURATION_BATCH_SIZE) {
    batches.push(items.slice(i, i + CURATION_BATCH_SIZE));
  }

  console.log(`Curating ${items.length} items in ${batches.length} batch(es)…`);

  for (const [i, batch] of batches.entries()) {
    const focus = query
      ? `\n\nThis is an on-demand run focused on: "${query}". Weight importance toward items relevant to that focus, but do not keep irrelevant items just to fill space.`
      : '';
    const prompt = `Curate these ${batch.length} items.${focus}\n\n${JSON.stringify(batch.map(itemForPrompt), null, 1)}`;

    // Bulk classification against supplied text — medium effort is the right
    // depth here, and it keeps the per-run bill sane on the heaviest stage.
    const result = await callJson({
      system,
      prompt,
      schema: CURATION_SCHEMA,
      effort: 'medium',
    });
    if (!result?.items) {
      console.warn(`  ! batch ${i + 1}/${batches.length} produced nothing`);
      continue;
    }

    const byId = new Map(batch.map(it => [it.id, it]));
    let keptInBatch = 0;
    for (const verdict of result.items) {
      if (!verdict.keep) continue;
      const raw = byId.get(verdict.id);
      if (!raw) continue; // hallucinated id — drop it
      keptInBatch += 1;
      kept.push({
        id: raw.id,
        title: raw.title,
        url: raw.url,
        source: raw.source,
        sourceKind: raw.sourceKind,
        publishedAt: raw.publishedAt,
        tldr: verdict.tldr,
        whyItMatters: verdict.whyItMatters,
        category: verdict.category,
        tags: verdict.tags ?? [],
        entities: verdict.entities ?? [],
        models: verdict.models ?? [],
        // Shipped binaries filter the feed on `importance` alone (>= 2 for the
        // feed, >= 4 for "Just the signal") — they know nothing about
        // actionability. Left untouched, a 5-actionability item the model
        // scored 1 for importance would be hidden by the very app this change
        // is meant to fix. So importance carries actionability as a floor until
        // a release ships that reads the new field directly.
        importance: Math.max(verdict.importance ?? 2, verdict.actionability ?? 1),
        actionability: verdict.actionability ?? 1,
        hasFailureReport: verdict.hasFailureReport ?? false,
        ...(verdict.tryThis?.trim() ? { tryThis: verdict.tryThis.trim() } : {}),
        ...(raw.discussionUrl ? { discussionUrl: raw.discussionUrl } : {}),
        ...(raw.score ? { score: raw.score } : {}),
      });
    }
    console.log(`  batch ${i + 1}/${batches.length}: kept ${keptInBatch}/${batch.length}`);
  }

  // Rank on actionability first. Sorting on importance is what put "the MCP
  // spec changed transports" at the top of the digest: maximally consequential,
  // nothing to do about it. A failure report breaks ties upward — knowing what
  // breaks unattended is worth more than one more thing that shipped.
  kept.sort(
    (a, b) =>
      b.actionability - a.actionability ||
      Number(b.hasFailureReport) - Number(a.hasFailureReport) ||
      b.importance - a.importance ||
      (b.score ?? 0) - (a.score ?? 0),
  );
  return kept;
}

/**
 * Stage 2 — write the brief. The editorial call, and the thing the reader
 * actually opens the app for, so it runs at full effort.
 */
export async function writeBrief(items, { query = null, windowHours = 36 } = {}) {
  if (items.length === 0) return null;

  const system = `You write the daily brief at the top of an AI-trends app.

${AUDIENCE}

You are given the curated items for this cycle. Write the brief.

- headline: under 70 characters. The most USEFUL thing that happened, which is not always the biggest — prefer the thing the reader can act on over the thing with the largest news value. A statement, not a topic label. "Route Claude Code's background calls to a local model", not "Agent tooling news".
- summary: two short paragraphs. What moved and what he should do about it. Lead with anything that changes how he runs his agents tonight. Connect items where there's a real thread; do not manufacture one. Plain language, no bullet-speak, no "In the world of AI".
- bullets: 3-6 lines, one per thing worth acting on. Write them as things to do or know, naming the specific flag, tool or repo. Each line stands alone. No trailing periods.
- signals: 2-4 directional reads on where things are heading, each grounded in the items — not vibes. direction is up/down/flat for that trend's momentum.
- clusters: group items that are genuinely about the same development. itemIds must be ids from the input. Omit items that don't cluster — a cluster of one is not a cluster. Return an empty array if nothing clusters.
- Ground every claim in the supplied items. No outside knowledge, no invented numbers.${query ? `\n- This run was triggered on demand with the focus: "${query}". Lead with that.` : ''}`;

  const prompt = `These are the curated items from the last ${windowHours} hours, most actionable first.\n\n${JSON.stringify(
    items.map(i => ({
      id: i.id,
      title: i.title,
      source: i.source,
      category: i.category,
      importance: i.importance,
      actionability: i.actionability,
      hasFailureReport: i.hasFailureReport,
      tryThis: i.tryThis ?? null,
      tldr: i.tldr,
      whyItMatters: i.whyItMatters,
      models: i.models,
      entities: i.entities,
    })),
    null,
    1,
  )}`;

  const brief = await callJson({ system, prompt, schema: BRIEF_SCHEMA, maxTokens: 12000 });
  if (!brief) return null;

  // Drop cluster references the model invented, and single-item clusters.
  const validIds = new Set(items.map(i => i.id));
  brief.clusters = (brief.clusters ?? [])
    .map((c, i) => ({
      id: `c${i + 1}`,
      title: c.title,
      summary: c.summary,
      itemIds: (c.itemIds ?? []).filter(id => validIds.has(id)),
    }))
    .filter(c => c.itemIds.length > 1);

  return brief;
}

/**
 * Stage 3 — extract model releases for the radar. Only called when the digest
 * actually contains model-shaped items, so a quiet day costs nothing here.
 */
export async function extractModelReleases(items) {
  const candidates = items.filter(
    i =>
      i.sourceKind === 'model' ||
      i.category === 'open-models' ||
      i.category === 'closed-models' ||
      (i.models?.length ?? 0) > 0,
  );
  if (candidates.length === 0) return [];

  const system = `You maintain a tracker of AI models — open-weight and closed.

Given today's items, extract ONLY genuine model releases, version bumps, or material changes to an existing model (license change, price change, deprecation, context-window change).

- Do not emit an entry for a model merely mentioned in passing, benchmarked by someone else, or discussed without a release.
- id: lowercase kebab-case, stable across runs ("hermes-4", "claude-opus-5", "qwen-3-72b").
- license: the actual license name if stated, otherwise "unknown".
- contextTokens: the number as a plain string with no separators ("131072"), or "unknown".
- what: one sentence on what shipped or changed.
- url: the most authoritative URL among the supplied items for this model.
- Return an empty array if nothing shipped. That is the common case and a correct answer.
- Never guess a spec. "unknown" is always better than a plausible number.`;

  const prompt = `Today's model-related items:\n\n${JSON.stringify(
    candidates.map(i => ({
      id: i.id,
      title: i.title,
      url: i.url,
      source: i.source,
      tldr: i.tldr,
      models: i.models,
      entities: i.entities,
    })),
    null,
    1,
  )}`;

  const result = await callJson({ system, prompt, schema: RADAR_SCHEMA, maxTokens: 8000 });
  return result?.models ?? [];
}
