// Runs the plugin against a fake opencode V2 plugin context. `node --test test/`
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { poolOf, usageFromBody, textChars, stepTokens } from "../index.js"

function fakeCtx({ history = [], dir }) {
  const hooks = {}
  const queue = []
  let wake
  const ctx = {
    options: {},
    session: {
      hook: async (name, fn) => {
        ;(hooks[name] ||= []).push(fn)
        return { dispose() {} }
      },
      get: async () => ({ id: "ses_x", location: { directory: dir } }),
      context: async () => ({ data: history }),
      synthetic: async () => ({}),
    },
    tool: { transform: async () => ({ dispose() {} }) },
    event: {
      subscribe: ({ signal }) => ({
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise((res) => {
                if (signal.aborted) return res({ done: true })
                if (queue.length) return res({ value: queue.shift(), done: false })
                wake = () => res(queue.length ? { value: queue.shift(), done: false } : { done: true })
                signal.addEventListener("abort", () => wake && wake(), { once: true })
              }),
          }
        },
      }),
    },
  }
  const emit = (e) => {
    queue.push(e)
    if (wake) {
      const w = wake
      wake = null
      w()
    }
  }
  const call = async (name, ev) => {
    for (const fn of hooks[name] || []) await fn(ev)
    return ev
  }
  return { ctx, emit, call, hooks }
}

const tick = () => new Promise((r) => setTimeout(r, 30))

async function load(opts, history = []) {
  const state = mkdtempSync(join(tmpdir(), "oft-state-"))
  const dir = mkdtempSync(join(tmpdir(), "oft-proj-"))
  const f = fakeCtx({ history, dir })
  f.ctx.options = { notify: false, stateDir: state, ...opts }
  const dispose = await plugin.setup(f.ctx)
  return { ...f, state, dir, dispose }
}

const ctxEv = (chars, kind) => ({
  sessionID: "ses_x",
  model: { providerID: "openai", id: "gpt-6-luna" },
  system: [{ type: "text", text: "s" }],
  messages: [{ role: "user", content: "x".repeat(chars) }],
  tools: {},
  options: {},
})
const reqEv = (kind = "primary", model = "gpt-6-luna") => ({
  sessionID: "ses_x",
  kind,
  model: { providerID: "openai", id: model },
  baseURL: "https://api.openai.com/v1",
  headers: {},
})
const step = (id, tokens) => ({ id, type: "session.step.ended", properties: { sessionID: "ses_x", tokens } })
const T = (input, read, write, out, rs) => ({ input, output: out, reasoning: rs, cache: { read, write } })

test("pool mapping: snapshots, aliases, uncovered", () => {
  assert.equal(poolOf("gpt-6-luna"), "big")
  assert.equal(poolOf("gpt-5.6-luna"), "mini")
  assert.equal(poolOf("gpt-5.5"), "big") // alias of gpt-5.5-2026-04-23
  assert.equal(poolOf("gpt-5-mini"), "mini")
  assert.equal(poolOf("openai/gpt-5-nano#high"), "mini")
  assert.equal(poolOf("gpt-6.1-terra"), null)
  assert.equal(poolOf("gpt-5.5-pro"), null)
})

test("token math matches OpenAI totals", () => {
  assert.equal(stepTokens(T(20000, 10000, 0, 1500, 500)), 32000)
  const u = usageFromBody(
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":300,"input_tokens_details":{"cached_tokens":100},"output_tokens":20,"output_tokens_details":{"reasoning_tokens":5}}}}\n\n',
  )
  assert.deepEqual(u, { tokens: 320, input: 200, cacheRead: 100, cacheWrite: 0, output: 15, reasoning: 5 })
})

test("estimate ignores encrypted reasoning blobs", () => {
  const n = textChars([{ type: "reasoning", text: "abc", reasoningEncryptedContent: "Z".repeat(100000), providerMetadata: { x: "y".repeat(5000) } }])
  assert.ok(n < 100, `counted ${n}`)
})

test("meters steps, alerts, wraps up, then blocks before crossing the limit", async () => {
  const p = await load({ limits: { big: 99000 }, outputReserve: 4000 })
  await p.call("context", ctxEv(30000))
  await p.call("model.request", reqEv())
  p.emit(step("e1", T(20000, 10000, 0, 1500, 500)))
  p.emit(step("e1", T(20000, 10000, 0, 1500, 500))) // duplicate delivery: counted once
  await tick()
  // 32,000 used; next ~36,000 fits, but fewer than 2 such requests remain -> wrap-up text injected
  const c = await p.call("context", ctxEv(30000))
  assert.ok(c.system.some((x) => /HANDOFF\.md/.test(x.text)), "wrap-up injected")
  const r1 = await p.call("model.request", reqEv())
  assert.equal(r1.baseURL, "https://api.openai.com/v1")
  p.emit(step("e2", T(20000, 10000, 0, 1500, 500)))
  await tick()
  // 64,000 used + ~36,000 estimate > 99,000 -> blocked, request redirected to the local stub
  await p.call("context", ctxEv(30000))
  const r2 = await p.call("model.request", reqEv())
  assert.match(r2.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/blocked\//)
  const res = await fetch(r2.baseURL + "/responses", { method: "POST", body: "{}" })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error.message, /would take the large-model pool past/)
  await tick()
  assert.ok(existsSync(join(p.dir, "HANDOFF.md")), "auto handoff written in the project dir")
  const lines = readFileSync(join(p.state, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8").trim().split("\n")
  assert.equal(lines.filter((l) => l.includes('"tokens":32000')).length, 2)
  assert.ok(JSON.parse(readFileSync(join(p.state, `alerted-${new Date().toISOString().slice(0, 10)}.json`), "utf8"))["block:big"])
  p.dispose()
})

test("uncovered model is blocked; title request uses its own small estimate", async () => {
  const p = await load({ limits: { big: 100000 } })
  const r = await p.call("model.request", reqEv("primary", "gpt-6.1-terra"))
  assert.match(r.baseURL, /\/blocked\//)
  const t = await p.call("model.request", reqEv("title", "gpt-6-luna"))
  assert.equal(t.baseURL, "https://api.openai.com/v1")
  p.dispose()
})

test("compaction usage is metered; priming ignores pre-compaction sizes", async () => {
  const history = [
    { type: "assistant", tokens: T(3, 91489, 9751, 485, 3336) },
    { type: "compaction", tokens: T(3, 0, 105626, 622, 1705) },
    { type: "user", text: "hi" },
  ]
  const p = await load({ limits: { big: 250000 } }, history)
  await p.call("context", ctxEv(60000)) // ~20,000 tokens of real prompt after compaction
  const r = await p.call("model.request", reqEv())
  assert.equal(r.baseURL, "https://api.openai.com/v1")
  const dbg = []
  // estimate must come from the post-compaction prompt, not the 105K compaction
  p.emit({ id: "c1", type: "session.compaction.ended", properties: { sessionID: "ses_x", tokens: T(3, 0, 105626, 622, 1705) } })
  await tick()
  const f = join(p.state, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`)
  const rows = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(rows[0].kind, "compaction")
  assert.equal(rows[0].tokens, 107956)
  // no wrap-up: 107,956 used, ~36K next request, plenty left
  const c = await p.call("context", ctxEv(60000))
  assert.ok(!c.system.some((x) => /HANDOFF/.test(x.text)), "no false wrap-up after compaction")
  p.dispose()
})
