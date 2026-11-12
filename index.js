// opencode-openai-free-tokens — opencode plugin (V2 plugin API, opencode >= 2.x)
//
// Keeps opencode inside OpenAI's *complimentary daily tokens* (the data-sharing
// incentive: https://help.openai.com/en/articles/10306912) so a session never
// silently spills over into paid API usage.
//
//  - counts every token opencode sends to / gets from OpenAI, per model pool,
//    per UTC day (the free allowance resets at 00:00 UTC), in a ledger shared by
//    every opencode process on the machine;
//  - alerts at 85 % and 95 % (desktop notification + a note in the session);
//  - soft stop (default): at 95 % of a pool, or when the next request would
//    cross the free limit (OpenAI bills such a request IN FULL), or on a model
//    the offer doesn't cover, it tells the working agent to stop and write a
//    handoff file into the project directory. Nothing is cut off; the owner can
//    tell the agent to carry on;
//  - hard block (opt-in, "onExhausted": "block"): such requests are pointed at a
//    local stub instead of api.openai.com, so nothing is sent.
//
// No dependencies: node builtins only. Never throws into opencode: every hook is
// guarded and fails open for bookkeeping, closed (block) only by explicit decision.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

const ID = "openai-free-tokens"

// ---------------------------------------------------------------------------
// Offer data (help article, checked 2026-11-11). Override with options.models.

/** Pool limits per usage tier, tokens per UTC day. Tier names as on
 *  https://platform.openai.com/settings/organization/limits */
export const TIERS = {
  build: { big: 250_000, mini: 2_500_000 },
  launch: { big: 1_000_000, mini: 10_000_000 },
  grow: { big: 1_000_000, mini: 10_000_000 },
}

/** Models in each pool. Dated snapshots also match their undated alias
 *  (gpt-5.5-2026-04-23 → gpt-5.5). */
export const MODELS = {
  big: [
    "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol",
    "gpt-5.5-2026-04-23", "gpt-5.4-2026-03-05", "gpt-5.2-2025-12-11", "gpt-5.1-2025-11-13",
    "gpt-5.1-codex", "gpt-5-codex", "gpt-5-2025-08-07", "gpt-5-chat-latest",
    "gpt-4.1-2025-04-14", "gpt-4o-2024-05-13", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20",
    "o3-2025-04-16", "o1-preview-2024-09-12", "o1-2024-12-17",
  ],
  mini: [
    "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini-2026-03-17", "gpt-5.4-nano-2026-03-17",
    "gpt-5.1-codex-mini", "gpt-5-mini-2025-08-07", "gpt-5-nano-2025-08-07",
    "gpt-4.1-mini-2025-04-14", "gpt-4.1-nano-2025-04-14", "gpt-4o-mini-2024-07-18",
    "o4-mini-2025-04-16", "o1-mini-2024-09-12", "codex-mini-latest",
  ],
}

const POOL_LABEL = { big: "large-model pool", mini: "mini-model pool" }

export const DEFAULTS = {
  enabled: true,
  tier: "build", // build | launch | grow  (what your Limits page shows)
  limits: null, // { big, mini } — overrides the tier's numbers
  models: null, // { big: [...], mini: [...] } — replaces the built-in lists
  extraModels: null, // { big: [...], mini: [...] } — added to the built-in lists
  providers: ["openai"], // opencode provider ids to guard
  alertAt: [0.85, 0.95], // owner alerts (fractions of the pool)
  wrapUpAt: 0.95, // soft stop: tell the agent to write a handoff and stop (also when the next request would cross the limit)
  onExhausted: "stop", // stop (soft, default) | block (hard: request never sent) | warn (notification only)
  onUncoveredModel: "stop", // stop | block | warn | allow — a model outside both pools (billed from token 1)
  outputReserve: 16_000, // tokens assumed for the reply when estimating a request
  charsPerToken: 4, // first guess for the prompt-size estimate; each session then calibrates its own ratio from real usage
  capOutput: true, // block mode only: near the limit, cap the reply size so the request cannot cross it
  handoffFile: "HANDOFF.md", // written in the session's project directory
  notify: true, // desktop notifications
  sessionNotes: false, // experimental: alert notes in the session transcript (session.synthetic; can stall server shutdown)
  stateDir: null, // default: $XDG_DATA_HOME/opencode-openai-free-tokens
  sideRequestEstimate: 4_000, // title / generate requests (session titles etc.)
  debug: false, // log hook/event payloads to <stateDir>/debug.jsonl
}

