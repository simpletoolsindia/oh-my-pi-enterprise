/**
 * Plugin settings UI components.
 *
 * Provides a hierarchical settings interface:
 * - Plugin list (locally installed/linked plugins)
 *   - Plugin details (enablement, feature toggles, manifest settings)
 */
import {
	type Component,
	Container,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { PluginManager } from "../../extensibility/plugins/manager";
import type { InstalledPlugin, PluginSettingSchema } from "../../extensibility/plugins/types";
import { getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { OverlayPanel } from "./overlay-box";

/**
 * Forwards a keystroke to `input`, but cancels via `onCancel` when the user presses Escape.
 *
 * Escape is decoded via `matchesKey` rather than a raw `\x1b` compare: inside the
 * fullscreen settings overlay the kitty keyboard protocol is active (ghostty/kitty),
 * where the Escape key arrives as the CSI-u sequence `\x1b[27u`, not a bare `\x1b`.
 * The literal fallbacks preserve legacy single/double-escape on terminals without it.
 */
export function handleInputOrEscape(
	data: string,
	input: { handleInput(data: string): void },
	onCancel: () => void,
): void {
	if (data === "\x1b" || data === "\x1b\x1b" || matchesKey(data, "escape")) {
		onCancel();
		return;
	}
	input.handleInput(data);
}

// =============================================================================
// Plugin List Component
// =============================================================================

/** One row in the plugin list (locally installed/linked plugins). */
export type PluginListEntry = { kind: "npm"; plugin: InstalledPlugin };

export interface PluginListCallbacks {
	onNpmSelect: (plugin: InstalledPlugin) => void;
	onCancel: () => void;
}

async function buildPluginConfigItems(
	plugin: InstalledPlugin,
	manager: PluginManager,
	onConfigChange: (key: string, value: unknown) => void,
): Promise<SettingItem[]> {
	const schemaSettings = plugin.manifest.settings;
	if (!schemaSettings) return [];

	const settings = await manager.getPluginSettings(plugin.name);
	const items: SettingItem[] = [];
	for (const key in schemaSettings) {
		const schema = schemaSettings[key];
		const currentValue = settings[key] ?? schema.default;
		const displayValue = schema.secret && currentValue ? "••••••••" : String(currentValue ?? "(not set)");

		if (schema.type === "boolean") {
			items.push({
				id: `config:${key}`,
				label: `  ${key}`,
				description: schema.description || `Configure ${key}`,
				currentValue: currentValue ? "true" : "false",
				values: ["true", "false"],
			});
		} else if (schema.type === "enum") {
			items.push({
				id: `config:${key}`,
				label: `  ${key}`,
				description: schema.description || `Configure ${key}`,
				currentValue: String(currentValue ?? schema.default ?? ""),
				submenu: (cv, done) =>
					new ConfigEnumSubmenu(
						key,
						schema.description || `Select value for ${key}`,
						schema.values,
						cv,
						value => {
							onConfigChange(key, value);
							done(value);
						},
						() => done(),
					),
			});
		} else {
			items.push({
				id: `config:${key}`,
				label: `  ${key}`,
				description: schema.description || `Configure ${key}`,
				currentValue: displayValue,
				submenu: (cv, done) =>
					new ConfigInputSubmenu(
						key,
						schema,
						cv === "(not set)" ? "" : cv,
						value => {
							const parsed = schema.type === "number" ? Number(value) : value;
							onConfigChange(key, parsed);
							done(String(value));
						},
						() => done(),
					),
			});
		}
	}
	return items;
}

/**
 * Stable SelectList value for a list entry. Combined with `findEntryByValue`
 * this keeps lookup correct across entries.
 */
function entryValue(entry: PluginListEntry): string {
	return `npm:${entry.plugin.name}`;
}

function findEntryByValue(entries: ReadonlyArray<PluginListEntry>, value: string): PluginListEntry | undefined {
	return entries.find(e => entryValue(e) === value);
}

/**
 * Shows locally installed/linked plugins with enable/disable status.
 * Selecting an entry opens its detail view.
 */
export class PluginListComponent extends OverlayPanel {
	readonly #selectList: SelectList;

	constructor(
		private readonly entries: ReadonlyArray<PluginListEntry>,
		callbacks: PluginListCallbacks,
	) {
		super("Plugins");
		this.addChild(new Spacer(1));

		if (entries.length === 0) {
			this.addChild(new Text(theme.fg("muted", "No plugins installed"), 0, 0));
			this.addChild(new Spacer(1));

			// Empty list still handles Escape so the user can leave the panel.
			this.#selectList = new SelectList([], 1, getSelectListTheme());
			this.#selectList.onCancel = callbacks.onCancel;
			return;
		}

		const items: SelectItem[] = entries.map(entry => this.#renderItem(entry));

		this.#selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme(), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 64,
		});

		this.#selectList.onSelect = item => {
			const found = findEntryByValue(this.entries, item.value);
			if (!found) return;
			callbacks.onNpmSelect(found.plugin);
		};

		this.#selectList.onCancel = callbacks.onCancel;

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Enter to configure · Esc to go back"), 0, 0));
	}

	#renderItem(entry: PluginListEntry): SelectItem {
		const p = entry.plugin;
		const status = p.enabled ? theme.fg("success", theme.status.enabled) : theme.fg("muted", theme.status.disabled);
		const featureCount = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
		const enabledCount = p.enabledFeatures?.length ?? featureCount;

		let details = `v${p.version}`;
		if (featureCount > 0) {
			details += ` ${theme.sep.dot} ${enabledCount}/${featureCount} features`;
		}

		return {
			value: entryValue(entry),
			label: `${status} ${p.name}`,
			description: details,
		};
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

// =============================================================================
// Plugin Detail Component
// =============================================================================

export interface PluginDetailCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onFeatureChange: (feature: string, enabled: boolean) => void;
	onConfigChange: (key: string, value: unknown) => void;
	onBack: () => void;
}

