// opencode TUI plugin: an "OpenAI free tokens" section at the top of the session sidebar (above Context).
// Loaded by the opencode TUI through package.json "exports"["./tui"]. Plain JS on purpose
// (no JSX build step): it uses the same @opentui/solid calls the built-in sidebar sections compile to.
import { createElement, createTextNode, effect, insert, insertNode, setProp } from "@opentui/solid"
import { createSignal } from "solid-js"
import { meter } from "./index.js"

const POOLS = [
  ["big", "Large models"],
  ["mini", "Mini models"],
]
const BAR = 37 // characters: the width of the sidebar content (opencode 2.2.6), so the bar lines up with the label row

const fmt = (n) => Math.round(n).toLocaleString("en-US")
const pctOf = (used, limit) => (limit > 0 ? Math.min(100, (used / limit) * 100) : 0)
const pctText = (p) => (p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`)

function el(tag, parent, props = {}) {
  const e = createElement(tag)
  for (const [k, v] of Object.entries(props)) setProp(e, k, v)
  if (parent) insertNode(parent, e)
  return e
}
/** a text (or span) whose content and colour follow signals */
function live(tag, parent, value, fg, props) {
  const e = el(tag, parent, props)
  insert(e, value)
  // whole text lines take fg; inline spans take style.fg (as opencode's own sidebar does)
  effect(() => (tag === "span" ? setProp(e, "style", { fg: fg() }) : setProp(e, "fg", fg())))
  return e
}

function view(ctx, m) {
  const t = () => ctx.theme
  const pct = (pool) => {
    const s = m()
    return s ? pctOf(s.used[pool], s.limit[pool]) : 0
  }
  // green while plenty is left, orange in the middle, red near the limit
  const color = (pool) => {
    const p = pct(pool)
    if (p >= 85) return t().text.feedback.error.base
    if (p >= 50) return t().text.feedback.warning.base
    return t().text.feedback.success.base
  }

  const root = el("box", null, { gap: 1 })

  const title = el("text", root)
  const b = el("b", title)
  insertNode(b, createTextNode("OpenAI free tokens"))
  effect(() => setProp(title, "fg", t().text.base))

  for (const [pool, label] of POOLS) {
    const group = el("box", root)
    // "Large models                 44%"
    const head = el("box", group, { flexDirection: "row", justifyContent: "space-between" })
    live("text", head, () => label, () => t().text.base)
    live("text", head, () => pctText(pct(pool)), () => color(pool))
    // "█████████████░░░░░░░░░░░░░░░░░"
    const bar = el("text", group)
    const filled = () => Math.max(0, Math.min(BAR, Math.round((pct(pool) / 100) * BAR)))
    live("span", bar, () => "█".repeat(filled()), () => color(pool))
    live("span", bar, () => "░".repeat(BAR - filled()), () => t().text.muted)
    // "111,013 used · 138,987 left"
    live(
      "text",
      group,
      () => {
        const s = m()
        if (!s) return "usage unavailable"
        return `${fmt(s.used[pool])} used · ${fmt(Math.max(0, s.limit[pool] - s.used[pool]))} left`
      },
      () => t().text.muted,
    )
  }

  live("text", root, () => (m() ? `Resets in ${m().resetsIn} · 00:00 UTC` : ""), () => t().text.muted)
  return root
}

export default {
  id: "openai-free-tokens",
  setup(ctx) {
    const read = () => {
      try {
        return meter(ctx.options)
      } catch {
        return null
      }
    }
    const first = read()
    if (first && first.enabled === false) return
    const [m, setM] = createSignal(first, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
    const timer = setInterval(() => setM(read()), 2000)
    ctx.ui.slot({ prepend: "sidebar.content", render: () => view(ctx, m) })
    return () => clearInterval(timer)
  },
}
