/**
 * First-run code graph index build. Shown once per project (whenever
 * `.omp/codegraph.db` doesn't exist yet in the workspace) as a blocking
 * full-screen overlay before the interactive chat surface becomes usable —
 * mirrors `startup-splash.ts`'s "run before the main loop starts" shape, but
 * driven by real progress-stage callbacks from the in-process indexer instead
 * of a fixed timer.
 */
import { type Component, type OverlayFocusOwner, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { buildIndex, isIndexed } from "../../utils/local-code-graph";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

const TICK_MS = 90;
const BAR_WIDTH = 24;

function padLine(line: string, width: number): string {
	const visible = visibleWidth(line);
	return visible >= width ? truncateToWidth(line, width) : `${line}${" ".repeat(width - visible)}`;
}

/** A bouncing indeterminate marquee — codegraph's CLI doesn't report a percentage. */
function marqueeBar(tick: number, width: number): string {
	const barWidth = Math.max(8, Math.min(BAR_WIDTH, width));
	const segment = Math.max(2, Math.floor(barWidth / 4));
	const span = barWidth - segment;
	const phase = tick % (span * 2);
	const pos = phase <= span ? phase : span * 2 - phase;
	const before = "░".repeat(pos);
	const filled = "█".repeat(segment);
	const after = "░".repeat(barWidth - pos - segment);
	return `${theme.fg("muted", before)}${theme.fg("accent", filled)}${theme.fg("muted", after)}`;
}

class CodegraphScanOverlayComponent implements Component, OverlayFocusOwner {
	#status = "Starting…";
	#tick = 0;
	#timer: ReturnType<typeof setInterval> | undefined;
	/** Aborts the in-flight scan when the user presses Esc. */
	readonly #skip = new AbortController();
	#skipped = false;

	constructor(readonly ctx: InteractiveModeContext) {}

	setStatus(status: string): void {
		this.#status = status;
		this.ctx.ui.requestRender();
	}

	async run(cwd: string, signal?: AbortSignal): Promise<void> {
		this.#startTimer();
		this.ctx.ui.requestRender();
		// Compose the caller's shutdown signal with the Esc-to-skip control so
		// either can end the scan.
		const composed = signal ? AbortSignal.any([signal, this.#skip.signal]) : this.#skip.signal;
		try {
			await buildIndex(cwd, stage => this.setStatus(stage), composed);
		} catch (error) {
			// A skip is a deliberate user action, not a failure: the tool
			// rebuilds the index on demand the first time it is actually used.
			if (this.#skipped) logger.debug("Code graph initial scan skipped by user");
			else logger.warn("Code graph initial scan failed", { error: String(error) });
		} finally {
			this.#stopTimer();
		}
	}

	dispose(): void {
		this.#stopTimer();
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	/**
	 * Esc abandons the scan and drops straight into the session. Indexing a
	 * large repository takes tens of seconds, and blocking the prompt that long
	 * with no way out is the wrong trade when the `codegraph` tool can rebuild
	 * the index lazily on its first real use.
	 */
	handleInput(data: string): void {
		if (data !== "\x1b" || this.#skipped) return;
		this.#skipped = true;
		this.setStatus("Skipping…");
		this.#skip.abort();
	}

	render(width: number): readonly string[] {
		const w = Math.max(20, width);
		const border = theme.fg("border", theme.boxRound.horizontal.repeat(w));
		const title = theme.fg("accent", "Indexing code graph") + theme.fg("muted", " (first run for this project)");
		const bar = marqueeBar(this.#tick, Math.max(8, w - 4));
		const status = theme.fg("muted", `${this.#status}  `) + theme.fg("border", "esc to skip");
		return [border, padLine(` ${title}`, w), padLine(` ${bar}`, w), padLine(` ${status}`, w), border];
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick++;
			this.ctx.ui.requestRender();
		}, TICK_MS);
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}
}

/**
 * Runs the first-time code graph scan as a blocking startup overlay, if (and
 * only if) codegraph is enabled and this project hasn't been indexed yet.
 * No-op otherwise — returns immediately.
 */
export async function runCodegraphScanIfNeeded(
	ctx: InteractiveModeContext,
	cwd: string,
	enabled: boolean,
	signal?: AbortSignal,
): Promise<void> {
	if (!enabled) return;
	if (isIndexed(cwd)) return;

	const component = new CodegraphScanOverlayComponent(ctx);
	const overlay = ctx.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		ctx.ui.setFocus(component);
		await component.run(cwd, signal);
	} finally {
		component.dispose();
		ctx.ui.setFocus(component);
		overlay.hide();
	}
}
