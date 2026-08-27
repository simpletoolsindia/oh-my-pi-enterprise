/**
 * HTTP discovery protocols for configured providers — openai-models-list, and
 * new-api/one-api-style proxies. `ModelRegistry` owns the orchestration
 * (status, state, caching) and calls `discoverModelsByProviderType` with a
 * `DiscoveryContext`.
 */
import { type ApiKey, type FetchImpl, withAuth } from "@oh-my-pi/pi-ai";
import type { Api, Model, RemoteCompactionConfig } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS,
} from "@oh-my-pi/pi-catalog/discovery/openai-compatible";
import {
	getBundledModelReferenceIndex,
	inheritReferenceThinking,
	resolveModelReference,
	stripBracketedModelIdAffixes,
} from "@oh-my-pi/pi-catalog/identity";
import type { ModelSpec, OpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ProviderDiscovery } from "./models-config-schema";

// Default cap on `max_tokens` for auto-discovered models that do not advertise
// their own output limit (OpenAI-models-list, new-api/one-api proxies). 32K
// matches the upper end of what mainstream OpenAI-compatible providers
// (DeepSeek, MiMo, OpenRouter, etc.) actually accept and keeps
// `min(contextWindow, …)` honoring smaller local windows. Conservative caps
// below this caused providers to drop the connection mid-stream when models
// hit the cap on legitimate large tool calls (see issue #1528: `write`
// payloads >~5KB on deepseek-v4-pro surfaced as "socket connection was closed
// unexpectedly").
export const DISCOVERY_DEFAULT_CONTEXT_WINDOW = OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW;
export const DISCOVERY_DEFAULT_MAX_TOKENS = OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS;

