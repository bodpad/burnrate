import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Boggart — a small Claude chat that exists to spend tokens on purpose.
 *
 * Everything here is shaped by that purpose. The chat is the ordinary way to use it; `/api/burst`
 * is the reason it exists: it fires N requests back to back so a spend curve can be *drawn* rather
 * than waited for. The platform's spend-anomaly detector judges an agent against its own history
 * (a day's spend three standard deviations above its own mean, and a month-end projection over its
 * cap), so demonstrating it needs a quiet baseline and then a deliberate spike — which is a dial,
 * not a feature you can get from an app that only spends when somebody has real work for it.
 */

// The port the platform routes to. Declared in insygna.yaml (runtime.app_port) as well — declared
// beats detected there, and the two must agree.
const PORT = Number(process.env.PORT ?? 8080);

// Opus 5 by default: this fixture's job is to spend, and the frontier model reaches a useful figure
// in a handful of messages instead of hundreds. Override for a cheaper run.
const MODEL = process.env.BOGGART_MODEL ?? "claude-opus-5";

/**
 * Deliberately small. The point is *many* priced calls, not one long answer: a spend curve with
 * shape needs several data points, and a 16k-token reply would be one expensive dot. Raise it if
 * you want fewer, larger calls.
 */
const MAX_TOKENS = Number(process.env.BOGGART_MAX_TOKENS ?? 1024);

/**
 * Only for the cost figure this app shows in its own UI. The platform prices the traffic itself,
 * from the rates in `insygna.yaml` — these two must be kept in step, or the number on the page
 * disagrees with the number on the invoice for no reason a reader could work out.
 */
const RATE_IN_PER_MTOK = Number(process.env.BOGGART_RATE_IN ?? 5);
const RATE_OUT_PER_MTOK = Number(process.env.BOGGART_RATE_OUT ?? 25);

const SYSTEM_PROMPT =
  process.env.BOGGART_SYSTEM ??
  "You are Boggart, a test agent on the Insygna platform. Answer briefly and plainly.";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "..", "public", "index.html");

/** Cumulative for the life of the process — what the UI shows, and what makes a burst legible. */
const totals = { calls: 0, inputTokens: 0, outputTokens: 0, errors: 0 };

/**
 * The key is injected by the platform, which is why it is declared by NAME in insygna.yaml
 * (`env.required_secrets`) and never typed into this app: that declaration is also what makes the
 * proxy redact it out of the traces. A missing key must not stop the pod becoming ready — a crash
 * loop would read as "the deploy failed" when the truth is "the secret was not injected" — so the
 * client is built lazily and `/health` stays honest either way.
 */
let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new MissingKeyError();
  }
  client ??= new Anthropic();
  return client;
}

class MissingKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set — the platform has not injected the secret this agent declares.");
  }
}

type Turn = { role: "user" | "assistant"; content: string };

