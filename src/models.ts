/**
 * Inference config for the War Room.
 * - mock (default): deterministic local runner, no network, no key. Used by tests and the "runs per README" path.
 * - live + OPENROUTER_API_KEY: OpenAI-compatible chat completions via OpenRouter (model from WARROOM_MODEL).
 * - live without OpenRouter: Mozaik bundled models (gemini-3.5-flash with GEMINI_API_KEY, gpt-5.4-mini with OPENAI_API_KEY, ...).
 */
import {
	FunctionCallItem,
	FunctionCallOutputItem,
	ModelMessageItem,
	OpenAIChatCompletions,
	SemanticEvent,
	UserMessageItem,
	supportedModels,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
	type InferenceRunnerConfig,
} from "@mozaik-ai/core"

export const MODE = (process.env.WARROOM_MODE ?? "mock").toLowerCase() === "live" ? "live" : "mock"

const ALL_ITEMS = ["user_message", "system_message", "developer_message", "reasoning", "function_call", "function_call_output", "model_message"]

/**
 * Mock runner (no key, deterministic decisions, random 0.3–0.9 s latency so concurrency is real).
 * It plays the analysts and the Critic with simple scripted "reasoning" over the same tools a real LLM gets.
 * On purpose it makes three typical LLM mistakes so the safety nets are visible in the demo:
 *   - the WB analyst copies the wrong field for the teapot ads leak  → Critic rejects (number mismatch) → analyst retries
 *   - the YM analyst reports a gift-set overstock that is not one   → Critic rejects (not a leak) → analyst withdraws it
 *   - the Ozon analyst posts the same finding twice                  → the interception gate blocks the duplicate
 */
export class MockInferenceRunner implements InferenceRunner {
	constructor(private readonly latencyMs: [number, number] = [300, 900]) {}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const [lo, hi] = this.latencyMs
		await new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)))
		const items = input.context.getItems()
		const tools = (input.tools ?? []).map((t) => t.name)
		const out = tools.includes("verify_finding") ? criticTurn(items) : analystTurn(items)
		return { items: [out], tokenUsage: undefined, rowResponse: { mock: true } }
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}
}

const call = (name: string, args: unknown) => FunctionCallItem.rehydrate({ callId: `mock_${Math.random().toString(36).slice(2, 10)}`, name, args: JSON.stringify(args) })
const say = (text: string) => ModelMessageItem.rehydrate({ text })
const userTexts = (items: unknown[]) => items.filter((i) => i instanceof UserMessageItem).map((i) => (i as UserMessageItem).content.text)
const outputsOf = (items: unknown[], name: string) => {
	const calls = items.filter((i) => i instanceof FunctionCallItem && (i as FunctionCallItem).name === name) as FunctionCallItem[]
	const outs = items.filter((i) => i instanceof FunctionCallOutputItem) as FunctionCallOutputItem[]
	return calls.map((c) => outs.find((o) => (o as any).callId === (c as any).callId)?.output.text).filter(Boolean) as string[]
}

function criticTurn(items: unknown[]) {
	const done = outputsOf(items, "verify_finding")
	if (!done.length) {
		const id = /finding (F\d+)/.exec(userTexts(items)[0] ?? "")?.[1] ?? "F1"
		return call("verify_finding", { findingId: id })
	}
	const v = JSON.parse(done[0])
	return say(`${v.findingId} ${v.status}: ${v.verdict}`)
}

type Plan = { sku: string | null; kind: string; lossRub: number; evidenceField: string; fix: string }