// ---------------------------------------------------------------------------
// helpers

const nowISO = () => new Date().toISOString()
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)
const fmt = (n) => Math.round(n).toLocaleString("en-US")
const pct = (a, b) => (b > 0 ? Math.floor((a / b) * 1000) / 10 : 100)

function msToUtcMidnight() {
  const d = new Date()
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  const m = Math.ceil((next - d.getTime()) / 60000)
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function loadOptions(ctxOptions) {
  const cfgHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const file = readJSON(join(cfgHome, "opencode", "openai-free-tokens.json")) || {}
  const env = {}
  if (process.env.OPENAI_FREE_TOKENS_TIER) env.tier = process.env.OPENAI_FREE_TOKENS_TIER
  if (process.env.OPENAI_FREE_TOKENS_DISABLE === "1") env.enabled = false
  const o = { ...DEFAULTS, ...file, ...(ctxOptions || {}), ...env }
  o.tier = String(o.tier || "build").toLowerCase()
  if (!TIERS[o.tier] && !o.limits) o.tier = "build"
  o.limit = { ...(TIERS[o.tier] || TIERS.build), ...(o.limits || {}) }
  const base = o.models || MODELS
  o.pools = {
    big: [...(base.big || []), ...((o.extraModels && o.extraModels.big) || [])],
    mini: [...(base.mini || []), ...((o.extraModels && o.extraModels.mini) || [])],
  }
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  o.stateDir = o.stateDir || join(dataHome, "opencode-openai-free-tokens")
  o.alertAt = (Array.isArray(o.alertAt) ? o.alertAt : DEFAULTS.alertAt).map(Number).sort()
  return o
}

/** Which pool a model id belongs to, or null when the offer doesn't cover it. */
export function poolOf(modelID, pools = MODELS) {
  if (typeof modelID !== "string" || modelID === "") return null
  const id = modelID.toLowerCase().replace(/^openai\//, "").split("#")[0]
  for (const pool of ["mini", "big"]) {
    for (const m of pools[pool] || []) {
      const name = m.toLowerCase()
      if (id === name) return pool
      const alias = name.replace(/-\d{4}-\d{2}-\d{2}$/, "")
      if (alias !== name && id === alias) return pool
    }
  }
  return null
}

/** Total tokens one step used, as OpenAI counts them (prompt incl. cached + output incl. reasoning). */
export function stepTokens(t) {
  if (!t || typeof t !== "object") return 0
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0)
  return n(t.input) + n(t.output) + n(t.reasoning) + n(t.cache && t.cache.read) + n(t.cache && t.cache.write)
}

// ---------------------------------------------------------------------------
// ledger: one JSONL file per UTC day, shared by all opencode processes

export class Ledger {
  constructor(dir) {
    this.dir = dir
    this.cache = { day: "", size: -1, used: { big: 0, mini: 0, other: 0 } }
  }
  file(day = utcDay()) {
    return join(this.dir, `usage-${day}.jsonl`)
  }
  add(entry) {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.file(), JSON.stringify({ ts: nowISO(), pid: process.pid, ...entry }) + "\n")
    } catch {}
  }
  used() {
    const day = utcDay()
    const f = this.file(day)
    let size = 0
    try {
      size = statSync(f).size
    } catch {
      return { big: 0, mini: 0, other: 0 }
    }
    if (this.cache.day === day && this.cache.size === size) return this.cache.used
    const used = { big: 0, mini: 0, other: 0 }
    try {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line) continue
        try {
          const e = JSON.parse(line)
          const pool = e.pool in used ? e.pool : "other"
          if (typeof e.tokens === "number") used[pool] += e.tokens
          if (typeof e.set === "number") used[pool] = e.set // manual sync from the dashboard
        } catch {}
      }
    } catch {}
    this.cache = { day, size, used }
    return used
  }
}

