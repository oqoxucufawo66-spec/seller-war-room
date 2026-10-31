/**
 * War Room participants:
 *  - Operator (human)        → publishes `audit.requested`
 *  - 3 marketplace analysts  → react to `audit.requested` concurrently, post findings to the shared board
 *  - Critic (agent)          → reacts to every `finding.posted`, re-computes the number, verifies or rejects
 *  - Trace observer (human)  → watches every runtime event: time, tokens, tool calls per agent
 *  - Reporter (human)        → fires once the board settles, writes the report
 * Nobody calls anybody: coordination happens through events and the shared WarRoomState.
 */
import {
	Agent,
	FunctionCallItem,
	ModelMessageItem,
	SituationSpecification,
	createAgent,
	createHuman,
	type ExecutableTransition,
	type InterceptionHandler,
	type SituationContext,
	type SituationHandler,
	type Tool,
	type TokenUsage,
} from "@mozaik-ai/core"
import { LEAK_KINDS, MARKETPLACES, MP_LABEL, leakValue, marketplaceMetrics, skuName, type LeakKind, type Marketplace } from "./engine"
import { emit, endLoop, say, startLoop, state, type Finding } from "./runtime"

const on = (type: string, extra?: (c: SituationContext) => boolean) =>
	new (class extends SituationSpecification {
		isSatisfiedBy(c: SituationContext) {
			return c.event.type === type && (extra ? extra(c) : true)
		}
	})()

const handler = (spec: SituationSpecification, apply: (c: SituationContext) => void): SituationHandler => ({ specification: spec, processor: { apply } })

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], invoke: (a: any) => unknown): Tool => ({
	type: "function",
	name,
	description,
	strict: false,
	parameters: { type: "object", properties, required, additionalProperties: false },
	invoke: async (a: any) => invoke(a ?? {}),
})

// ---------------------------------------------------------------- analysts

export const PLAYBOOK = `
Leak rules (use ONLY these; copy lossRub from the named field, never do arithmetic yourself):
- kind "margin":           unitsSold > 0 and unitProfitRub < targets.marginPerUnitRub   → lossRub = marginGapRub.  Fix: raise price to minPriceForTargetRub (or cut cost).
- kind "returns":          buyoutRate < targets.minBuyoutRate                             → lossRub = returnCostRub. Fix: packaging / listing accuracy.
- kind "ads_out_of_stock": stockUnits == 0 and adSpendRub > 0                             → lossRub = adSpendRub.    Fix: pause campaign until restock.
- kind "ads_drr":          stockUnits > 0 and adOverspendRub > 0 (drr above targets.drr) → lossRub = adOverspendRub. Fix: cut bids / pause weak phrases.
- kind "overstock":        daysOfCover > targets.maxDaysOfCover                           → lossRub = storageRub.    Fix: liquidate / move stock / stop supplies.
- kind "penalty":          penaltiesRub > 0 (store level, sku = null)                     → lossRub = penaltiesRub.  Fix: ship on time.`

const analystInstruction = (mp: Marketplace) => `You are the ${MP_LABEL[mp]} analyst in a marketplace seller's War Room.
Other analysts audit the other marketplaces at the same time; a Critic re-checks every number you post.
1. Call get_marketplace_metrics once.
2. Go through the SKUs one by one and check each rule's condition numerically against the metrics and targets.
   Most SKUs are healthy: post ONLY when the condition is actually true (e.g. buyoutRate 0.85 is NOT below 0.7; 53 days of cover is NOT above 90).
   Wrong posts are rejected by the Critic and count against you.
3. For each real leak call post_finding once (sku + kind + lossRub + evidenceField + a one-sentence fix with concrete numbers). Never re-post a finding.
4. When all leaks are posted, reply with one line: "done: N findings".
${PLAYBOOK}`

function analystTools(mp: Marketplace, author: () => string, authorId: () => string): Tool[] {
	return [
		tool("get_marketplace_metrics", `30-day unit economics per SKU for the ${MP_LABEL[mp]} store, plus targets and store-level penalties.`, {}, [], () => marketplaceMetrics(mp)),
		tool(
			"post_finding",
			"Post one money leak to the shared War Room board. The Critic will re-compute it.",
			{
				sku: { type: ["string", "null"], description: "SKU, or null for store-level penalties" },
				kind: { type: "string", enum: [...LEAK_KINDS] },
				lossRub: { type: "number", description: "RUB lost in the 30-day period, copied from evidenceField" },
				evidenceField: { type: "string", description: "metrics field the number was copied from, e.g. marginGapRub" },
				fix: { type: "string", description: "one concrete sentence: what to change" },
			},
			["sku", "kind", "lossRub", "evidenceField", "fix"],
			(a) => {
				const s = state()
				const f: Finding = {
					id: s.nextFindingId(),
					author: author(),
					marketplace: mp,
					sku: a.sku ?? null,
					kind: a.kind,
					lossRub: Number(a.lossRub),
					evidenceField: String(a.evidenceField ?? ""),
					fix: String(a.fix ?? ""),
					status: "proposed",
					retryOf: a.retryOf,
					postedAtMs: s.now(),
				}
				s.board.push(f)
				say(`📌 ${f.id} ${f.author}: ${f.kind} ${f.sku ?? "(store)"} −${f.lossRub.toLocaleString("en")} ₽ [proposed]`)
				emit("finding.posted", authorId(), { findingId: f.id })
				return { ok: true, findingId: f.id, note: "posted; the Critic is checking it" }
			},
		),
	]
}