function plan(m: any): Plan[] {
	const p: Plan[] = []
	const t = m.targets
	for (const s of m.skus) {
		const price = s.unitsSold ? Math.round(s.revenueRub / s.unitsSold) : 0
		if (s.unitsSold > 0 && s.unitProfitRub < t.marginPerUnitRub)
			p.push({ sku: s.sku, kind: "margin", lossRub: s.marginGapRub, evidenceField: "marginGapRub", fix: `Raise price from ~${price} ₽ to at least ${s.minPriceForTargetRub} ₽ (unit profit now ${s.unitProfitRub} ₽ vs target ${t.marginPerUnitRub} ₽).` })
		if (s.buyoutRate < t.minBuyoutRate)
			p.push({ sku: s.sku, kind: "returns", lossRub: s.returnCostRub, evidenceField: "returnCostRub", fix: `Buyout is ${Math.round(s.buyoutRate * 100)} %: improve packaging and check the listing photos/description.` })
		if (s.stockUnits === 0 && s.adSpendRub > 0)
			p.push({ sku: s.sku, kind: "ads_out_of_stock", lossRub: s.adSpendRub, evidenceField: "adSpendRub", fix: `Pause the campaign: stock is 0 but it spent ${s.adSpendRub} ₽.` })
		if (s.stockUnits > 0 && s.adOverspendRub > 0)
			p.push({ sku: s.sku, kind: "ads_drr", lossRub: s.adOverspendRub, evidenceField: "adOverspendRub", fix: `DRR is ${Math.round((s.drr ?? 0) * 100)} % vs ${Math.round(t.drr * 100)} % target: cut bids or pause weak phrases.` })
		if ((s.daysOfCover ?? 0) > t.maxDaysOfCover)
			p.push({ sku: s.sku, kind: "overstock", lossRub: s.storageRub, evidenceField: "storageRub", fix: `${s.stockUnits} units = ${s.daysOfCover} days of sales: stop supplies and run a clearance promo.` })
	}
	if (m.penaltiesRub > 0) p.push({ sku: null, kind: "penalty", lossRub: m.penaltiesRub, evidenceField: "penaltiesRub", fix: `${m.penaltiesCount} late-shipment penalties: move the shipping cut-off earlier.` })
	return p
}

function withMistakes(mp: string, p: Plan[], m: any): Plan[] {
	const q = p.map((x) => ({ ...x }))
	if (mp === "wb") {
		const pot = q.find((x) => x.sku === "ACC-POT-600" && x.kind === "ads_drr")
		const s = m.skus.find((x: any) => x.sku === "ACC-POT-600")
		if (pot && s) Object.assign(pot, { lossRub: s.adSpendRub, evidenceField: "adSpendRub" }) // wrong field
	}
	if (mp === "ym") {
		const s = m.skus.find((x: any) => x.sku === "TEA-GFT-SET")
		if (s) q.splice(1, 0, { sku: s.sku, kind: "overstock", lossRub: s.storageRub, evidenceField: "storageRub", fix: "Gift set looks overstocked before the holidays." }) // not a leak
	}
	if (mp === "ozon" && q.length > 1) q.splice(2, 0, { ...q[0] }) // duplicate
	return q
}

function analystTurn(items: unknown[]) {
	const metrics = outputsOf(items, "get_marketplace_metrics")
	if (!metrics.length) return call("get_marketplace_metrics", {})
	const m = JSON.parse(metrics[0])
	const users = userTexts(items)
	const retry = /^REJECTED .*?finding (F\d+) \((\w+), sku (\S+), lossRub/.exec(users[0] ?? "")
	const posted = outputsOf(items, "post_finding").length + users.filter((u) => u.startsWith("GATE:")).length
	if (retry) {
		const [, id, kind, skuRaw] = retry
		const sku = skuRaw === "null" ? null : skuRaw
		const fixed = plan(m).find((x) => x.kind === kind && x.sku === sku)
		if (!fixed) return say(`done: re-checked ${id}, it is not a leak under the rules — withdrawn.`)
		if (posted === 0) return call("post_finding", { ...fixed, retryOf: id })
		return say(`done: ${id} re-posted with ${fixed.evidenceField} = ${fixed.lossRub} ₽.`)
	}
	const todo = withMistakes(m.marketplace, plan(m), m)
	if (posted < todo.length) return call("post_finding", todo[posted])
	return say(`done: ${todo.length} findings`)
}

export function modelName(): string {
	if (MODE === "mock") return "mock"
	return process.env.WARROOM_MODEL ?? (process.env.OPENROUTER_API_KEY ? "google/gemini-2.5-flash" : "gemini-3.5-flash")
}

export function inferenceRunnerConfig(): InferenceRunnerConfig | undefined {
	if (MODE === "mock") {
		return { supportedModels: [], runner: new MockInferenceRunner() } as unknown as InferenceRunnerConfig
	}
	if (process.env.OPENROUTER_API_KEY) {
		return {
			supportedModels: [
				{
					endpoint: new OpenAIChatCompletions(undefined, { baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY }),
					specification: {
						name: modelName(),
						provider: "openai",
						supportsReasoningEffort: false,
						supportedReasoningEfforts: [],
						supportsStreaming: false,
						contextWindowSize: 1_000_000,
						supportedContextItemTypes: ALL_ITEMS,
						maxOutputTokens: 16_000,
						supportsFunctionCalling: true,
						supportsStructuredOutput: false,
					},
				},
			],
		} as unknown as InferenceRunnerConfig
	}
	return { supportedModels } as unknown as InferenceRunnerConfig // bundled models, keys from env
}
