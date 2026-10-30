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

/** Mock runner: first turn calls the agent's first tool with args derived from the task, second turn answers. */
export class MockInferenceRunner implements InferenceRunner {
	constructor(private readonly latencyMs: [number, number] = [300, 700]) {}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const [lo, hi] = this.latencyMs
		await new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)))
		const items = input.context.getItems()
		const task = [...items].reverse().find((i) => i instanceof UserMessageItem) as UserMessageItem | undefined
		const toolOutputs = items.filter((i) => i instanceof FunctionCallOutputItem) as FunctionCallOutputItem[]
		const tool = input.tools?.[toolOutputs.length]
		if (tool) {
			return {
				items: [FunctionCallItem.rehydrate({ callId: `mock_${Math.random().toString(36).slice(2, 10)}`, name: tool.name, args: JSON.stringify({ task: task?.content.text ?? "" }) })],
				tokenUsage: undefined,
				rowResponse: { mock: true },
			}
		}
		const last = toolOutputs.at(-1)?.output.text ?? "no tool output"
		return { items: [ModelMessageItem.rehydrate({ text: `[mock] done. Last tool said: ${last}` })], tokenUsage: undefined, rowResponse: { mock: true } }
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}
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