/** Interception: a gate in front of post_finding — schema check + de-duplication against the shared board. */
class FindingGate implements InterceptionHandler {
	private blocked = 0
	constructor(private readonly mp: Marketplace, private readonly agentName: string, private retryKey?: string) {}
	private problem(call: FunctionCallItem): string | null {
		let a: any
		try {
			a = JSON.parse((call as any).args ?? "{}")
		} catch {
			return "arguments are not valid JSON"
		}
		if (!LEAK_KINDS.includes(a.kind)) return `unknown kind "${a.kind}"`
		if (typeof a.lossRub !== "number" || !(a.lossRub > 0)) return "lossRub must be a positive number"
		if (!a.evidenceField) return "evidenceField is required"
		if (a.kind !== "penalty" && !marketplaceMetrics(this.mp).skus.some((s) => s.sku === a.sku)) return `unknown sku "${a.sku}"`
		const sku = a.kind === "penalty" ? null : a.sku
		const dup = state().board.find((f) => f.marketplace === this.mp && f.kind === a.kind && f.sku === sku && f.status !== "rejected")
		if (dup) return `duplicate of ${dup.id} (${dup.status}) — already on the board`
		const key = `${sku}|${a.kind}`
		const rejected = state().board.find((f) => f.marketplace === this.mp && f.kind === a.kind && f.sku === sku && f.status === "rejected")
		if (rejected && key !== this.retryKey) return `${rejected.id} with the same sku and kind was already rejected by the Critic: ${rejected.verdict}`
		return null
	}
	isSatisfiedBy(t: ExecutableTransition) {
		if (t.nextStateId !== "function_call") return false
		const { call } = t.input as { call: FunctionCallItem }
		return call.name === "post_finding" && this.problem(call) !== null
	}
	async handle(t: ExecutableTransition): Promise<ExecutableTransition> {
		const { call, inferenceInput } = t.input as { call: FunctionCallItem; inferenceInput: any }
		const reason = this.problem(call)!
		this.blocked++
		state().gate.push({ atMs: state().now(), agent: this.agentName, reason })
		say(`⛔ gate blocked post_finding from ${this.agentName}: ${reason}`)
		return { nextStateId: "message_received", input: { content: `GATE: your post_finding call was blocked (${reason}). ${this.blocked >= 3 ? 'You keep repeating blocked posts: STOP now and reply "done: N findings".' : 'Do not repeat it. Continue with the remaining leaks, or reply "done: N findings".'}`, input: inferenceInput } }
	}
}

function makeAnalyst(mp: Marketplace): Agent {
	let self: Agent
	const name = `${MP_LABEL[mp]} Analyst`
	self = createAgent({
		name,
		capabilities: ["analyst", mp],
		instruction: analystInstruction(mp),
		tools: analystTools(mp, () => name, () => self.getId()),
		handlers: [
			handler(on("audit.requested"), () => {
				say(`▶ ${name} starts auditing ${MP_LABEL[mp]}`)
				startLoop(self, "audit", `Audit the ${MP_LABEL[mp]} store for the period and post every leak.`, new FindingGate(mp, name))
			}),
			// the Critic rejected one of *my* findings → one retry
			handler(
				on("finding.rejected", (c) => {
					const f = state().board.find((x) => x.id === (c.event.payload as any).findingId)
					return !!f && f.author === name && !state().retries.has(`${f.marketplace}|${f.sku}|${f.kind}`)
				}),
				(c) => {
					const f = state().board.find((x) => x.id === (c.event.payload as any).findingId)!
					state().retries.add(`${f.marketplace}|${f.sku}|${f.kind}`)
					say(`↻ ${name} re-checks ${f.id} after the Critic's rejection`)
					startLoop(
						self,
						`retry ${f.id}`,
						`REJECTED by the Critic: finding ${f.id} (${f.kind}, sku ${f.sku ?? "null"}, lossRub ${f.lossRub}). Reason: ${f.verdict}. ` +
							`Call get_marketplace_metrics, and if the leak is real post ONE corrected finding for the same sku and kind (copy lossRub from the right field). Then reply "done".`,
						new FindingGate(mp, name, `${f.sku}|${f.kind}`),
					)
				},
			),
		],
	})
	return self
}

