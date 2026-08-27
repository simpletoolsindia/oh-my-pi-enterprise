/**
 * The provider catalog table: one entry per chat-model provider, carrying the
 * catalog half of what used to live in `@oh-my-pi/pi-ai`'s registry definitions
 * (default model, runtime model-manager factory, discovery wiring). The auth
 * half (env keys, OAuth login/refresh) stays in the pi-ai registry, which
 * type-checks itself against `KnownProvider` from this table.
 *
 * This build supports exactly one provider: a user-configured, generic
 * OpenAI-compatible endpoint (server URL, model, API key), wired through the
 * config-driven custom-model pipeline in `packages/coding-agent/src/config/`.
 * `custom-models.ts` accepts any provider name a user configures and does not
 * depend on this table; the single "custom" entry below only exists so
 * default-model/UI code that reads `PROVIDER_DESCRIPTORS`/`CATALOG_PROVIDERS`
 * has something sane to iterate over.
 */
import type { ProviderCatalogEntry, ProviderDescriptor } from "./descriptor-types";

export const CATALOG_PROVIDERS = [
	{
		id: "custom",
		defaultModel: "custom-model",
	},
] as const satisfies readonly ProviderCatalogEntry[];

/** Chat-model providers — every entry in the catalog table. */
export type KnownProvider = (typeof CATALOG_PROVIDERS)[number]["id"];

/**
 * Runtime model-discovery descriptors: every catalog provider that exposes a
 * standard model-manager factory. Special-managed providers
 * (`google-antigravity`/`google-gemini-cli`/`openai-codex`) are built bespoke in
 * the coding-agent runtime and are excluded here.
 */
const CATALOG_ENTRY_LIST: readonly ProviderCatalogEntry[] = CATALOG_PROVIDERS;

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = CATALOG_ENTRY_LIST.flatMap(provider => {
	if (!provider.createModelManagerOptions || provider.specialModelManager) {
		return [];
	}
	return [
		{
			providerId: provider.id,
			defaultModel: provider.defaultModel,
			createModelManagerOptions: provider.createModelManagerOptions,
			allowUnauthenticated: provider.allowUnauthenticated,
			dynamicModelsAuthoritative: provider.dynamicModelsAuthoritative,
			catalogDiscovery: provider.catalogDiscovery
				? { ...provider.catalogDiscovery, envVars: provider.catalogDiscovery.envVars ?? provider.envVars ?? [] }
				: undefined,
		},
	];
});

/** Default model IDs for all known providers, derived from the catalog table. */
export const DEFAULT_MODEL_PER_PROVIDER: Record<KnownProvider, string> = Object.fromEntries(
	CATALOG_PROVIDERS.map(provider => [provider.id, provider.defaultModel] as [string, string]),
) as Record<KnownProvider, string>;

export function getCatalogProviderEntry(id: string): ProviderCatalogEntry | undefined {
	return CATALOG_PROVIDERS.find(provider => provider.id === id);
}
