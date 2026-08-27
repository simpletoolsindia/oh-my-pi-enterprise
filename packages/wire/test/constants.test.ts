import { describe, expect, it } from "bun:test";
import { INTENT_FIELD } from "../src";

describe("wire constants", () => {
	it("exports the intent tracing field key", () => {
		expect(INTENT_FIELD).toBe("i");
	});
});