/** One priced call. Returns the reply and what it cost in tokens. */
async function ask(history: Turn[], message: string) {
  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user" as const, content: message },
  ];

  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
  });

  totals.calls += 1;
  totals.inputTokens += response.usage.input_tokens;
  totals.outputTokens += response.usage.output_tokens;

  // content is a discriminated union — narrow before reading .text.
  const reply = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return {
    reply: reply || "(no text in the reply)",
    stopReason: response.stop_reason,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

/** What the money looks like, by this app's own reckoning. See the rate constants above. */
function estimateUsd(inputTokens: number, outputTokens: number): number {
  const usd = (inputTokens / 1e6) * RATE_IN_PER_MTOK + (outputTokens / 1e6) * RATE_OUT_PER_MTOK;
  return Math.round(usd * 1e6) / 1e6;
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** Bounded so a malformed or hostile request cannot make this process the problem. */
async function readJson(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Everything from the browser is untrusted, including the history it echoes back: the API rejects a
 * malformed turn with a 400 that would read here as "the agent is broken", so it is filtered rather
 * than forwarded. Capped at 20 turns — this is a test fixture, not a long-lived assistant.
 */
function parseHistory(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is Turn =>
      !!t && typeof t === "object"
      && ((t as Turn).role === "user" || (t as Turn).role === "assistant")
      && typeof (t as Turn).content === "string"
      && (t as Turn).content.trim().length > 0)
    .slice(-20);
}

/** Maps an SDK failure to a status and a sentence a human can act on. Most specific first. */
function describeError(error: unknown): { status: number; error: string } {
  if (error instanceof MissingKeyError) {
    return { status: 503, error: error.message };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return { status: 502, error: "Anthropic rejected the API key this agent was given." };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { status: 429, error: "Rate limited by Anthropic — slow the burst down and retry." };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { status: 400, error: `Anthropic refused the request: ${error.message}` };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    // The likeliest cause inside a traced pod, and the one nobody guesses: the sidecar intercepts
    // TLS, so the CA it presents has to be trusted. See the TLS section of the README.
    return {
      status: 502,
      error: "Could not reach Anthropic. Inside a traced pod, check that SSL_CERT_FILE reached NODE_EXTRA_CA_CERTS (the Dockerfile's CMD maps them), then the egress allowlist in insygna.yaml.",
    };
  }
  if (error instanceof Anthropic.APIError) {
    return { status: 502, error: `Anthropic API error ${error.status}: ${error.message}` };
  }
  return { status: 500, error: error instanceof Error ? error.message : "unknown failure" };
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => {
    totals.errors += 1;
    const { status, error: message } = describeError(error);
    json(res, status, { error: message });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // Liveness and readiness both point here. It answers without touching Anthropic on purpose: a
  // health check that calls the API would spend money on every probe, and would report the agent
  // unhealthy whenever the provider had a bad minute.
  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    return json(res, 200, {
      status: "ok",
      model: MODEL,
      keyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      totals,
    });
  }

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    const html = await readFile(INDEX_HTML);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && path === "/api/stats") {
    return json(res, 200, {
      ...totals,
      estimatedUsd: estimateUsd(totals.inputTokens, totals.outputTokens),
      model: MODEL,
    });
  }

  if (req.method === "POST" && path === "/api/chat") {
    const body = (await readJson(req)) as { message?: unknown; history?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return json(res, 400, { error: "A message is required." });

    const result = await ask(parseHistory(body.history), message);
    return json(res, 200, {
      ...result,
      estimatedUsd: estimateUsd(result.usage.inputTokens, result.usage.outputTokens),
      totals,
    });
  }

  /**
   * The spend dial. N sequential calls with one prompt — sequential rather than parallel so a rate
   * limit slows it down instead of failing most of it, and so the traces land in an order that
   * reads like use rather than like an attack.
   *
   * A failed call stops the burst and reports what was already spent: money that has been spent is
   * a fact, and hiding it behind an error would make the platform's figure and this page's figure
   * disagree with no way to tell which is wrong.
   */
  if (req.method === "POST" && path === "/api/burst") {
    const body = (await readJson(req)) as { count?: unknown; prompt?: unknown };
    const requested = Number(body.count ?? 5);
    if (!Number.isFinite(requested) || requested < 1) {
      return json(res, 400, { error: "count must be a positive number." });
    }
    const count = Math.min(Math.trunc(requested), 50);   // a typo guard, not a policy
    const prompt = typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt.trim()
      : "In two sentences, tell me something true about a boggart.";

    const spent = { calls: 0, inputTokens: 0, outputTokens: 0 };
    let failure: string | undefined;
    for (let i = 0; i < count; i++) {
      try {
        const result = await ask([], `${prompt} (${i + 1}/${count})`);
        spent.calls += 1;
        spent.inputTokens += result.usage.inputTokens;
        spent.outputTokens += result.usage.outputTokens;
      } catch (error) {
        totals.errors += 1;
        failure = describeError(error).error;
        break;
      }
    }
    return json(res, failure && spent.calls === 0 ? 502 : 200, {
      requested: count,
      ...spent,
      estimatedUsd: estimateUsd(spent.inputTokens, spent.outputTokens),
      failure,
      totals,
    });
  }

  json(res, 404, { error: `No route for ${req.method} ${path}` });
}

server.listen(PORT, () => {
  console.log(`boggart listening on :${PORT} model=${MODEL} key=${process.env.ANTHROPIC_API_KEY ? "present" : "MISSING"}`);
});

// k8s sends SIGTERM and waits; without this the pod takes the full grace period to go away on
// every deploy.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} — closing`);
    server.close(() => process.exit(0));
  });
}