/** Today's meter for displays (TUI sidebar, CLI): tier, limits, used per pool, time to reset. */
const meterLedgers = new Map()
export function meter(ctxOptions) {
  const o = loadOptions(ctxOptions)
  let l = meterLedgers.get(o.stateDir)
  if (!l) meterLedgers.set(o.stateDir, (l = new Ledger(o.stateDir)))
  return { enabled: o.enabled, tier: o.tier, day: utcDay(), limit: o.limit, used: l.used(), resetsIn: msToUtcMidnight() }
}

// ---------------------------------------------------------------------------
// local stub that answers blocked requests (nothing reaches OpenAI)

function startStub(reasons) {
  return new Promise((resolve) => {
    try {
      const srv = createServer((req, res) => {
        const key = decodeURIComponent((req.url || "").split("/")[2] || "")
        const msg = reasons.get(key) || "opencode-openai-free-tokens blocked this request."
        req.resume()
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: msg, type: "invalid_request_error", code: "free_tokens_guard" } }))
      })
      srv.on("error", () => resolve(null))
      srv.listen(0, "127.0.0.1", () => {
        srv.unref()
        resolve(srv)
      })
    } catch {
      resolve(null)
    }
  })
}

// ---------------------------------------------------------------------------
// notifications

function desktopNotify(title, body, urgent) {
  try {
    const p = platform()
    let cmd, args
    if (p === "linux") {
      cmd = "notify-send"
      args = ["-a", "opencode", "-u", urgent ? "critical" : "normal", title, body]
    } else if (p === "darwin") {
      cmd = "osascript"
      args = ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]
    } else if (p === "win32") {
      cmd = "powershell"
      const ps =
        "[reflection.assembly]::loadwithpartialname('System.Windows.Forms')|Out-Null;" +
        "$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Warning;$n.Visible=$true;" +
        `$n.ShowBalloonTip(10000,${JSON.stringify(title)},${JSON.stringify(body)},'Warning');Start-Sleep 11`
      args = ["-NoProfile", "-Command", ps]
    } else return
    const child = spawn(cmd, args, { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {}
}

// ---------------------------------------------------------------------------
// payload helpers (shapes vary a little between opencode versions)

const sid = (ev) => {
  for (const v of [ev?.sessionID, ev?.sessionId, ev?.session?.id]) if (typeof v === "string" && v) return v
  return ""
}
function modelRef(m) {
  if (!m) return { providerID: "", id: "" }
  if (typeof m === "string") {
    const i = m.indexOf("/")
    return { providerID: i > 0 ? m.slice(0, i) : "", id: (i > 0 ? m.slice(i + 1) : m).split("#")[0] }
  }
  return { providerID: m.providerID || m.provider || "", id: m.id || m.modelID || "" }
}
const evType = (e) => e?.type || e?.name || ""
const evProps = (e) => e?.properties || e?.data || e?.payload || e?.event || e || {}

function sessionDir(info) {
  const loc = info?.location ?? info?.data?.location
  const cands = [
    loc?.directory, loc?.worktree, loc?.path, loc?.root, typeof loc === "string" ? loc : undefined,
    info?.directory, info?.data?.directory,
  ]
  // location is the session's working directory (subpath is only its part relative to the repo root)
  for (const c of cands) if (typeof c === "string" && c.startsWith("/")) return c
  for (const c of cands) if (typeof c === "string" && /^[A-Za-z]:[\\/]/.test(c)) return c
  return process.cwd()
}

// Keys whose values are opaque to the tokenizer-length estimate (encrypted reasoning, signatures,
// ids, provider bookkeeping). Their length says nothing about prompt tokens.
const OPAQUE_KEY = /encrypted|signature|^native$|providermetadata|provideroptions|^itemid$|^responseid$|^id$|^callid$/i

/** Characters of prompt-relevant text in a hook payload. */
export function textChars(v) {
  let n = 0
  const walk = (o, depth) => {
    if (depth > 40 || o == null) return
    if (typeof o === "string") n += o.length
    else if (typeof o === "number" || typeof o === "boolean") n += 4
    else if (Array.isArray(o)) for (const x of o) walk(x, depth + 1)
    else if (typeof o === "object")
      for (const k of Object.keys(o)) {
        if (OPAQUE_KEY.test(k)) continue
        n += k.length
        walk(o[k], depth + 1)
      }
  }
  try {
    walk(v, 0)
  } catch {}
  return n
}

/** Usage out of an OpenAI response body (Responses or Chat Completions, streamed or not). */
export function usageFromBody(body) {
  if (typeof body !== "string" || !body) return null
  let usage = null
  const take = (o) => {
    const u = o?.response?.usage || o?.usage
    if (u && typeof u === "object") usage = u
  }
  try {
    take(JSON.parse(body))
  } catch {
    for (const line of body.split("\n")) {
      const t = line.startsWith("data:") ? line.slice(5).trim() : ""
      if (!t || t === "[DONE]") continue
      try {
        take(JSON.parse(t))
      } catch {}
    }
  }
  if (!usage) return null
  const inTok = usage.input_tokens ?? usage.prompt_tokens ?? 0
  const outTok = usage.output_tokens ?? usage.completion_tokens ?? 0
  const cached = (usage.input_tokens_details || usage.prompt_tokens_details || {}).cached_tokens || 0
  const reasoning = (usage.output_tokens_details || usage.completion_tokens_details || {}).reasoning_tokens || 0
  return { tokens: inTok + outTok, input: inTok - cached, cacheRead: cached, cacheWrite: 0, output: outTok - reasoning, reasoning }
}

// ---------------------------------------------------------------------------

export default {
  id: ID,
  async setup(ctx) {
    const opt = loadOptions(ctx?.options)
    if (!opt.enabled) return () => {}
    const ledger = new Ledger(opt.stateDir)
    const debug = (o) => {
      if (!opt.debug) return
      try {
        mkdirSync(opt.stateDir, { recursive: true })
        appendFileSync(join(opt.stateDir, "debug.jsonl"), JSON.stringify({ ts: nowISO(), pid: process.pid, ...o }) + "\n")
      } catch {}
    }
    const reasons = new Map() // block id -> message (served by the stub)
    const stub = await startStub(reasons)
    const stubURL = stub ? `http://127.0.0.1:${stub.address().port}` : "http://127.0.0.1:9"
    debug({ ev: "load", opt: { ...opt, pools: undefined }, stubURL })

    // opencode can load the plugin once per location in the same process, and reloads it when its files
    // change: keep dedup and per-session state process-wide so a reload mid-request loses no usage
    const G = (globalThis.__openaiFreeTokens ||= { counted: new Set(), responses: new WeakSet() })
    // per-session state
    const sess = (G.sess ||= new Map()) // sessionID -> { estimate, lastPrompt, lastOutput, pool, model, wrapped:day, dir, inflight }
    const S = (id) => {
      let s = sess.get(id)
      if (!s) {
        s = { estimate: 0, lastPrompt: 0, lastOutput: 0, pool: null, model: "", wrapped: "", dir: "" }
        if (sess.size > 500) sess.clear()
        sess.set(id, s)
      }
      return s
    }
    const alerted = new Set() // `${day}:${pool}:${level}` — per process; cross-process dedup via marker files
    const counted = G.counted // dedup of step events

    const alertOnce = (key) => {
      const k = `${utcDay()}:${key}`
      if (alerted.has(k)) return false
      alerted.add(k)
      try {
        mkdirSync(opt.stateDir, { recursive: true })
        const marker = join(opt.stateDir, `alerted-${utcDay()}.json`)
        const seen = readJSON(marker) || {}
        if (seen[key]) return false
        seen[key] = nowISO()
        writeFileSync(marker, JSON.stringify(seen))
      } catch {}
      return true
    }

    const getDir = async (sessionID) => {
      const s = S(sessionID)
      if (s.dir) return s.dir
      try {
        const info = await ctx.session.get({ sessionID })
        s.dir = sessionDir(info)
        debug({ ev: "session.get", sessionID, dir: s.dir, keys: Object.keys(info || {}) })
      } catch {
        s.dir = process.cwd()
      }
      return s.dir
    }

    const note = (sessionID, text, resume = false) => {
      if (!opt.sessionNotes || !sessionID) return
      try {
        Promise.resolve(
          ctx.session.synthetic({ sessionID, text, description: "openai-free-tokens", delivery: "steer", resume }),
        ).catch((e) => debug({ ev: "synthetic.error", err: String(e) }))
      } catch (e) {
        debug({ ev: "synthetic.error", err: String(e) })
      }
    }

    const status = () => {
      const used = ledger.used()
      return ["big", "mini"]
        .map((p) => `${POOL_LABEL[p]}: ${fmt(used[p])} / ${fmt(opt.limit[p])} (${pct(used[p], opt.limit[p])}%)`)
        .join("\n")
    }

    const handoffText = (s, sessionID, why) =>
      [
        `# Handoff — OpenAI free daily tokens used up`,
        ``,
        `Written automatically by opencode-openai-free-tokens at ${nowISO()} because ${why}.`,
        `The agent was stopped so no paid tokens are used. The free allowance resets at 00:00 UTC (in ${msToUtcMidnight()}).`,
        ``,
        `- opencode session: \`${sessionID}\` (resume it with \`opencode -s ${sessionID}\` or pick it in the session list)`,
        `- model: \`${s.model}\` (${POOL_LABEL[s.pool] || "not covered"})`,
        ``,
        `## Usage today (UTC ${utcDay()})`,
        "```",
        status(),
        "```",
        ``,
        `The agent did not get to write its own notes. Read the end of the session transcript for where it stopped.`,
        ``,
      ].join("\n")

    const writeAutoHandoff = async (sessionID, why) => {
      try {
        const s = S(sessionID)
        const dir = await getDir(sessionID)
        const file = join(dir, opt.handoffFile)
        // never overwrite a handoff the agent wrote today
        if (existsSync(file)) {
          const age = Date.now() - statSync(file).mtimeMs
          if (age < 6 * 3600_000) return file
        }
        writeFileSync(file, handoffText(s, sessionID, why))
        return file
      } catch (e) {
        debug({ ev: "handoff.error", err: String(e) })
        return ""
      }
    }

    const decide = (s, estOverride) => {
      // returns { block: string|null, wrapUp: bool, used, limit, remaining }
      if (!s.pool) {
        const mode = opt.onUncoveredModel
        if (mode === "block")
          return {
            block:
              `[openai-free-tokens] Model "${s.model}" is not covered by OpenAI's free daily tokens, so every token would be billed. ` +
              `Blocked. Switch to a covered model, or set "onUncoveredModel": "allow" in openai-free-tokens.json.`,
          }
        return { block: null, wrapUp: false, uncovered: mode !== "allow", stopUncovered: mode === "stop" }
      }
      // + this session's last request if its usage event hasn't arrived yet (the next request is often
      // decided a few ms before the previous one is metered)
      const used = ledger.used()[s.pool] + (s.inflight || []).reduce((a, r) => a + r.promptEst, 0)
      const limit = opt.limit[s.pool]
      const est = estOverride || s.estimate || opt.outputReserve
      const remaining = limit - used
      const crosses = used + est > limit
      if (crosses && opt.onExhausted === "block") {
        return {
          block:
            `[openai-free-tokens] Stopped: this request (~${fmt(est)} tokens) would take the ${POOL_LABEL[s.pool]} past today's free ` +
            `${fmt(limit)} tokens (${fmt(used)} used), and OpenAI would bill the whole request. Free tokens reset at 00:00 UTC ` +
            `(in ${msToUtcMidnight()}). A handoff was written to ${opt.handoffFile} in the project directory.`,
          used,
          limit,
          remaining,
        }
      }
      // soft stop: only at the threshold, or when this very request would cross the limit
      const wrapUp = opt.onExhausted !== "warn" && (used >= limit * opt.wrapUpAt || crosses)
      return { block: null, wrapUp, crosses, used, limit, remaining, est }
    }

    // A session that started before this process: read its last real prompt size from history,
    // so the first estimate is based on actual tokens, not on characters.
    const primeSession = async (id) => {
      const s = S(id)
      s.primed = true
      try {
        const res = await ctx.session.context({ sessionID: id })
        const list = res?.data ?? res?.messages ?? res
        const msgs = Array.isArray(list) ? list : []
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          // a compaction resets the context: older (and the compaction's own) sizes don't apply
          if ((m?.type ?? m?.info?.type) === "compaction") break
          const tk = m?.tokens ?? m?.info?.tokens ?? m?.data?.tokens
          if (tk && typeof tk === "object" && (tk.input || (tk.cache && tk.cache.read))) {
            s.lastPrompt = (tk.input || 0) + ((tk.cache && tk.cache.read) || 0) + ((tk.cache && tk.cache.write) || 0)
            s.lastOutput = (tk.output || 0) + (tk.reasoning || 0)
            break
          }
        }
        debug({ ev: "prime", sessionID: id, messages: msgs.length, lastPrompt: s.lastPrompt, lastOutput: s.lastOutput, sample: msgs.length ? Object.keys(msgs[msgs.length - 1] || {}) : [] })
      } catch (e) {
        debug({ ev: "prime.error", err: String(e) })
      }
    }

    // ----- context hook: estimate the request, inject wrap-up instructions, cap output
    const onContext = async (ev, isCompaction = false) => {
      try {
        const id = sid(ev)
        if (!id) return
        const s = S(id)
        const m = modelRef(ev.model)
        s.model = m.id || s.model
        s.pool = poolOf(s.model, opt.pools)
        const chars = textChars(ev.system) + textChars(ev.messages) + textChars(ev.tools)
        if (!s.primed) await primeSession(id)
        // chars per token: calibrated per session from the last real prompt (text here runs ~4.8,
        // JSON-heavy tool schemas included); the last real prompt + reply is a floor (history only grows)
        const ratio = s.ratio || opt.charsPerToken
        const promptEst = Math.max(Math.ceil(chars / ratio), s.lastPrompt + s.lastOutput)
        s.ctxChars = chars
        s.estimate = promptEst + opt.outputReserve
        s.promptEst = promptEst
        const d = decide(s)
        debug({ ev: "context", sessionID: id, model: s.model, pool: s.pool, chars, ratio, promptEst, d })
        if (d.block) return
        const stopNote =
          `If the owner's latest message explicitly says to continue despite the cost, follow it instead. Otherwise ` +
          `write a concise handoff to the file ${opt.handoffFile} in the project root (the directory you are working in): ` +
          `the task, what is done, what is in progress, exact next steps, files touched, and any commands or ` +
          `findings needed to continue. Use one file write, no other tool calls, then end your turn with a one-line summary.`
        if (!isCompaction && Array.isArray(ev.system)) {
          if (d.wrapUp)
            ev.system.push({
              type: "text",
              text:
                `IMPORTANT — OpenAI free token allowance ${d.remaining <= 0 ? "used up" : "almost used up"} ` +
                `(${fmt(d.used)} of ${fmt(d.limit)} tokens today, ${fmt(Math.max(0, d.remaining))} left; ` +
                `tokens past the limit are billed, and a request that crosses it is billed in full). ` +
                `Stop your current work now. ` + stopNote,
            })
          else if (d.stopUncovered)
            ev.system.push({
              type: "text",
              text:
                `IMPORTANT — the model "${s.model}" is not covered by OpenAI's free daily tokens, so every token of ` +
                `this session is billed. Stop your current work now. ` + stopNote,
            })
        }
        if (!s.pool) return
        if (opt.onExhausted === "block" && opt.capOutput && ev.options && typeof ev.options === "object") {
          const room = d.remaining - promptEst
          if (room < opt.outputReserve * 2) ev.options.maxTokens = Math.max(1024, Math.floor(room))
        }
      } catch (e) {
        debug({ ev: "context.error", err: String(e) })
      }
    }

    // ----- model.request hook: the gate. Redirect blocked requests to the stub.
    const onRequest = async (ev) => {
      try {
        const id = sid(ev)
        const s = S(id)
        const m = modelRef(ev.model)
        if (m.id) {
          s.model = m.id
          s.pool = poolOf(m.id, opt.pools)
        }
        // ChatGPT-login (subscription) traffic is not API-billed: leave it alone.
        if (typeof ev.baseURL === "string" && /chatgpt\.com/i.test(ev.baseURL)) {
          s.unguarded = true
          return
        }
        s.unguarded = false
        const kind = typeof ev.kind === "string" ? ev.kind : ""
        // title/generate requests run beside the main one and are small: separate estimate, no wrap-up
        const side = kind === "title" || kind === "generate"
        if (!side) s.kind = kind
        if (!s.estimate) s.estimate = opt.outputReserve + 20_000
        const d = decide(s, side ? opt.sideRequestEstimate : undefined)
        if (side) d.wrapUp = false
        debug({ ev: "model.request", sessionID: id, kind: ev.kind, baseURL: ev.baseURL, model: m, d })
        if (d.block) {
          const key = `${id}-${Date.now()}`
          reasons.set(key, d.block)
          if (reasons.size > 200) reasons.delete(reasons.keys().next().value)
          ev.baseURL = `${stubURL}/blocked/${encodeURIComponent(key)}`
          ledger.add({ blocked: true, sessionID: id, model: s.model, pool: s.pool, estimate: s.estimate })
          if (s.pool) {
            const file = await writeAutoHandoff(id, "the next request would have crossed the free daily limit")
            if (alertOnce(`block:${s.pool}`))
              desktopNotify("OpenAI free tokens used up", `opencode stopped (${POOL_LABEL[s.pool]}). Handoff: ${file}`, true)
          } else if (alertOnce(`uncovered:${s.model}`)) {
            desktopNotify("opencode: model not free", `${s.model} is not covered by OpenAI's free tokens — blocked.`, true)
          }
          return
        }
        if (d.uncovered && !side && alertOnce(`uncovered-warn:${s.model}`)) {
          desktopNotify(
            "opencode: model not free",
            `${s.model} is billed from the first token.${d.stopUncovered ? ` Asked the agent to write ${opt.handoffFile} and stop.` : ""}`,
            false,
          )
          note(id, `[openai-free-tokens] Warning: ${s.model} is not covered by OpenAI's free daily tokens; this session is using paid tokens.`)
        }
        // sent, not yet metered: usage events can arrive after the next request is already decided
        if (!side && s.pool) {
          s.inflight = [...(s.inflight || []).slice(-2), { chars: s.ctxChars || 0, promptEst: s.promptEst || 0 }]
        }
        if (d.wrapUp && s.wrapped !== utcDay()) {
          s.wrapped = utcDay()
          const why = d.used >= d.limit * opt.wrapUpAt ? `${Math.round(opt.wrapUpAt * 100)}% reached` : `next request (~${fmt(d.est)}) would cross the limit`
          desktopNotify("OpenAI free tokens nearly used up", `${why}: asked the agent to write ${opt.handoffFile} and stop. ${status()}`, true)
        }
      } catch (e) {
        debug({ ev: "model.request.error", err: String(e) })
      }
    }

    // ----- title/generate requests produce no step event: read their usage from a clone of the response
    const onResponse = (ev) => {
      try {
        const kind = ev?.kind
        if (kind === "primary" || kind === "compaction" || !ev?.response) return
        const id = sid(ev)
        const m = modelRef(ev.model)
        if (/chatgpt\.com/i.test(String(ev?.request?.url || ""))) return
        if (ev.response.status >= 400) return
        if (G.responses.has(ev.response)) return
        G.responses.add(ev.response)
        const clone = ev.response.clone()
        void clone
          .text()
          .then((body) => {
            const u = usageFromBody(body)
            debug({ ev: "http.response", sessionID: id, kind, usage: u })
            if (!u) return
            const pool = poolOf(m.id, opt.pools) || "other"
            ledger.add({ sessionID: id, model: m.id, pool, kind, ...u })
            checkAlerts(id, pool === "other" ? null : pool)
          })
          .catch((e) => debug({ ev: "http.response.read.error", err: String(e) }))
      } catch (e) {
        debug({ ev: "http.response.error", err: String(e) })
      }
    }

    // ----- usage accounting from the event bus
    const checkAlerts = (sessionID, pool) => {
      if (!pool) return
      const used = ledger.used()[pool]
      const limit = opt.limit[pool]
      for (const a of opt.alertAt) {
        if (used >= limit * a && alertOnce(`alert:${pool}:${a}`)) {
          const p = Math.round(a * 100)
          const msg = `${p}% of today's free OpenAI tokens used — ${POOL_LABEL[pool]}: ${fmt(used)} / ${fmt(limit)}. Resets in ${msToUtcMidnight()} (00:00 UTC).`
          desktopNotify(`OpenAI free tokens: ${p}% used`, msg, a >= 0.95)
          note(sessionID, `[openai-free-tokens] ${msg} (Note for the agent: informational only, keep working.)`)
        }
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const e of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const t = evType(e)
            const isCompaction = t === "session.compaction.ended" || t === "session.compaction.failed"
            if (t !== "session.step.ended" && t !== "session.step.failed" && !isCompaction) continue
            const p = evProps(e)
            const id = sid(p)
            const s = sess.get(id)
            debug({ ev: t, sessionID: id, tracked: !!s, tokens: p.tokens, eid: e.id })
            if (!s || s.unguarded || !s.model) continue
            if (isCompaction) s.kind = "compaction" // compaction reports usage here, not as a step
            const key = e.id || `${id}:${p.assistantMessageID}:${JSON.stringify(p.tokens)}:${t}`
            if (counted.has(key)) continue
            if (counted.size > 5000) counted.clear()
            counted.add(key)
            const tokens = stepTokens(p.tokens)
            if (!tokens) continue
            const sent = (s.inflight || []).shift() // the request this usage belongs to (FIFO)
            const tk = p.tokens || {}
            s.lastPrompt = (tk.input || 0) + ((tk.cache && tk.cache.read) || 0) + ((tk.cache && tk.cache.write) || 0)
            s.lastOutput = (tk.output || 0) + (tk.reasoning || 0)
            const wasCompaction = s.kind === "compaction"
            // calibrate this session's chars-per-token from the request just measured
            // (not from a compaction: its hook payload is the compaction prompt, a different shape)
            if (!wasCompaction && sent && sent.chars && s.lastPrompt > 1000)
              s.ratio = Math.min(8, Math.max(2.5, sent.chars / s.lastPrompt))
            ledger.add({
              sessionID: id,
              model: s.model,
              pool: s.pool || "other",
              kind: s.kind || "",
              tokens,
              // tokenometrics: where the tokens went in this one request
              input: tk.input || 0,
              cacheRead: (tk.cache && tk.cache.read) || 0,
              cacheWrite: (tk.cache && tk.cache.write) || 0,
              output: tk.output || 0,
              reasoning: tk.reasoning || 0,
              cost: typeof p.cost === "number" ? p.cost : undefined,
              estimate: s.estimate || undefined,
            })
            // after a compaction the next prompt is small again: don't carry the old size forward
            if (wasCompaction) s.lastPrompt = s.lastOutput = 0
            checkAlerts(id, s.pool)
          } catch (err) {
            debug({ ev: "event.error", err: String(err) })
          }
        }
      } catch {}
    })()

    // ----- hooks (scoped to the guarded providers)
    const disposers = []
    for (const providerID of opt.providers) {
      try {
        disposers.push(await ctx.session.hook("context", onContext, { providerID }))
        disposers.push(await ctx.session.hook("compaction", (ev) => onContext(ev, true), { providerID }))
        disposers.push(await ctx.session.hook("model.request", onRequest, { providerID }))
        disposers.push(await ctx.session.hook("http.response", onResponse, { providerID }))
      } catch (e) {
        debug({ ev: "hook.error", err: String(e) })
      }
    }

    // ----- tool: lets the agent (or you, by asking it) see the meter. Costs nothing extra to call.
    try {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "openai_free_tokens",
          description:
            "Show how many of today's free OpenAI data-sharing tokens are used (per pool) and when they reset.",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({
            content: `Tier: ${opt.tier}. Today (UTC ${utcDay()}):\n${status()}\nResets in ${msToUtcMidnight()} (00:00 UTC).`,
          }),
        })
      })
    } catch (e) {
      debug({ ev: "tool.error", err: String(e) })
    }

    return () => {
      controller.abort()
      for (const d of disposers) {
        try {
          d && d.dispose && d.dispose()
        } catch {}
      }
      try {
        stub && stub.close()
      } catch {}
    }
  },
}
