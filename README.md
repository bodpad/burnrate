> **Burnrate** is a clone of [Boggart](https://github.com/bodpad/Boggart), published as a
> second vendor's agent so that two proposals on one requisition can be compared side by
> side (PI-731). The code is Boggart's; the manifest differs in name, category and the
> declared support commitment.

# Boggart

A deliberately small Claude chat agent whose job is to **spend tokens on demand**, so the Insygna
platform's metering, per-agent budget cap and spend-anomaly detection can be exercised against real
traffic instead of seeded rows.

It is a test fixture, and it is honest about that. There is a chat page, because that is the ordinary
way to use an agent, and there is a **burst** button, which is the reason the thing exists.

## Why a burst button

The platform's spend-anomaly detector does not flag "62% of the cap used". It flags an agent that is
both **statistically unusual for itself** — a day's spend at least three standard deviations above
its own trailing mean — **and** forecast to end the month over its own cap. Two consequences:

- An agent under two weeks old has no baseline yet, so it takes the provisional path: any spend whose
  projection clears the cap is enough. With a **$1 cap**, measured on this agent, roughly **19 calls
  (~$0.13)** trips it — a burst of 20.
- An established agent needs a real spike. You cannot provoke it by lowering the cap: the projection
  goes over, but the z-score stays flat and the verdict is correctly "nothing unusual". You need a
  day that stands out against the agent's own quiet days — which is what the dial is for: let it idle
  for a day or two, then burst.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `GET` | `/` | The chat page, with the burst control and a spend panel |
| `GET` | `/health` | Readiness and liveness. Answers without calling Anthropic — a probe that spent money on every check would be its own problem |
| `POST` | `/api/chat` | `{message, history?}` → one priced call; returns the reply and its token counts |
| `POST` | `/api/burst` | `{count, prompt?}` → N sequential calls; returns what was spent. Capped at 50 as a typo guard |
| `GET` | `/api/stats` | Cumulative totals for the life of the process |

Burst calls are **sequential, not parallel**: a rate limit then slows it down instead of failing most
of it, and the traces land in an order that reads like use. If a call fails, the burst stops and
reports what was already spent — money that has moved is a fact, and hiding it behind an error would
make this page and the platform's figure disagree with no way to tell which is wrong.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Injected by the platform. Declared **by name** in `insygna.yaml` (`env.required_secrets`), which is also what makes the proxy redact it out of the recorded traces. Missing, the pod still becomes ready and the chat returns a 503 saying so — a crash loop would read as "the deploy failed" when the truth is "the secret was not injected" |
| `BOGGART_MODEL` | `claude-opus-5` | The frontier model is the default on purpose: the fixture's job is to spend, and it reaches a useful figure in a handful of messages |
| `BOGGART_MAX_TOKENS` | `1024` | Small on purpose — many priced calls make a curve with shape; one 16k-token reply is a single expensive dot |
| `BOGGART_RATE_IN` / `BOGGART_RATE_OUT` | `5` / `25` | USD per million tokens, **only** for the estimate this app prints. The platform prices the same traffic itself from the rates in `insygna.yaml`; keep the two in step |
| `PORT` | `8080` | Also declared in `insygna.yaml` (`runtime.app_port`) and the Dockerfile's `EXPOSE`. The three disagreeing is a routing failure none of them reveals alone |

## Run it locally

```bash
npm install
npm run build
ANTHROPIC_API_KEY=sk-ant-... npm start        # http://localhost:8080
```

Or in Docker, the way the platform runs it:

```bash
docker build -t boggart:local .
docker run --rm -p 8080:8080 -e ANTHROPIC_API_KEY=sk-ant-... boggart:local
```

## Deploying it through Insygna

1. **Vendor side** — register this repository as an agent, run the static analysis, publish it. The
   manifest is `insygna.yaml` at the root; without it, analysis refuses with `NO_MANIFEST`.
2. **Procurement side** — activate it against a cost centre that has a budget, with a **small
   monthly cap** ($1–2). The cap is what makes the anomaly reachable in one sitting.
3. Wait for the deploy to reach ACTIVE, open the agent's URL, and burst.
4. The 15-minute enforcement cycle meters the traces, and the announcement follows from there.

### TLS inside a traced pod — already handled, and worth knowing why

The platform instruments the image with a **transparent mitmproxy sidecar**: outbound traffic is
intercepted at the network level, so no proxy environment variables are involved — but the
certificate the sidecar presents has to be trusted by the process. The instrumentation handles its
half by baking the sidecar's CA into the image's system trust store and injecting

```
SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
```

which is the convention every OpenSSL-based client reads — curl, Go, Ruby. **Node reads neither**:
it ships its own bundled roots and only extends them from `NODE_EXTRA_CA_CERTS`, which must be set
before the process starts. So the `CMD` in the Dockerfile maps one to the other, and that is the
whole fix:

```dockerfile
CMD ["sh", "-c", "if [ -n \"$SSL_CERT_FILE\" ]; then export NODE_EXTRA_CA_CERTS=\"$SSL_CERT_FILE\"; fi; exec node dist/server.js"]
```

Two things follow, and both are worth knowing before choosing a language for the next agent:

- **Python would not have been safer.** The official Python SDK goes through `httpx`, which has
  historically pinned `certifi` rather than the system store — so `SSL_CERT_FILE` may or may not be
  honoured depending on the `httpx` version. "Works today, breaks on a dependency bump" is worse
  than a predictable one-line mapping. **Go or Ruby** would have needed nothing at all.
- If a future agent reports *"could not reach Anthropic"* in a pod while working locally, this is the
  first thing to check — and the second is `network.egress` in `insygna.yaml`, an allowlist that
  names `api.anthropic.com`: a missing entry there does not announce itself as a policy refusal, the
  call simply fails.

## What has been verified

- Type-checks clean (`tsc --noEmit`) and the image builds.
- Ran against the real API: `/api/chat` returned a reply with token counts, and a burst of 3 cost
  180 input / 808 output tokens ≈ $0.021 — which is where the ~19-calls-for-$0.13 figure above comes
  from.
- `insygna.yaml` validates against the platform's bundled `insygna-schema.yaml` (Draft 7).
- The TLS mapping is not a guess: `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` was read off a
  live traced agent's Deployment and ConfigMap in the dev cluster — it is the only trust variable the
  instrumentation injects into the app container.

Not yet verified: the instrumentation and deploy pipeline end to end for *this* repository — the
image has been built and run by hand, but not yet wrapped by the platform's own instrument step.
