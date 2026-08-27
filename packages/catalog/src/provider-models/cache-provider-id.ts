export interface ModelCacheProviderIdOptions {
	apiKey?: string;
	baseUrl?: string;
}

/** Resolve the cache namespace used by a provider's model-manager options without constructing those options. */
export function resolveModelCacheProviderId(providerId: string, _options: ModelCacheProviderIdOptions = {}): string {
	return providerId;
}
