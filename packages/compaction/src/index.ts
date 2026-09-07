/**
 * Configurable Compaction Extension
 *
 * 用用户维护的便宜模型清单生成压缩摘要。当前默认模型优先，其他模型按
 * fallbackLevel 从小到大兜底，全部失败后再回退到 Pi 官方默认压缩。
 *
 * 配置文件：~/.pi/agent/compaction-models.json
 * 命令：/compaction-model、/compaction-thinking、/compaction-threshold
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir, serializeConversation } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface CompactionModelEntry {
	provider: string;
	model: string;
	label?: string;
	thinkingLevel: ThinkingLevel;
	fallbackLevel: number;
}

export interface CompactionTriggerConfig {
	contextUsagePercent: number;
	maximumContextTokens: number;
}

export interface CompactionModelsConfig {
	default: string;
	models: CompactionModelEntry[];
	trigger: CompactionTriggerConfig;
}

export interface ActiveModelIdentity {
	provider: string;
	id: string;
	name?: string;
}

const CONFIG_PATH = join(getAgentDir(), "compaction-models.json");
const SUMMARY_MAX_OUTPUT_TOKENS = 65_536;
const SUMMARY_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_TRIGGER_CONFIG: Readonly<CompactionTriggerConfig> = Object.freeze({
	contextUsagePercent: 95,
	maximumContextTokens: 500_000,
});

export function createDefaultConfig(activeModel: ActiveModelIdentity): CompactionModelsConfig {
	const key = `${activeModel.provider}/${activeModel.id}`;
	return {
		default: key,
		models: [
			{
				provider: activeModel.provider,
				model: activeModel.id,
				label: activeModel.name?.trim() || key,
				thinkingLevel: "off",
				fallbackLevel: 0,
			},
		],
		trigger: { ...DEFAULT_TRIGGER_CONFIG },
	};
}

function modelKey(entry: Pick<CompactionModelEntry, "provider" | "model">): string {
	return `${entry.provider}/${entry.model}`;
}

export function parseTriggerConfig(value: unknown): CompactionTriggerConfig {
	if (!value || typeof value !== "object") throw new Error("trigger must be an object");
	const raw = value as Record<string, unknown>;
	const contextUsagePercent = raw.contextUsagePercent;
	const maximumContextTokens = raw.maximumContextTokens;
	if (typeof contextUsagePercent !== "number" || !Number.isFinite(contextUsagePercent) || contextUsagePercent <= 0 || contextUsagePercent > 100) {
		throw new Error("trigger.contextUsagePercent must be greater than 0 and at most 100");
	}
	if (typeof maximumContextTokens !== "number" || !Number.isSafeInteger(maximumContextTokens) || maximumContextTokens < 1) {
		throw new Error("trigger.maximumContextTokens must be a positive safe integer");
	}
	return { contextUsagePercent, maximumContextTokens };
}

export function parseConfig(value: unknown): CompactionModelsConfig {
	if (!value || typeof value !== "object") throw new Error("root must be an object");
	const raw = value as { default?: unknown; models?: unknown; trigger?: unknown };
	if (!Array.isArray(raw.models) || raw.models.length === 0) {
		throw new Error("models must be a non-empty array");
	}

	const seen = new Set<string>();
	const models = raw.models.map((item, index): CompactionModelEntry => {
		if (!item || typeof item !== "object") throw new Error(`models[${index}] must be an object`);
		const entry = item as Record<string, unknown>;
		const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
		const model = typeof entry.model === "string" ? entry.model.trim() : "";
		if (!provider || !model) throw new Error(`models[${index}] requires provider and model`);

		const key = `${provider}/${model}`;
		if (seen.has(key)) throw new Error(`duplicate model ${key}`);
		seen.add(key);

		const requestedThinking = entry.thinkingLevel;
		const thinkingLevel = THINKING_LEVELS.includes(requestedThinking as ThinkingLevel)
			? (requestedThinking as ThinkingLevel)
			: "off";
		const fallbackLevel =
			typeof entry.fallbackLevel === "number" && Number.isFinite(entry.fallbackLevel)
				? Math.max(0, Math.floor(entry.fallbackLevel))
				: index;

		return {
			provider,
			model,
			label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : undefined,
			thinkingLevel,
			fallbackLevel,
		};
	});

	const requestedDefault = typeof raw.default === "string" ? raw.default.trim() : "";
	const defaultKey = models.some((entry) => modelKey(entry) === requestedDefault)
		? requestedDefault
		: modelKey(models[0]);
	const trigger = raw.trigger === undefined
		? { ...DEFAULT_TRIGGER_CONFIG }
		: parseTriggerConfig(raw.trigger);

	return { default: defaultKey, models, trigger };
}

function saveConfig(config: CompactionModelsConfig): void {
	const tempPath = `${CONFIG_PATH}.tmp-${process.pid}`;
	writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tempPath, CONFIG_PATH);
}

function loadConfig(activeModel?: ActiveModelIdentity): { config?: CompactionModelsConfig; error?: string } {
	try {
		if (!existsSync(CONFIG_PATH)) {
			if (!activeModel) return { error: "configuration is missing and no active model is selected" };
			const config = createDefaultConfig(activeModel);
			saveConfig(config);
			return { config };
		}
		return { config: parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8"))) };
	} catch (error) {
		return {
			config: activeModel ? createDefaultConfig(activeModel) : undefined,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function getCompactionAttemptOrder(config: CompactionModelsConfig): CompactionModelEntry[] {
	const primary = config.models.find((entry) => modelKey(entry) === config.default) ?? config.models[0];
	const fallbacks = config.models
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => entry !== primary)
		.sort((a, b) => a.entry.fallbackLevel - b.entry.fallbackLevel || a.index - b.index)
		.map(({ entry }) => entry);
	return [primary, ...fallbacks];
}

function getSupportedThinkingLevels(model: {
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if ((level === "xhigh" || level === "max") && typeof mapped !== "string") return false;
		return true;
	});
}

function getEffectiveThinkingLevel(
	entry: CompactionModelEntry,
	model: { reasoning: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> },
): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	if (supported.includes(entry.thinkingLevel)) return entry.thinkingLevel;
	return supported.includes("off") ? "off" : (supported[0] ?? "off");
}

export function getProactiveCompactionThreshold(
	contextWindow: number,
	trigger: CompactionTriggerConfig = DEFAULT_TRIGGER_CONFIG,
): number {
	return Math.max(
		1,
		Math.min(Math.floor(contextWindow * trigger.contextUsagePercent / 100), trigger.maximumContextTokens),
	);
}

// 与 Pi 原生 compaction 使用相同的系统约束，防止模型把历史对话当成待续写内容。
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const REQUIRED_SUMMARY_HEADINGS = [
	"## Goal",
	"## Constraints & Preferences",
	"## Progress",
	"## Key Decisions",
	"## Next Steps",
	"## Critical Context",
] as const;

const SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Preserve all previous data, add new data needed to continue]`;

export default function (pi: ExtensionAPI) {
	let proactiveCompactionPending = false;

	const notifyConfigError = (ctx: { hasUI: boolean; ui: { notify(message: string, type?: "warning"): void } }, error?: string) => {
		if (error && ctx.hasUI) {
			ctx.ui.notify(`Invalid ${CONFIG_PATH} (${error}); using the active model for this session`, "warning");
		}
	};

	pi.registerCommand("compaction-model", {
		description: "Choose the default model from compaction-models.json",
		handler: async (args, ctx) => {
			const loaded = loadConfig(ctx.model);
			notifyConfigError(ctx, loaded.error);
			const { config } = loaded;
			if (!config) {
				ctx.ui.notify(`No compaction configuration or active model is available`, "error");
				return;
			}

			let selectedKey: string | undefined;
			const query = args.trim();
			if (query) {
				const match = config.models.find(
					(entry) => modelKey(entry) === query || entry.label?.toLowerCase() === query.toLowerCase(),
				);
				if (!match) {
					ctx.ui.notify(`Model is not in ${CONFIG_PATH}: ${query}`, "error");
					return;
				}
				selectedKey = modelKey(match);
			} else {
				const displayToKey = new Map<string, string>();
				const options = config.models.map((entry) => {
					const key = modelKey(entry);
					const display = `${key === config.default ? "●" : "○"} ${entry.label ?? key} · ${key} · thinking:${entry.thinkingLevel} · fallback:${entry.fallbackLevel}`;
					displayToKey.set(display, key);
					return display;
				});
				const selected = await ctx.ui.select(`Default compaction model (${CONFIG_PATH})`, options);
				if (!selected) return;
				selectedKey = displayToKey.get(selected);
			}

			if (!selectedKey) return;
			config.default = selectedKey;
			saveConfig(config);
			const entry = config.models.find((item) => modelKey(item) === selectedKey);
			ctx.ui.notify(
				`Default compaction model: ${entry?.label ?? selectedKey} (${selectedKey}, thinking:${entry?.thinkingLevel ?? "off"})`,
				"info",
			);
		},
	});

	pi.registerCommand("compaction-thinking", {
		description: "Set thinking level for the current default compaction model",
		handler: async (args, ctx) => {
			const loaded = loadConfig(ctx.model);
			notifyConfigError(ctx, loaded.error);
			const { config } = loaded;
			if (!config) {
				ctx.ui.notify(`No compaction configuration or active model is available`, "error");
				return;
			}
			const entry = config.models.find((item) => modelKey(item) === config.default) ?? config.models[0];
			const model = ctx.modelRegistry.find(entry.provider, entry.model);
			const supported = model ? getSupportedThinkingLevels(model) : [...THINKING_LEVELS];

			let selectedLevel: ThinkingLevel | undefined;
			const query = args.trim();
			if (query) {
				if (!supported.includes(query as ThinkingLevel)) {
					ctx.ui.notify(`Unsupported thinking level for ${modelKey(entry)}: ${query}`, "error");
					return;
				}
				selectedLevel = query as ThinkingLevel;
			} else {
				const options = supported.map((level) => `${level === entry.thinkingLevel ? "●" : "○"} ${level}`);
				const selected = await ctx.ui.select(`Thinking for ${entry.label ?? modelKey(entry)}`, options);
				if (!selected) return;
				selectedLevel = selected.slice(2) as ThinkingLevel;
			}

			entry.thinkingLevel = selectedLevel;
			saveConfig(config);
			ctx.ui.notify(`Compaction thinking for ${entry.label ?? modelKey(entry)}: ${selectedLevel}`, "info");
		},
	});

	pi.registerCommand("compaction-threshold", {
		description: "Show or set proactive threshold: <context-percent> [maximum-context-tokens]",
		handler: async (args, ctx) => {
			const loaded = loadConfig(ctx.model);
			notifyConfigError(ctx, loaded.error);
			const { config } = loaded;
			if (!config) {
				ctx.ui.notify(`No compaction configuration or active model is available`, "error");
				return;
			}

			const query = args.trim();
			if (!query) {
				ctx.ui.notify(
					`Compaction threshold: ${config.trigger.contextUsagePercent}% of context, capped at ${config.trigger.maximumContextTokens.toLocaleString()} tokens`,
					"info",
				);
				return;
			}

			const parts = query.split(/\s+/);
			if (parts.length > 2) {
				ctx.ui.notify(`Usage: /compaction-threshold <context-percent> [maximum-context-tokens]`, "error");
				return;
			}
			try {
				config.trigger = parseTriggerConfig({
					contextUsagePercent: Number(parts[0]),
					maximumContextTokens: parts[1] === undefined
						? config.trigger.maximumContextTokens
						: Number(parts[1].replaceAll(",", "")),
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			saveConfig(config);
			ctx.ui.notify(
				`Compaction threshold: ${config.trigger.contextUsagePercent}% of context, capped at ${config.trigger.maximumContextTokens.toLocaleString()} tokens`,
				"info",
			);
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		const loaded = loadConfig(ctx.model);
		notifyConfigError(ctx, loaded.error);
		const { config } = loaded;
		if (!config) return;

		// Pi 原生 threshold 使用固定 reserveTokens。若它早于我们的动态阈值触发，先取消；
		// 手动压缩与 Context Overflow 始终立即处理。
		if (event.reason === "threshold" && ctx.model) {
			const targetThreshold = getProactiveCompactionThreshold(ctx.model.contextWindow, config.trigger);
			if (tokensBefore < targetThreshold) return { cancel: true };
		}

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		if (allMessages.length === 0) return;

		const conversationText = serializeConversation(convertToLlm(allMessages));
		let basePrompt = previousSummary ? UPDATE_SUMMARY_PROMPT : SUMMARY_PROMPT;
		if (event.customInstructions) {
			basePrompt += `\n\nAdditional focus: ${event.customInstructions}`;
		}
		let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (previousSummary) {
			promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		}
		promptText += basePrompt;
		const summaryMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];

		const attempts = getCompactionAttemptOrder(config);

		for (let index = 0; index < attempts.length; index++) {
			if (signal.aborted) return;
			const entry = attempts[index];
			const key = modelKey(entry);
			const model = ctx.modelRegistry.find(entry.provider, entry.model);
			if (!model) {
				if (ctx.hasUI) ctx.ui.notify(`Compaction model unavailable: ${key}; trying next fallback`, "warning");
				continue;
			}

			const thinkingLevel = getEffectiveThinkingLevel(entry, model);
			const maxTokens = Math.min(
				SUMMARY_MAX_OUTPUT_TOKENS,
				model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Compaction ${index + 1}/${attempts.length}: ${entry.label ?? key} (${key}, thinking ${thinkingLevel}, max ${maxTokens.toLocaleString()} output, timeout 5m)`,
					"info",
				);
			}

			const requestController = new AbortController();
			let timedOut = false;
			const abortFromSession = () => requestController.abort(signal.reason);
			if (signal.aborted) abortFromSession();
			else signal.addEventListener("abort", abortFromSession, { once: true });
			const timeoutId = setTimeout(() => {
				timedOut = true;
				requestController.abort(new Error("Compaction model timed out"));
			}, SUMMARY_TIMEOUT_MS);

			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summaryMessages },
					{
						maxTokens,
						...(thinkingLevel === "off" ? {} : { reasoningEffort: thinkingLevel }),
						signal: requestController.signal,
						cacheRetention: "none",
						sessionId: uuidv7(),
					},
				);

				if (response.stopReason !== "stop") {
					const detail = response.errorMessage ? `: ${response.errorMessage}` : "";
					if (ctx.hasUI) {
						ctx.ui.notify(`${entry.label ?? key} stopped with ${response.stopReason}${detail}; trying next fallback`, "warning");
					}
					continue;
				}

				const summary = response.content
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map((content) => content.text)
					.join("\n")
					.trim();
				const missingHeadings = REQUIRED_SUMMARY_HEADINGS.filter((heading) => !summary.includes(heading));
				if (!summary || missingHeadings.length > 0) {
					const reason = !summary ? "empty" : `missing ${missingHeadings.join(", ")}`;
					if (ctx.hasUI) ctx.ui.notify(`${entry.label ?? key} summary invalid (${reason}); trying next fallback`, "warning");
					continue;
				}

				return {
					compaction: {
						summary,
						firstKeptEntryId,
						tokensBefore,
						usage: response.usage,
						details: {
							compactionModel: key,
							thinkingLevel,
							fallbackLevel: entry.fallbackLevel,
							attempt: index + 1,
						},
					},
				};
			} catch (error) {
				if (signal.aborted) return;
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) {
					ctx.ui.notify(
						timedOut
							? `${entry.label ?? key} timed out after 5 minutes; trying next fallback`
							: `${entry.label ?? key} failed (${message}); trying next fallback`,
						timedOut ? "warning" : "error",
					);
				}
			} finally {
				clearTimeout(timeoutId);
				signal.removeEventListener("abort", abortFromSession);
			}
		}

		if (ctx.hasUI) {
			ctx.ui.notify("Configured compaction models exhausted; using Pi default compaction", "warning");
		}
		return;
	});

	// Pi 原生 reserveTokens 是固定值，不能表达百分比加绝对上限。
	// 在一次 Agent 运行完全结束后主动压缩，避免中途打断工具调用链。
	pi.on("agent_settled", (_event, ctx) => {
		if (proactiveCompactionPending || !ctx.isIdle()) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === undefined || usage.tokens === null) return;
		const currentTokens = usage.tokens;
		const loaded = loadConfig(ctx.model);
		const { config } = loaded;
		if (!config) return;
		const threshold = getProactiveCompactionThreshold(usage.contextWindow, config.trigger);
		if (currentTokens < threshold) return;
		notifyConfigError(ctx, loaded.error);

		proactiveCompactionPending = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Proactive compaction: ${currentTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tok (threshold ${threshold.toLocaleString()})`,
				"info",
			);
		}
		ctx.compact({
			onComplete: () => {
				proactiveCompactionPending = false;
				if (ctx.hasUI) ctx.ui.notify("Proactive compaction completed", "info");
			},
			onError: (error) => {
				proactiveCompactionPending = false;
				if (ctx.hasUI) ctx.ui.notify(`Proactive compaction failed: ${error.message}`, "error");
			},
		});
	});

	pi.on("session_compact", () => {
		proactiveCompactionPending = false;
	});
}
