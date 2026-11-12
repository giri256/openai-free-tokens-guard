// Runs the plugin against a fake opencode V2 plugin context. `npm test`
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

async function load(opts, history = [], { keepSessions = false } = {}) {
  // each test is a fresh opencode process unless it simulates a plugin reload
  if (!keepSessions && globalThis.__openaiFreeTokens) globalThis.__openaiFreeTokens.sess = new Map()
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

const today = () => new Date().toISOString().slice(0, 10)
const hasStop = (c) => c.system.some((x) => /HANDOFF\.md/.test(x.text))

test("default is a soft stop: meters, tells the agent to stop at 95 %, never redirects", async () => {
  const p = await load({ limits: { big: 99000 }, outputReserve: 4000 })
  await p.call("context", ctxEv(30000))
  await p.call("model.request", reqEv())
  p.emit(step("e1", T(20000, 10000, 0, 1500, 500)))
  p.emit(step("e1", T(20000, 10000, 0, 1500, 500))) // duplicate delivery: counted once
  await tick()
  // 32,000 used (32 %): no stop
  assert.ok(!hasStop(await p.call("context", ctxEv(30000))), "no stop at 32 %")
  await p.call("model.request", reqEv())
  p.emit(step("e2", T(20000, 10000, 0, 1500, 500)))
  await tick()
  // 64,000 used + ~36,000 next > 99,000: the request would cross -> stop text, request still sent
  const c = await p.call("context", ctxEv(30000))
  assert.ok(hasStop(c), "stop injected when the next request would cross")
  const r = await p.call("model.request", reqEv())
  assert.equal(r.baseURL, "https://api.openai.com/v1", "soft mode never redirects")
  assert.equal(c.options.maxTokens, undefined, "soft mode never caps output")
  assert.ok(!existsSync(join(p.dir, "HANDOFF.md")), "the agent writes the handoff, not the plugin")
  const lines = readFileSync(join(p.state, `usage-${today()}.jsonl`), "utf8").trim().split("\n")
  assert.equal(lines.filter((l) => l.includes('"tokens":32000')).length, 2)
  assert.ok(!lines.some((l) => l.includes('"blocked"')))
  p.dispose()
})

test("opt-in hard block: request crossing the limit goes to the local stub", async () => {
  const p = await load({ limits: { big: 99000 }, outputReserve: 4000, onExhausted: "block" })
  for (const e of ["b-e1", "b-e2"]) {
    await p.call("context", ctxEv(30000))
    await p.call("model.request", reqEv())
    p.emit(step(e, T(20000, 10000, 0, 1500, 500)))
    await tick()
  }
  await p.call("context", ctxEv(30000))
  const r2 = await p.call("model.request", reqEv())
  assert.match(r2.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/blocked\//)
  const res = await fetch(r2.baseURL + "/responses", { method: "POST", body: "{}" })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error.message, /would take the large-model pool past/)
  await tick()
  assert.ok(existsSync(join(p.dir, "HANDOFF.md")), "auto handoff written in the project dir")
  p.dispose()
})

test("regression 2026-11-11: no stop at 43 %, estimate calibrated (~40K not 79K), soft stop at 84.5 %", async () => {
  const p = await load({ limits: { big: 250000 } })
  // 43 % case: 107,956 used, next request fits easily -> no stop (old rule '<2 requests of this size left' stopped here)
  await p.call("compaction", ctxEv(400000))
  await p.call("model.request", reqEv())
  p.emit({ id: "r-c1", type: "session.compaction.ended", properties: { sessionID: "ses_x", tokens: T(3, 0, 105626, 622, 1705) } })
  await tick()
  // real numbers from the incident: 150,444 chars -> 30,485-token prompt; 163,698 -> 34,190; ~177K -> 36,359
  const c1 = await p.call("context", ctxEv(150444))
  assert.ok(!hasStop(c1), "no stop at 43 %")
  await p.call("model.request", reqEv())
  p.emit(step("r-s1", T(3, 0, 30482, 431, 602)))
  await tick()
  await p.call("context", ctxEv(163698))
  await p.call("model.request", reqEv())
  p.emit(step("r-s2", T(2654, 30482, 1054, 5, 0)))
  await tick()
  // 173,669 used (69 %): the owner's next turn
  const c3 = await p.call("context", ctxEv(177000))
  assert.ok(!hasStop(c3), "no stop at 69 %")
  await p.call("model.request", reqEv())
  // the follow-up request (tool results added) is decided BEFORE the 37,614-token step above is metered
  const c4 = await p.call("context", ctxEv(190143))
  const r4 = await p.call("model.request", reqEv())
  assert.equal(r4.baseURL, "https://api.openai.com/v1", "never hard-blocked by default")
  // real pool: 173,669 + 37,614 in flight = 211,283 (84.5 %), + ~40K next -> would cross 250K -> soft stop
  assert.ok(hasStop(c4), "soft stop when the next request would really cross")
  p.emit(step("r-s3", T(3, 0, 36356, 223, 1032)))
  await tick()
  const rows = readFileSync(join(p.state, `usage-${today()}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(rows.reduce((a, x) => a + (x.tokens || 0), 0), 211283) // = OpenAI dashboard for 2026-11-11
  const est = rows.at(-1).estimate - 16000
  assert.ok(est > 36000 && est < 45000, `prompt estimate ${est} should be ~40K (old chars/3 gave 63K)`)
  p.dispose()
})

test("uncovered model: soft stop by default, opt-in block; title request uses its own small estimate", async () => {
  const soft = await load({ limits: { big: 100000 } })
  const sc = await soft.call("context", { ...ctxEv(100), model: { providerID: "openai", id: "gpt-6.1-terra" } })
  assert.ok(sc.system.some((x) => /not covered/.test(x.text)))
  assert.equal((await soft.call("model.request", reqEv("primary", "gpt-6.1-terra"))).baseURL, "https://api.openai.com/v1")
  soft.dispose()
  const p = await load({ limits: { big: 100000 }, onUncoveredModel: "block" })
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

test("late usage event pairs with its own request (calibration + in-flight)", async () => {
  const p = await load({ limits: { big: 250000 }, debug: true })
  await p.call("context", ctxEv(207425))
  await p.call("model.request", reqEv())
  // request 2 is decided before request 1's usage arrives (seen live 2026-11-12: 62 ms gap)
  const c2 = await p.call("context", ctxEv(251299))
  const r2 = await p.call("model.request", reqEv())
  assert.equal(r2.baseURL, "https://api.openai.com/v1")
  p.emit(step("l-s1", T(3, 0, 46160, 912, 935)))
  await tick()
  // ratio from request 1 (207,425 chars / 46,163 tokens = 4.49), not request 2's chars (5.44)
  await p.call("context", ctxEv(260000))
  const dbg = readFileSync(join(p.state, `usage-${today()}.jsonl`), "utf8")
  assert.ok(dbg.includes('"tokens":48010'))
  const last = readFileSync(join(p.state, "debug.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.ev === "context").at(-1)
  assert.ok(Math.abs(last.ratio - 4.49) < 0.05, `ratio ${last.ratio}`)
  // request 2 still in flight: used = 48,010 metered + request 2's prompt estimate (~62.8K at ratio 4)
  assert.ok(last.d.used > 48010 + 60000, `used ${last.d.used}`)
  p.dispose()
})

test("plugin reload mid-request keeps the session: late usage is still metered", async () => {
  const p = await load({ limits: { big: 250000 } })
  await p.call("context", { ...ctxEv(1000), sessionID: "ses_reload" })
  await p.call("model.request", { ...reqEv(), sessionID: "ses_reload" })
  p.dispose()
  const q = await load({ limits: { big: 250000 }, stateDir: p.state }, [], { keepSessions: true }) // reload: fresh setup, same process
  q.emit({ id: "rl-1", type: "session.step.ended", properties: { sessionID: "ses_reload", tokens: T(3380, 46160, 9541, 312, 3610) } })
  await tick()
  assert.ok(readFileSync(join(p.state, `usage-${today()}.jsonl`), "utf8").includes('"tokens":63003'))
  q.dispose()
})