/**
 * Shows detail settings for a single plugin:
 * - Enable/disable toggle
 * - Feature toggles
 * - Config settings
 */
export class PluginDetailComponent extends OverlayPanel {
	#settingsList!: SettingsList;

	constructor(
		private plugin: InstalledPlugin,
		private readonly manager: PluginManager,
		private readonly callbacks: PluginDetailCallbacks,
	) {
		super(plugin.name);

		void this.#rebuild();
	}

	async #rebuild(): Promise<void> {
		this.clear();

		const plugin = this.plugin;
		const manifest = plugin.manifest;

		this.title = plugin.name;
		if (manifest.description) {
			this.addChild(new Text(theme.fg("muted", manifest.description), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [];

		// Enable/disable toggle
		items.push({
			id: "__enabled__",
			label: "Enabled",
			description: "Enable or disable this plugin",
			currentValue: plugin.enabled ? "true" : "false",
			values: ["true", "false"],
		});

		// Feature toggles
		if (manifest.features && Object.keys(manifest.features).length > 0) {
			const enabledSet = new Set(plugin.enabledFeatures ?? []);
			const defaultFeatures = Object.entries(manifest.features)
				.filter(([_, f]) => f.default)
				.map(([name]) => name);

			// If enabledFeatures is null, use defaults
			const effectiveEnabled = plugin.enabledFeatures === null ? new Set(defaultFeatures) : enabledSet;

			for (const [featName, feat] of Object.entries(manifest.features)) {
				const isEnabled = effectiveEnabled.has(featName);
				items.push({
					id: `feature:${featName}`,
					label: `  ${featName}`,
					description: feat.description || `Enable ${featName} feature`,
					currentValue: isEnabled ? "true" : "false",
					values: ["true", "false"],
				});
			}
		}

		items.push(...(await buildPluginConfigItems(plugin, this.manager, this.callbacks.onConfigChange)));

		this.#settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "__enabled__") {
					this.callbacks.onEnabledChange(newValue === "true");
					this.plugin = { ...this.plugin, enabled: newValue === "true" };
				} else if (id.startsWith("feature:")) {
					const featName = id.slice(8);
					this.callbacks.onFeatureChange(featName, newValue === "true");
					// Update local state
					const current = new Set(this.plugin.enabledFeatures ?? []);
					if (newValue === "true") {
						current.add(featName);
					} else {
						current.delete(featName);
					}
					this.plugin = { ...this.plugin, enabledFeatures: [...current] };
				} else if (id.startsWith("config:")) {
					const key = id.slice(7);
					const schema = this.plugin.manifest.settings?.[key];
					if (schema?.type === "boolean") {
						this.callbacks.onConfigChange(key, newValue === "true");
					}
				}
			},
			this.callbacks.onBack,
		);

		this.addChild(this.#settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Enter to edit · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		if (!this.#settingsList) return;
		this.#settingsList.handleInput(data);
	}
}

// =============================================================================
// Config Submenus
// =============================================================================

/**
 * Submenu for enum config values.
 */
