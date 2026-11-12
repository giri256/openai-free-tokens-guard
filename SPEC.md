# OpenAI Free Tokens Guard — porting spec

This file is written for a coding agent. Hand it over with something like:

> Read SPEC.md from https://github.com/giri256/openai-free-tokens-guard and add the free-tokens guard to this app.
> My usage tier is Build (from https://platform.openai.com/settings/organization/limits).

It describes, language-neutrally, how to keep any app that calls the OpenAI API inside OpenAI's complimentary daily tokens, so it never silently spends paid credit. The opencode plugin in this repo (`index.js`) is a working reference implementation of this spec.

## 1. The offer (source: https://help.openai.com/en/articles/10306912)

- Organizations that turn on **data sharing** (Settings → Data controls → Sharing) and are shown the offer get free tokens **every day** on traffic shared with OpenAI.
- There are two **pools**, each with its own daily limit, shared by all models in the pool:

  | Usage tier (Limits page) | Large-model pool | Mini-model pool |
  |---|---|---|
  | Build | 250,000 | 2,500,000 |
  | Launch | 1,000,000 | 10,000,000 |
  | Grow | 1,000,000 | 10,000,000 |

- The counter **resets at 00:00 UTC**.
- **A request that would push the day's total past the limit is billed in full**, not just the part above the limit.
- Not covered: fine-tuned models, fine-tuning training, evals, **tool use** (OpenAI-hosted tools such as web search), and every model not on the lists below. Those are billed from the first token.
- A positive account balance is required to use the API at all, including the free tokens.

### Models per pool (as published 2026-11-11; keep this list configurable)

Large-model pool: `gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.5-2026-04-23, gpt-5.4-2026-03-05, gpt-5.2-2025-12-11, gpt-5.1-2025-11-13, gpt-5.1-codex, gpt-5-codex, gpt-5-2025-08-07, gpt-5-chat-latest, gpt-4.1-2025-04-14, gpt-4o-2024-05-13, gpt-4o-2024-08-06, gpt-4o-2024-11-20, o3-2025-04-16, o1-preview-2024-09-12, o1-2024-12-17`

Mini-model pool: `gpt-5.6-terra, gpt-5.6-luna, gpt-5.4-mini-2026-03-17, gpt-5.4-nano-2026-03-17, gpt-5.1-codex-mini, gpt-5-mini-2025-08-07, gpt-5-nano-2025-08-07, gpt-4.1-mini-2025-04-14, gpt-4.1-nano-2025-04-14, gpt-4o-mini-2024-07-18, o4-mini-2025-04-16, o1-mini-2024-09-12, codex-mini-latest`

A dated snapshot also matches its undated alias (`gpt-5.5-2026-04-23` → `gpt-5.5`). Anything else (for example `gpt-5.5-pro`, `gpt-6.1-terra`) is **not covered**.

## 2. What to count

For every OpenAI response, read `usage` and add to that day's pool:

```
tokens = input_tokens + output_tokens          (Responses API)
tokens = prompt_tokens + completion_tokens     (Chat Completions)
```

- Cached input tokens **count** (they are part of `input_tokens`).
- Reasoning tokens **count** (they are part of `output_tokens`).
- Streaming: the usage arrives in the final event (`response.completed`, or the last chunk when `stream_options.include_usage` is true for Chat Completions). Turn it on.
- Count **every** request: background ones too (titles, summaries, retries that got a response, conversation compaction). A compaction re-sends the whole conversation and usually gets no cache hit; in the reference measurement a 105K-token context cost 107,956 tokens to compact.

## 3. Storage

- One record per request: `{utc_day, pool, model, tokens, timestamp}`. Sum by `utc_day + pool`.
- Make it shared by every process/device of the app that uses the same OpenAI organization (a file on one machine; a database row or KV entry for a server or a mobile app's backend).
- Usage from other apps on the same organization is invisible to you. Offer a manual "set today's used tokens" (copied from the Usage dashboard) that overrides the running sum.

## 4. The gate (before every request)

```
pool      = pool_of(model)                      # null = not covered
if pool is null:            stop("model not covered")        # stop (default) | block | warn | allow
used      = sum(today, pool) + previous request of this conversation if its usage hasn't arrived yet
estimate  = prompt_tokens_estimate + output_reserve
if used >= 0.95 * limit[pool] or used + estimate > limit[pool]:
    stop("free limit nearly used")              # default: soft stop (section 5); opt-in: block
```

- `prompt_tokens_estimate`: characters of the text actually sent ÷ a chars-per-token ratio **calibrated per conversation** (characters sent for the last request ÷ its real `input_tokens`; start at 4). Never below the last request's real prompt + reply (history only grows). A fixed ÷ 3 overestimates about 2× on agent traffic (measured 4.8 chars/token incl. tool schemas) and stops work at the wrong time. Do not count opaque fields (encrypted reasoning, signatures, ids): their length says nothing about tokens.
- `output_reserve`: room for the reply, e.g. 16,000 for reasoning models, less for small replies.
- Block mode only: near the limit, also **cap the reply**: `max_output_tokens = limit − used − prompt_estimate`, so the request cannot cross the limit even if the model writes a long answer.
- **Soft stop is the default**: the request still goes out, with an instruction to the agent to stop (section 5). The user stays in charge and can tell it to continue.
- **Block (opt-in) means not sending the request.** Return a clear error to the user: what was blocked, used/limit, and that the allowance resets at 00:00 UTC (show the time left).

## 5. Alerts and wrap-up

- Alert the user once per day per pool at **85 %** and **95 %** (notification, banner, push message: whatever the app has).
- **Wrap-up / soft stop** (for agents or long multi-step jobs): when `used ≥ 95 %` or when the next request would cross the limit, tell the running job to stop and save its state, unless the user explicitly said to continue (for a coding agent: write a handoff file in the project directory with the task, what is done, what is in progress, exact next steps). Do it while there is still room for that last step.
- If the gate blocks anyway, save what you can without the model (the app's own state, the conversation id, usage numbers) so work can resume after the reset.

## 6. Settings to expose

`tier` (build | launch | grow, as shown on the Limits page), optional custom `limits`, model lists, `alert_at` (0.85, 0.95), `wrap_up_at` (0.95), `on_exhausted` (stop | block | warn; default stop), `on_uncovered_model` (stop | block | warn | allow), `output_reserve`.

## 7. Checks a port should pass

1. A request with usage `input 30,000 (cached 10,000) + output 2,000 (reasoning 500)` adds 32,000.
2. With limit 99,000 and 64,000 used, a request estimated at 36,000 carries the stop instruction but is still sent (default); with `on_exhausted = block` it is **not sent**.
3. With limit 250,000 and 107,956 used, a ~54,000 request gets **no** stop instruction (no stop below 95 % unless the request would cross).
4. A model not on either list gets the stop instruction (default) or is not sent (`block`).
5. The counter starts from zero after 00:00 UTC.
6. Alerts fire once at 85 % and once at 95 %, not on every request.
7. Two processes writing at the same time do not lose a record.
