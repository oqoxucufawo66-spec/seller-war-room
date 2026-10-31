/** Turns the settled shared state into out/report.md + out/trace.json. Deterministic: no LLM writes numbers here. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MP_LABEL, allLeaks, shop, skuName } from "./engine"
import { MODE, modelName } from "./models"
import type { WarRoomState } from "./runtime"

const rub = (n: number) => `${Math.round(n).toLocaleString("en-US").replace(/,/g, " ")} ₽`
const PRICE_PER_M = { in: Number(process.env.WARROOM_PRICE_IN ?? 0.3), out: Number(process.env.WARROOM_PRICE_OUT ?? 2.5) }

export function gantt(s: WarRoomState, width = 60) {
	const total = Math.max(1, s.now())
	const rows: string[] = []
	for (const st of s.stats.values()) {
		const line = Array(width).fill("·")
		for (const sp of st.spans) {
			const a = Math.floor((sp.start / total) * width)
			const b = Math.max(a + 1, Math.ceil(((sp.end ?? total) / total) * width))
			for (let i = a; i < Math.min(b, width); i++) line[i] = line[i] === "█" || line[i] === "▓" ? "▓" : "█"
		}
		rows.push(`${st.name.padEnd(22)} |${line.join("")}|`)
	}
	rows.push(`${"".padEnd(22)}  0 ms${" ".repeat(width - 10)}${total} ms`)
	return rows.join("\n")
}

export function buildReport(s: WarRoomState) {
	const verified = s.board.filter((f) => f.status === "verified").sort((a, b) => b.lossRub - a.lossRub)
	const rejected = s.board.filter((f) => f.status === "rejected")
	const total = verified.reduce((a, f) => a + f.lossRub, 0)
	const truth = allLeaks()
	const found = truth.filter((t) => verified.some((f) => f.marketplace === t.marketplace && f.sku === t.sku && f.kind === t.kind))
	const wall = s.now()
	const busy = [...s.stats.values()].reduce((a, st) => a + st.spans.reduce((b, sp) => b + ((sp.end ?? wall) - sp.start), 0), 0)
	const cost = (st: { tokensIn: number; tokensOut: number }) => (st.tokensIn * PRICE_PER_M.in + st.tokensOut * PRICE_PER_M.out) / 1e6

	const L: string[] = []
	L.push(`# War Room report — ${shop.shop}, ${shop.period.from} … ${shop.period.to}`, "")
	L.push(`Mode: **${MODE}** (model \`${modelName()}\`) · wall time **${(wall / 1000).toFixed(1)} s** · agent busy time ${(busy / 1000).toFixed(1)} s (parallelism ×${(busy / Math.max(1, wall)).toFixed(1)})`, "")
	L.push(`## Verified money leaks: ${rub(total)} for the period`, "")
	L.push("| # | Marketplace | SKU | Leak | Loss | What to do | Found by |", "|---|---|---|---|---:|---|---|")
	verified.forEach((f, i) =>
		L.push(`| ${i + 1} | ${MP_LABEL[f.marketplace]} | ${f.sku ? `${f.sku} ${skuName(f.sku)}` : "—"} | ${f.kind} | ${rub(f.lossRub)} | ${f.fix.replace(/\|/g, "/")} | ${f.author}${f.retryOf ? ` (retry of ${f.retryOf})` : ""} |`),
	)
	L.push("", `## Rejected by the Critic (${rejected.length})`, "")
	if (!rejected.length) L.push("none")
	for (const f of rejected) L.push(`- **${f.id}** ${f.author}: ${f.kind} ${f.sku ?? ""} claimed ${rub(f.lossRub)} → ${f.verdict}`)
	L.push("", `## Blocked by the interception gate (${s.gate.length})`, "")
	if (!s.gate.length) L.push("none")
	for (const g of s.gate) L.push(`- ${g.atMs} ms · ${g.agent}: ${g.reason}`)
	L.push("", `## Coverage vs. the deterministic engine: ${found.length}/${truth.length} leaks`, "")
	const missed = truth.filter((t) => !found.includes(t))
	if (missed.length) for (const t of missed) L.push(`- missed: ${MP_LABEL[t.marketplace]} ${t.sku ?? ""} ${t.kind} ${rub(t.lossRub)}`)
	L.push("", "## Agents", "", "| Agent | Loops | Inferences | Tool calls | Tokens in/out | Cost, $ |", "|---|---:|---:|---:|---:|---:|")
	for (const st of s.stats.values()) L.push(`| ${st.name} | ${st.loops} | ${st.inferences} | ${st.toolCalls} | ${st.tokensIn}/${st.tokensOut} | ${cost(st).toFixed(4)} |`)
	L.push("", "## Timeline (█ = agent loop running, ▓ = several loops of one agent at once)", "", "```", gantt(s), "```", "")
	L.push("## Event log", "", "```", ...s.log, "```", "")
	return { markdown: L.join("\n"), verified, rejected, total, coverage: { found: found.length, total: truth.length } }
}

export function writeReport(s: WarRoomState, dir = "out") {
	mkdirSync(dir, { recursive: true })
	const r = buildReport(s)
	writeFileSync(join(dir, "report.md"), r.markdown)
	writeFileSync(
		join(dir, "trace.json"),
		JSON.stringify({ mode: MODE, model: modelName(), wallMs: s.now(), board: s.board, gate: s.gate, agents: [...s.stats.values()], log: s.log }, null, 2),
	)
	return r
}