export const analysts = MARKETPLACES.map(makeAnalyst)

// ---------------------------------------------------------------- critic

function verify(findingId: string) {
	const s = state()
	const f = s.board.find((x) => x.id === findingId)
	if (!f) return { error: `no finding ${findingId}` }
	if (f.status !== "proposed") return { findingId, status: f.status, verdict: f.verdict }
	const v = leakValue(f.marketplace, f.sku, f.kind)
	f.engineLossRub = v.lossRub
	const diff = v.lossRub ? Math.abs(f.lossRub - v.lossRub) / v.lossRub : 1
	if (!v.isLeak) {
		f.status = "rejected"
		f.verdict = `not a leak under the rule for "${f.kind}" (${v.why})`
	} else if (diff > 0.01) {
		f.status = "rejected"
		f.verdict = `number mismatch: posted ${f.lossRub} ₽, recomputed ${v.lossRub} ₽ from the raw export (${v.why})`
	} else {
		f.status = "verified"
		f.verdict = `recomputed ${v.lossRub} ₽ (${v.why})`
	}
	f.verifiedAtMs = s.now()
	say(`${f.status === "verified" ? "✅" : "❌"} ${f.id} ${f.status}: ${f.verdict}`)
	emit(`finding.${f.status}`, critic.getId(), { findingId: f.id })
	return { findingId: f.id, status: f.status, verdict: f.verdict }
}

let critic: Agent
critic = createAgent({
	name: "Critic",
	capabilities: ["critic"],
	instruction: `You are the Critic in a seller War Room. You trust nothing an analyst says until it is re-computed.
For the finding you are given, call verify_finding with its id (it re-computes the number from the raw marketplace export
with a deterministic engine). Then reply with ONE short sentence: the verdict and why.`,
	tools: [tool("verify_finding", "Re-compute a posted finding from the raw export and mark it verified or rejected.", { findingId: { type: "string" } }, ["findingId"], (a) => verify(String(a.findingId)))],
	handlers: [
		handler(on("finding.posted"), (c) => {
			const { findingId } = c.event.payload as { findingId: string }
			const f = state().board.find((x) => x.id === findingId)!
			startLoop(critic, `check ${findingId}`, `Check finding ${findingId}: ${JSON.stringify(f)}`)
		}),
	],
})
export { critic }

// ---------------------------------------------------------------- observer + settlement

const AGENT_IDS = () => [...analysts, critic].map((a) => a.getId())

export function isSettled() {
	const s = state()
	const busy = AGENT_IDS().some((id) => (s.stats.get(id)?.inFlight ?? 0) > 0)
	return !busy && s.board.length > 0 && s.board.every((f) => f.status !== "proposed")
}

export function makeObserver(onSettled: () => void) {
	const nameOf = (id: string) => [...analysts, critic].find((a) => a.getId() === id)?.getManifest().name ?? id
	const isAgent = (id: string) => AGENT_IDS().includes(id)
	return createHuman({
		name: "Trace Observer",
		capabilities: ["observer"],
		handlers: [
			handler(on("inference.completed", (c) => isAgent(c.event.producerId)), (c) => {
				const st = state().stats.get(c.event.producerId)
				if (!st) return
				st.inferences++
				const u = (c.event.payload as { tokenUsage?: TokenUsage }).tokenUsage
				if (u) {
					st.tokensIn += u.inputTokens ?? 0
					st.tokensOut += u.outputTokens ?? 0
				}
			}),
			handler(on("function_call.started", (c) => isAgent(c.event.producerId)), (c) => {
				const st = state().stats.get(c.event.producerId)
				if (st) st.toolCalls++
			}),
			handler(on("model.answer", (c) => isAgent(c.event.producerId)), (c) => {
				const { answer } = c.event.payload as { answer: ModelMessageItem }
				endLoop(c.event.producerId)
				say(`💬 ${nameOf(c.event.producerId)}: ${answer.content.text.replace(/\s+/g, " ").slice(0, 140)}`)
				// settle on the next tick so events published in this tick are processed first
				setImmediate(() => {
					if (!state().settled && isSettled()) {
						state().settled = true
						onSettled()
					}
				})
			}),
		],
	})
}

export const operator = createHuman({ name: "Operator", capabilities: ["human"], handlers: [] })