class ConfigEnumSubmenu extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		key: string,
		description: string,
		values: string[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super(key);
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SelectItem[] = values.map(v => ({ value: v, label: v }));
		this.#selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme());

		const currentIndex = values.indexOf(currentValue);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => onSelect(item.value);
		this.#selectList.onCancel = onCancel;

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Enter to select · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

/**
 * Submenu for string/number config values with text input.
 */
class ConfigInputSubmenu extends OverlayPanel {
	#input: Input;

	constructor(
		key: string,
		schema: PluginSettingSchema,
		currentValue: string,
		private readonly onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super(key);
		if (schema.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", schema.description), 0, 0));
		}

		// Type hint
		let hint = `Type: ${schema.type}`;
		if (schema.type === "number") {
			const numSchema = schema as { min?: number; max?: number };
			if (numSchema.min !== undefined || numSchema.max !== undefined) {
				hint += ` (${numSchema.min ?? ""}..${numSchema.max ?? ""})`;
			}
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));

		this.addChild(new Spacer(1));

		// Input field
		this.#input = new Input();
		if (!schema.secret && currentValue) {
			this.#input.setValue(currentValue);
		}

		this.#input.onSubmit = value => {
			if (value.trim()) {
				this.onSubmit(value);
			} else {
				this.onCancel();
			}
		};

		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		handleInputOrEscape(data, this.#input, this.onCancel);
	}
}

// =============================================================================
// Main Plugin Settings Selector
// =============================================================================

export interface PluginSettingsCallbacks {
	onClose: () => void;
	onPluginChanged: () => void | Promise<void>;
	/** Schedules a TUI frame after asynchronous plugin data loads. */
	requestRender?: () => void;
}

/** Component with handleInput method */
interface InputHandler {
	handleInput(data: string): void;
}

/**
 * Top-level plugin settings component.
 * Manages navigation between plugin list and plugin detail views.
 */
export class PluginSettingsComponent extends Container {
	#manager: PluginManager;
	#viewComponent: (Component & InputHandler) | null = null;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: state tracking for view management
	#currentView: "list" | "npm-detail" = "list";
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: state tracking for view management
	#currentPlugin: InstalledPlugin | null = null;

	constructor(
		cwd: string,
		private readonly callbacks: PluginSettingsCallbacks,
	) {
		super();
		this.#manager = new PluginManager(cwd);
		this.#showPluginList();
	}

	async #showPluginList(): Promise<void> {
		this.#currentView = "list";
		this.#currentPlugin = null;
		this.clear();

		// Surface registry failures without taking the whole tab down — the
		// registry can fail to load (corrupt JSON, missing project root) and an
		// uncaught rejection here would leave the tab permanently blank: this
		// method is invoked fire-and-forget from the constructor, so nothing
		// awaits it.
		const npmPlugins = await this.#manager.list().catch(err => {
			logger.error("Settings → Plugins: failed to list npm plugins", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [] as InstalledPlugin[];
		});

		const entries: PluginListEntry[] = npmPlugins.map(plugin => ({ kind: "npm" as const, plugin }));

		this.#viewComponent = new PluginListComponent(entries, {
			onNpmSelect: plugin => this.#showPluginDetail(plugin),
			onCancel: () => this.callbacks.onClose(),
		});

		this.addChild(this.#viewComponent);

		// The list mounts after the first frame (listing is async and this
		// method runs fire-and-forget), so ask for a repaint — otherwise the
		// tab stays blank until an unrelated event forces a render, e.g.
		// reopening /settings (issue #9526).
		this.callbacks.requestRender?.();
	}

	#showPluginDetail(plugin: InstalledPlugin): void {
		this.#currentView = "npm-detail";
		this.#currentPlugin = plugin;
		this.clear();

		this.#viewComponent = new PluginDetailComponent(plugin, this.#manager, {
			onEnabledChange: async enabled => {
				await this.#manager.setEnabled(plugin.name, enabled);
				await this.callbacks.onPluginChanged();
			},
			onFeatureChange: async (feature, enabled) => {
				const current = new Set((await this.#manager.getEnabledFeatures(plugin.name)) ?? []);
				if (enabled) {
					current.add(feature);
				} else {
					current.delete(feature);
				}
				await this.#manager.setEnabledFeatures(plugin.name, [...current]);
				await this.callbacks.onPluginChanged();
			},
			onConfigChange: async (key, value) => {
				await this.#manager.setPluginSetting(plugin.name, key, value);
				await this.callbacks.onPluginChanged();
			},
			onBack: () => this.#showPluginList(),
		});

		this.addChild(this.#viewComponent);
	}

	handleInput(data: string): void {
		if (!this.#viewComponent) {
			// The list view mounts asynchronously (plugin listing).
			// Until it does — or if listing rejected and no view ever mounted —
			// Escape must still close the panel instead of leaving /settings
			// non-dismissible.
			if (data === "\x1b" || data === "\x1b\x1b") {
				this.callbacks.onClose();
			}
			return;
		}
		this.#viewComponent.handleInput(data);
	}
}
