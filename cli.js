#!/usr/bin/env node
// opencode-openai-free-tokens CLI — reads the plugin's ledger; spends no tokens.
//
//   opencode-openai-free-tokens status            today's usage per pool
//   opencode-openai-free-tokens steps [session]   per-request tokenometrics (cache read/write, fresh input, output)
//   opencode-openai-free-tokens set <big|mini> <tokens>
//                                                 sync today's count with the OpenAI usage dashboard
//   add --day YYYY-MM-DD to status/steps for another UTC day
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Ledger, TIERS } from "./index.js"

const args = process.argv.slice(2)
const dayIdx = args.indexOf("--day")
const day = dayIdx >= 0 ? args.splice(dayIdx, 2)[1] : new Date().toISOString().slice(0, 10)
const [cmd = "status", ...rest] = args

const cfgHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
let cfg = {}
try {
  cfg = JSON.parse(readFileSync(join(cfgHome, "opencode", "openai-free-tokens.json"), "utf8"))
} catch {}
const tier = String(process.env.OPENAI_FREE_TOKENS_TIER || cfg.tier || "build").toLowerCase()
const limit = { ...(TIERS[tier] || TIERS.build), ...(cfg.limits || {}) }
const dir = cfg.stateDir || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode-openai-free-tokens")
const ledger = new Ledger(dir)
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US")

function rows() {
  try {
    return readFileSync(ledger.file(day), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

if (cmd === "status") {
  const used = { big: 0, mini: 0, other: 0 }
  for (const e of rows()) {
    const p = e.pool in used ? e.pool : "other"
    if (typeof e.tokens === "number") used[p] += e.tokens
    if (typeof e.set === "number") used[p] = e.set
  }
  console.log(`tier ${tier}, UTC day ${day}`)
  for (const p of ["big", "mini"]) {
    const pc = limit[p] ? ((used[p] / limit[p]) * 100).toFixed(1) : "?"
    console.log(`${p.padEnd(5)} ${fmt(used[p]).padStart(12)} / ${fmt(limit[p])}  (${pc}%)`)
  }
  if (used.other) console.log(`not covered (billed): ${fmt(used.other)}`)
} else if (cmd === "steps") {
  const only = rest[0]
  const list = rows().filter((e) => typeof e.tokens === "number" && (!only || e.sessionID === only))
  const h = ["time(UTC)", "session", "kind", "model", "fresh in", "cache read", "cache write", "output", "reasoning", "total"]
  console.log(h.join("\t"))
  for (const e of list)
    console.log(
      [e.ts.slice(11, 19), (e.sessionID || "").slice(-8), e.kind || "", e.model, fmt(e.input), fmt(e.cacheRead), fmt(e.cacheWrite), fmt(e.output), fmt(e.reasoning), fmt(e.tokens)].join("\t"),
    )
  for (const e of rows()) if (e.blocked) console.log(`${e.ts.slice(11, 19)}\tBLOCKED\t${e.model}\t(estimate ${fmt(e.estimate)})`)
} else if (cmd === "set") {
  const [pool, n] = rest
  if (!["big", "mini"].includes(pool) || !Number.isFinite(Number(n))) {
    console.error("usage: set <big|mini> <tokens used today, from the OpenAI usage dashboard>")
    process.exit(2)
  }
  ledger.add({ pool, set: Number(n), manual: true })
  console.log(`${pool} pool set to ${fmt(Number(n))} for UTC ${day}`)
} else {
  console.error("commands: status | steps [sessionID] | set <big|mini> <tokens>   [--day YYYY-MM-DD]")
  process.exit(2)
}