function toPositiveNumberOrUndefined(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

/**
 * Run `fn` with a hard deadline while also signalling cooperative transports
 * to abort. The independent rejection keeps discovery bounded when a runtime
 * leaves its fetch promise pending after `AbortSignal.abort()` (observed with
 * Windows localhost probes).
 *
 * The backing timer is cleared as soon as `fn` settles, unlike
 * `AbortSignal.timeout()`, whose delayed reason previously crashed Bun's
 * concurrent GC during an unrelated allocation.
 */
async function withTimeoutSignal<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		const error = new DOMException("The operation timed out.", "TimeoutError");
		controller.abort(error);
		timeout.reject(error);
	}, timeoutMs);
	try {
		return await Promise.race([fn(controller.signal), timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

// Anthropic-safe variant of the discovery cap. The Anthropic stream converter
// in `packages/ai/src/providers/anthropic.ts` derives the request limit as
// `(model.maxTokens / 3) | 0`, so the 32K default would surface as 10,922
// requested output tokens — above the 8,192 hard cap on classic Claude 3.x
// Sonnet/Haiku/Opus endpoints. Discovered models routed through
// `anthropic-messages` (proxy `supported_endpoint_types: ["anthropic"]` or a
// custom provider with `api: anthropic-messages` + openai-models-list
// discovery) fall back to this conservative value.
const DISCOVERY_DEFAULT_MAX_TOKENS_ANTHROPIC = 8_192;

/** Routes discovered-model `maxTokens` defaults around Anthropic's 3× output divisor. */
export function discoveryDefaultMaxTokens(api: Api | undefined): number {
	return api === "anthropic-messages" ? DISCOVERY_DEFAULT_MAX_TOKENS_ANTHROPIC : DISCOVERY_DEFAULT_MAX_TOKENS;
}

export interface DiscoveryProviderConfig {
	provider: string;
	api: Api;
	baseUrl?: string;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: RemoteCompactionConfig<Api>;
	discovery: ProviderDiscovery;
	optional?: boolean;
}

/** Registry-provided capabilities the protocol probes need; never the registry itself. */
export interface DiscoveryContext {
	/** Injected fetch implementation (tests stub this). */
	fetch: FetchImpl;
	/**
	 * Resolve a provider's bearer credential for `Authorization: Bearer …`.
	 * Returns undefined when no key is stored or it is a local/no-auth
	 * sentinel; otherwise an {@link ApiKey} whose resolver participates in the
	 * central force-refresh/rotate auth-retry policy on 401/usage-limit.
	 */
	getBearerApiKeyResolver(provider: string): Promise<ApiKey | undefined>;
}

export function discoverModelsByProviderType(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	switch (providerConfig.discovery.type) {
		case "openai-models-list":
			return discoverOpenAIModelsList(providerConfig, ctx);
		case "proxy":
			return discoverProxyModels(providerConfig, ctx);
	}
}

/**
 * Read image-input support from an OpenAI-compatible `/v1/models` row. Handles
 * direct `input` arrays, Synthetic-style top-level `input_modalities`, and
 * OpenRouter-style `architecture.input_modalities`; returns undefined when none
 * is present so the bundled reference (or the `["text"]` default) can take over.
 */
function extractOpenAIModelsListInputCapabilities(item: {
	input?: unknown;
	input_modalities?: unknown;
	architecture?: unknown;
}): ("text" | "image")[] | undefined {
	const modalities = new Set<string>();
	const collect = (value: unknown): void => {
		if (!Array.isArray(value)) return;
		for (const entry of value) {
			if (typeof entry === "string") modalities.add(entry.toLowerCase());
		}
	};
	collect(item.input);
	collect(item.input_modalities);
	if (isRecord(item.architecture)) collect(item.architecture.input_modalities);
	if (modalities.size === 0) return undefined;
	return modalities.has("image") ? ["text", "image"] : ["text"];
}

export async function discoverOpenAIModelsList(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	let headers = baseHeaders;
	const timeoutMs = providerConfig.discovery.timeoutMs ?? 10_000;
	const attempt = async (h: Record<string, string>) => {
		const payload = await withTimeoutSignal(timeoutMs, async signal => {
			const res = await ctx.fetch(modelsUrl, {
				headers: h,
				signal,
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} from ${modelsUrl}`);
			}
			headers = h;
			return (await res.json()) as {
				data?: Array<{
					id?: string;
					max_model_len?: unknown;
					context_length?: unknown;
					input?: unknown;
					input_modalities?: unknown;
					architecture?: unknown;
				}>;
			};
		});
		return payload;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const payload = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const models = payload.data ?? [];
	const references = getBundledModelReferenceIndex();
	const discovered: Model<Api>[] = [];
	for (const item of models) {
		const id = item.id;
		if (!id) continue;
		// Thin OpenAI-compatible proxies frequently omit `context_length`/
		// `max_model_len` on `/v1/models`, leaving discovered models pinned at
		// the 128K default even when the underlying model is e.g. a proxied
		// Claude with a 1M window. Resolve the id against the bundled catalog
		// (same pattern as `discoverProxyModels`) so intrinsic metadata —
		// context/output limits, display name, modality, reasoning support —
		// flows through when the provider is silent. Local runtime state and
		// provider-reported values still win; proxy-specific headers/baseUrl/cost
		// stay local.
		const reference = resolveModelReference(id, references) as ModelSpec<Api> | undefined;
		const referenceCompat = reference?.compat as OpenAICompat | undefined;
		const api = providerConfig.api;
		const contextWindow =
			toPositiveNumberOrUndefined(item.max_model_len) ??
			toPositiveNumberOrUndefined(item.context_length) ??
			reference?.contextWindow ??
			DISCOVERY_DEFAULT_CONTEXT_WINDOW;
		discovered.push(
			buildModel({
				id,
				name: reference?.name ?? id,
				api,
				provider: providerConfig.provider,
				baseUrl,
				reasoning: reference?.reasoning ?? false,
				thinking: inheritReferenceThinking(undefined, reference, providerConfig.provider),
				input: extractOpenAIModelsListInputCapabilities(item) ?? reference?.input ?? ["text"],
				// Proxy/gateway pricing is provider-specific and rarely matches
				// upstream bundled catalogs, so keep costs local-unknown even
				// when we successfully recover the upstream model identity.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				// Cap the reference's output limit at the discovered context
				// window so an ID collision with a larger bundled model can
				// never request more tokens than the local runtime advertises.
				maxTokens: Math.min(reference?.maxTokens ?? discoveryDefaultMaxTokens(api), contextWindow),
				headers,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: referenceCompat?.supportsReasoningEffort ?? false,
					...(referenceCompat?.reasoningEffortMap
						? { reasoningEffortMap: referenceCompat.reasoningEffortMap }
						: {}),
					...(referenceCompat?.omitReasoningEffort !== undefined
						? { omitReasoningEffort: referenceCompat.omitReasoningEffort }
						: {}),
				},
			} as ModelSpec<Api>),
		);
	}
	return discovered;
}

/**
 * Discover models from an Anthropic+OpenAI-compatible reseller proxy that
 * exposes both `/v1/messages` and `/v1/chat/completions`, advertising each
 * model's wire capabilities through `supported_endpoint_types` on
 * `GET /v1/models` (new-api / one-api-style proxies).
 *
 * Routing per model:
 *   supported_endpoint_types: ["anthropic", ...] -> api: "anthropic-messages"
 *   supported_endpoint_types: ["openai"]         -> api: "openai-completions"
 *   missing / neither                            -> provider-level api fallback
 *
 * Anthropic models share the same baseUrl; the Anthropic SDK strips a
 * trailing `/v1` itself before appending `/v1/messages`, so the discovery
 * URL (which ends in `/v1`) round-trips correctly.
 */
export async function discoverProxyModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	let headers = baseHeaders;
	const timeoutMs = providerConfig.discovery.timeoutMs ?? 10_000;
	const attempt = async (h: Record<string, string>) =>
		withTimeoutSignal(timeoutMs, async signal => {
			const res = await ctx.fetch(modelsUrl, {
				headers: h,
				signal,
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} from ${modelsUrl}`);
			}
			headers = h;
			return (await res.json()) as {
				data?: Array<{ id?: string; name?: string; supported_endpoint_types?: string[]; context_length?: number }>;
			};
		});
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const payload = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const items = payload.data ?? [];
	const discovered: Model<Api>[] = [];
	for (const item of items) {
		const id = item.id;
		if (!id) continue;
		const endpoints = item.supported_endpoint_types ?? [];
		const api: Api | undefined = endpoints.includes("anthropic")
			? "anthropic-messages"
			: endpoints.includes("openai")
				? "openai-completions"
				: providerConfig.api;
		if (!api) continue;
		const isAnthropic = api === "anthropic-messages";
		const reference = resolveModelReference(id, getBundledModelReferenceIndex());
		const discoveryName = typeof item.name === "string" ? item.name.trim() : "";
		const displayName =
			(discoveryName && discoveryName !== id ? discoveryName : undefined) ??
			reference?.name ??
			stripBracketedModelIdAffixes(id) ??
			id;
		discovered.push(
			buildModel({
				id,
				name: displayName,
				api,
				provider: providerConfig.provider,
				baseUrl,
				reasoning: reference?.reasoning ?? false,
				thinking: inheritReferenceThinking(undefined, reference, providerConfig.provider),
				input: reference?.input ?? ["text"],
				// Proxy pricing is provider-specific and usually does not match
				// upstream bundled catalogs, so keep costs local-unknown even when
				// we successfully recover the upstream model identity.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// Prefer the context_length the API reports for this model; fall
				// back to the bundled reference, then a sane default.
				contextWindow:
					toPositiveNumberOrUndefined(item.context_length) ??
					reference?.contextWindow ??
					DISCOVERY_DEFAULT_CONTEXT_WINDOW,
				maxTokens: reference?.maxTokens ?? discoveryDefaultMaxTokens(api),
				headers,
				// OpenAI-compat fields are no-ops on anthropic models; the
				// Anthropic SDK ignores them. Provider-level disableStrictTools
				// flows in via #applyProviderCompat for the third-party-Anthropic
				// path. Cross-wire bundled compat is intentionally not copied:
				// request-shaping fields are provider-wire specific.
				compat: isAnthropic
					? undefined
					: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
			} as ModelSpec<Api>),
		);
	}
	return discovered;
}

export function normalizeOpenAIModelsListBaseUrl(baseUrl?: string): string {
	const defaultBaseUrl = "http://127.0.0.1:1234/v1";
	const raw = baseUrl || defaultBaseUrl;
	try {
		const parsed = new URL(raw);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return raw;
	}
}
