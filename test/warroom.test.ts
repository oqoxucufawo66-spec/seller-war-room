import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { test } from "node:test"

process.env.WARROOM_MODE = "mock"
process.env.WARROOM_QUIET = "1"
console.warn = () => {}

const planted = (await import("../data/demo-shop/planted-issues.json", { with: { type: "json" } })).default as any

test("mock War Room: concurrent agents, critic, gate, retry, report", async () => {
	const { runWarRoom } = await import("../src/warroom")
	const { writeReport } = await import("../src/report")
	const { state, timedOut } = await runWarRoom(60_000)
	assert.equal(timedOut, false, "board should settle before the watchdog")
	const r = writeReport(state, "out/test")

	// every planted leak is found and verified
	const issues = Array.isArray(planted) ? planted : planted.issues
	for (const p of issues) {
		const hit = r.verified.find((f) => f.marketplace === p.marketplace && (p.sku == null || f.sku === p.sku) && f.kind.startsWith(p.kind === "storage" ? "overstock" : p.kind))
		assert.ok(hit, `planted issue not verified: ${JSON.stringify(p)}`)
	}
	assert.equal(r.coverage.found, r.coverage.total)

	// the three analysts actually overlapped in time
	const spans = [...state.stats.values()].filter((s) => s.role === "analyst").map((s) => s.spans[0])
	assert.equal(spans.length, 3)
	const latestStart = Math.max(...spans.map((s) => s.start))
	const earliestEnd = Math.min(...spans.map((s) => s.end!))
	assert.ok(latestStart < earliestEnd, "analyst loops should overlap")

	// the Critic ran several verifications at once at some point
	const critic = [...state.stats.values()].find((s) => s.role === "critic")!
	const overlap = critic.spans.some((a, i) => critic.spans.some((b, j) => i !== j && a.start < b.start && b.start < a.end!))
	assert.ok(overlap, "critic loops should overlap")

	// safety nets fired
	assert.ok(r.rejected.some((f) => f.verdict!.startsWith("number mismatch")), "a wrong number is rejected")
	assert.ok(r.rejected.some((f) => f.verdict!.startsWith("not a leak")), "a false positive is rejected")
	assert.ok(r.verified.some((f) => f.retryOf), "a rejected finding is corrected on retry")
	assert.ok(state.gate.length >= 1, "the gate blocks a duplicate")
	assert.ok(existsSync("out/test/report.md") && existsSync("out/test/trace.json"))
})
