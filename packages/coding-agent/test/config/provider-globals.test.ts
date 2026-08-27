import { afterEach, describe, expect, it, vi } from "bun:test";
import { applyProviderGlobalsFromSettings } from "@oh-my-pi/pi-coding-agent/config/provider-globals";
import * as imageGen from "@oh-my-pi/pi-coding-agent/tools/image-gen";

describe("applyProviderGlobalsFromSettings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reapplies valid image provider globals from cwd-scoped settings", () => {
		const imageOrderSpy = vi.spyOn(imageGen, "setImageProviderOrder").mockImplementation(() => {});

		applyProviderGlobalsFromSettings({
			get(path: "providers.imageOrder"): unknown {
				const values: Record<string, unknown> = {
					"providers.imageOrder": ["xai", 42, "gemini"],
				};
				return values[path];
			},
		});

		expect(imageOrderSpy).toHaveBeenCalledWith(["xai", "gemini"]);
	});
});
