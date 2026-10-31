/** Wires the War Room together and runs one audit until the shared board settles. */
import { SemanticEvent } from "@mozaik-ai/core"
import { inferenceRunnerConfig } from "./models"
import { analysts, critic, makeObserver, operator } from "./participants"
import { WarRoomState, initializeRuntime, join, say, sendEvent, state } from "./runtime"

export function runWarRoom(timeoutMs = Number(process.env.WARROOM_TIMEOUT_MS ?? 180_000)): Promise<{ state: WarRoomState; timedOut: boolean }> {
	initializeRuntime({ state: new WarRoomState(), inferenceRunnerConfig: inferenceRunnerConfig() })
	return new Promise((resolve) => {
		const finish = (timedOut: boolean) => {
			clearTimeout(timer)
			resolve({ state: state(), timedOut })
		}
		const timer = setTimeout(() => {
			say(`⏱  watchdog: stopping after ${timeoutMs} ms`)
			state().settled = true
			finish(true)
		}, timeoutMs)
		const observer = makeObserver(() => {
			say("🏁 board settled: every finding is verified or rejected, no agent is running")
			finish(false)
		})
		for (const p of [observer, ...analysts, critic, operator]) join(p)
		say(`🚨 Operator opens the War Room: audit request to ${analysts.length} analysts + Critic`)
		sendEvent(SemanticEvent.create("audit.requested", operator.getId(), { period: "last 30 days" }), operator.getId())
	})
}
