import "dotenv/config"
import { writeReport } from "./report"
import { runWarRoom } from "./warroom"

// Mozaik prints a "no telemetry key" notice for every loop; show it once.
const warn = console.warn
let warned = false
console.warn = (...a: unknown[]) => {
	if (String(a[0]).startsWith("mozaik cloud: no API key")) {
		if (warned) return
		warned = true
	}
	warn(...a)
}
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e))

const { state, timedOut } = await runWarRoom()
const r = writeReport(state)
console.log(`\n${"=".repeat(72)}`)
console.log(`Verified leaks: ${r.verified.length} worth ${Math.round(r.total).toLocaleString("en-US")} ₽ · rejected: ${r.rejected.length} · gate blocks: ${state.gate.length} · coverage ${r.coverage.found}/${r.coverage.total}`)
console.log(`Report: out/report.md · trace: out/trace.json${timedOut ? " · (watchdog timeout!)" : ""}`)
process.exit(timedOut ? 1 : 0)
