import { afterEach, describe, expect, it } from "bun:test";
import { configureRecallFeatures, enhancedRecallEnabled, proactiveLinkingEnabled } from "@oh-my-pi/pi-mnemopi/config";
import { isEnhancedRecallEnabled, isQueryCacheEnabled } from "@oh-my-pi/pi-mnemopi/core/query-cache";

afterEach(() => {
	configureRecallFeatures({ enhancedRecall: false, proactiveLinking: false });
});

describe("configureRecallFeatures", () => {
	it("keeps all recall gates on by default", () => {
		expect(enhancedRecallEnabled({})).toBe(true);
		expect(proactiveLinkingEnabled({})).toBe(true);
		expect(isEnhancedRecallEnabled({})).toBe(true);
		expect(isQueryCacheEnabled(true, {})).toBe(true);
	});

	it("enables the gates from host configuration when the env vars are unset", () => {
		configureRecallFeatures({ enhancedRecall: true, proactiveLinking: true });
		expect(enhancedRecallEnabled({})).toBe(true);
		expect(proactiveLinkingEnabled({})).toBe(true);
		expect(isEnhancedRecallEnabled({})).toBe(true);
		expect(isQueryCacheEnabled(true, {})).toBe(true);
		expect(isQueryCacheEnabled(false, {})).toBe(false);
	});

	it("lets the env vars override the configured value in both directions", () => {
		configureRecallFeatures({ enhancedRecall: true, proactiveLinking: true });
		expect(enhancedRecallEnabled({ MNEMOPI_ENHANCED_RECALL: "0" })).toBe(false);
		expect(proactiveLinkingEnabled({ MNEMOPI_PROACTIVE_LINKING: "0" })).toBe(false);
		expect(isQueryCacheEnabled(true, { MNEMOPI_ENHANCED_RECALL: "0" })).toBe(false);

		configureRecallFeatures({ enhancedRecall: false, proactiveLinking: false });
		expect(enhancedRecallEnabled({ MNEMOPI_ENHANCED_RECALL: "1" })).toBe(true);
		expect(proactiveLinkingEnabled({ MNEMOPI_PROACTIVE_LINKING: "1" })).toBe(true);
		expect(isQueryCacheEnabled(true, { MNEMOPI_ENHANCED_RECALL: "1" })).toBe(true);
	});

	it("updates only the flags that are present", () => {
		configureRecallFeatures({ enhancedRecall: false, proactiveLinking: false });
		configureRecallFeatures({ enhancedRecall: true });
		expect(enhancedRecallEnabled({})).toBe(true);
		expect(proactiveLinkingEnabled({})).toBe(false);
		configureRecallFeatures({ proactiveLinking: true });
		expect(enhancedRecallEnabled({})).toBe(true);
		expect(proactiveLinkingEnabled({})).toBe(true);
	});
});
