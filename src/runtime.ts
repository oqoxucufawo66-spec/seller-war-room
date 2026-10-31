/** Shared state of the War Room + the Mozaik runtime bound to it. */
import { Agent, DeveloperMessageItem, ModelContext, RuntimeState, SemanticEvent, defineRuntime, type InterceptionHandler } from "@mozaik-ai/core"
import type { LeakKind, Marketplace } from "./engine"
import { modelName } from "./models"

export type FindingStatus = "proposed" | "verified" | "rejected"
export type Finding = {
	id: string
	author: string
	marketplace: Marketplace
	sku: string | null
	kind: LeakKind
	lossRub: number
	evidenceField: string
	fix: string
	status: FindingStatus
	verdict?: string
	engineLossRub?: number
	retryOf?: string
	postedAtMs: number
	verifiedAtMs?: number
}

export type AgentStat = {
	name: string
	role: string
	loops: number
	inFlight: number
	inferences: number
	toolCalls: number
	tokensIn: number
	tokensOut: number
	spans: { start: number; end?: number; label: string }[]
}

export type GateEvent = { atMs: number; agent: string; reason: string }

export class WarRoomState extends RuntimeState {
	readonly t0 = Date.now()
	board: Finding[] = []
	stats = new Map<string, AgentStat>()
	gate: GateEvent[] = []
	log: string[] = []
	settled = false
	retries = new Set<string>()
	errors = 0
	now() {
		return Date.now() - this.t0
	}
	stat(agent: Agent | { getId(): string; getManifest(): { name: string; capabilities?: readonly string[] } }): AgentStat {
		const id = agent.getId()
		let s = this.stats.get(id)
		if (!s) {
			s = { name: agent.getManifest().name, role: agent.getManifest().capabilities?.[0] ?? "", loops: 0, inFlight: 0, inferences: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, spans: [] }
			this.stats.set(id, s)
		}
		return s
	}
	nextFindingId() {
		return `F${this.board.length + 1}`
	}
}

export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendEvent, runLoop } = defineRuntime<WarRoomState>()

export const state = () => resolveRuntime().state

export function say(line: string) {
	const s = state()
	const msg = `${String(s.now()).padStart(6)}ms  ${line}`
	s.log.push(msg)
	if (!process.env.WARROOM_QUIET) console.log(msg)
}

export function emit(type: string, producerId: string, payload: unknown) {
	sendEvent(SemanticEvent.create(type, producerId, payload), producerId)
}

/**
 * Start an agent loop with a fresh context (developer message + task). Several loops of the same agent
 * may run at once (e.g. the Critic verifying several findings in parallel), so they must not share a context.
 */
export function startLoop(agent: Agent, label: string, task: string, interception?: InterceptionHandler) {
	const st = state().stat(agent)
	st.loops++
	st.inFlight++
	st.spans.push({ start: state().now(), label })
	const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
	Promise.resolve()
		.then(() => runLoop(agent.getId(), task, { model: modelName(), context, tools: agent.getTools() }, interception))
		.catch((e) => {
			say(`⚠️  ${agent.getManifest().name} loop "${label}" failed: ${String(e?.message ?? e).slice(0, 200)}`)
			endLoop(agent.getId())
			state().errors++
		})
}

/** Called on model.answer: closes the oldest open span of that agent. */
export function endLoop(agentId: string) {
	const st = state().stats.get(agentId)
	if (!st) return
	st.inFlight = Math.max(0, st.inFlight - 1)
	const open = st.spans.find((s) => s.end === undefined)
	if (open) open.end = state().now()
}
