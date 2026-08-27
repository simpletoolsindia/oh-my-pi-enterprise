import { setImageProviderOrder } from "../tools/image-gen";

interface ProviderGlobalSettings {
	get(path: "providers.imageOrder"): unknown;
}

export function applyProviderGlobalsFromSettings(settings: ProviderGlobalSettings): void {
	const orderedImageProviders = settings.get("providers.imageOrder");
	if (Array.isArray(orderedImageProviders)) {
		setImageProviderOrder(orderedImageProviders.filter((entry): entry is string => typeof entry === "string"));
	}
}
