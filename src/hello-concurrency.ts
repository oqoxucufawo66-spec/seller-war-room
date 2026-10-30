/**
 * Hello-world: two Mozaik agents run concurrently and write to one shared board (RuntimeState).
 * Passes (exit 0) only if both loops overlap in time and both findings land on the board.
 *   npm run hello                 # mock, no key needed
 *   WARROOM_MODE=live npm run hello
 */
import "dotenv/config"
import {
	Agent,
	ModelMessageItem,
	RuntimeState,
	SituationSpecification,
	createAgent,
	createHuman,
	defineRuntime,
	type SituationContext,
	type SituationHandler,
	type Tool,
} from "@mozaik-ai/core"
import { MODE, inferenceRunnerConfig, modelName } from "./models"

type Finding = { by: string; marketplace: string; text: string; at: number }

class BoardState extends RuntimeState {
	board: Finding[] = []
	loops = new Map<string, { agent: string; start: number; end?: number }>()
}

const { initializeRuntime, resolveRuntime, join, sendEvent, runLoop } = defineRuntime<BoardState>()
initializeRuntime({ state: new BoardState(), inferenceRunnerConfig: inferenceRunnerConfig() })

const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(5)

function postFindingTool(agentName: string, marketplace: string): Tool {
	return {
		type: "function",
		name: "post_finding",
		description: "Post one short finding about the shop to the shared War Room board.",
		strict: false,
		parameters: { type: "object", properties: { text: { type: "string", description: "The finding" } }, required: [], additionalProperties: true },
		invoke: async (args: { text?: string; task?: string }) => {
			const state = resolveRuntime().state
			state.board.push({ by: agentName, marketplace, text: args.text ?? `hello from ${marketplace}`, at: Date.now() - t0 })
			return { ok: true, boardSize: state.board.length }
		},
	}
}

class WhenAuditRequested extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext) {
		return event.type === "audit.requested"
	}
}
const startAudit: SituationHandler = {
	specification: new WhenAuditRequested(),
	processor: {
		apply({ participant }) {
			if (!(participant instanceof Agent)) return
			const mp = participant.getManifest()?.capabilities?.[0] ?? "unknown"
			resolveRuntime().state.loops.set(participant.getId(), { agent: participant.getManifest()?.name ?? "agent", start: Date.now() - t0 })
			console.log(`${ms()}ms  start   ${participant.getManifest()?.name ?? "agent"}`)
			runLoop(participant.getId(), `Post exactly one finding (one sentence) about the ${mp} store to the board using post_finding, then reply "done".`, {
				model: modelName(),
				context: participant.getMemory().getContext(),
				tools: participant.getTools(),
			})
		},
	},
}

const mkAnalyst = (name: string, mp: string) =>
	createAgent({ name, capabilities: [mp], instruction: `You are the ${mp} analyst in a seller War Room. Be brief.`, tools: [postFindingTool(name, mp)], handlers: [startAudit] })

const ozon = mkAnalyst("Ozon Analyst", "ozon")
const wb = mkAnalyst("WB Analyst", "wb")

let finished = 0
class WhenModelAnswers extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext) {
		return event.type === "model.answer"
	}
}
const observer = createHuman({
	name: "Trace Observer",
	capabilities: [],
	handlers: [
		{
			specification: new WhenModelAnswers(),
			processor: {
				apply({ event }) {
					const loop = resolveRuntime().state.loops.get(event.producerId)
					if (loop) loop.end = Date.now() - t0
					const { answer } = event.payload as { answer: ModelMessageItem }
					console.log(`${ms()}ms  answer  ${loop?.agent}: ${answer.content.text.slice(0, 80)}`)
					if (++finished === 2) report()
				},
			},
		},
	],
})

function report() {
	const { board, loops } = resolveRuntime().state
	const [a, b] = [...loops.values()]
	const overlap = a.start < (b.end ?? Infinity) && b.start < (a.end ?? Infinity)
	console.log("\nBoard:")
	for (const f of board) console.log(`  [${f.at}ms] ${f.by} (${f.marketplace}): ${f.text}`)
	console.log(`\nmode=${MODE} model=${modelName()}`)
	console.log(`loops: ${a.agent} ${a.start}-${a.end}ms, ${b.agent} ${b.start}-${b.end}ms -> overlap=${overlap}`)
	const ok = overlap && board.length >= 2 && new Set(board.map((f) => f.by)).size === 2
	console.log(ok ? "PASS: 2 agents ran concurrently on shared state" : "FAIL")
	process.exit(ok ? 0 : 1)
}

setTimeout(() => {
	console.error("FAIL: timeout")
	process.exit(1)
}, 120_000).unref()

join(observer)
join(ozon)
join(wb)
// one event, both analysts react to it concurrently
sendEvent({ type: "audit.requested", producerId: observer.getId(), occurredAt: new Date(), payload: {} } as any, observer.getId())
