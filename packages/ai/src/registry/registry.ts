import type { KnownProvider } from "@oh-my-pi/pi-catalog";
import type { ProviderDefinition } from "./types";

/**
 * The single per-provider list. Adding a provider = create `./providers/<id>.ts`
 * and add its export here. Every legacy structure (`KnownProvider`/`OAuthProvider`
 * unions, descriptors, env map, login list, refresh/login dispatch, CLI callback
 * maps) is derived from this registry.
 *
 * This build supports exactly one provider: a user-configured, generic
 * OpenAI-compatible endpoint. It needs no env-key fallback, no OAuth login
 * flow, and no callback server — server URL, model, and API key all come from
 * the user's `models` config, resolved by `packages/coding-agent/src/config/
 * custom-models.ts`.
 */
const customProvider = {
	id: "custom",
	name: "Custom",
} as const satisfies ProviderDefinition;

const ALL = [customProvider];

export type RegistryDef = (typeof ALL)[number];
export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = ALL;

const BY_ID = new Map<string, ProviderDefinition>(ALL.map(p => [p.id, p] as [string, ProviderDefinition]));

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
	return BY_ID.get(id);
}

/** Compile-time completeness: every catalog chat-model provider must have a registry definition. */
type _MissingCatalogProviders = Exclude<KnownProvider, RegistryDef["id"]>;
type _CheckRegistryComplete = _MissingCatalogProviders extends never
	? true
	: ["registry is missing catalog providers", _MissingCatalogProviders];
true satisfies _CheckRegistryComplete;

/** Loginable providers (those carrying a `login` flow). */
export type OAuthProviderUnion = Extract<RegistryDef, { login: object }>["id"];
