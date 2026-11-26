import {
	App,
	PluginSettingTab,
	Setting,
	requireApiVersion,
	type SettingDefinitionItem,
} from "obsidian";
import {
	STYLE_PRESET_LABELS,
	formatHotkeyForDisplay,
	normalizeHotkeyKey,
} from "../canvas/canvasConfig";
import type SimpleMindMapPlugin from "../main";
import {
	DEFAULT_HOTKEYS,
	DEFAULT_SETTINGS,
	type ContextMenuLanguage,
	type MarkdownSerializeStyle,
	type MindMapDirection,
	type MindMapHotkeys,
	type MindMapStylePreset,
	type SplitLayout,
	type ThemeMode,
} from "./types";

const DIRECTION_OPTIONS: Record<MindMapDirection, string> = {
	side: "两侧分布 (Side)",
	right: "向右展开 (Right)",
	left: "向左展开 (Left)",
	down: "向下展开 (Down)",
};

const SPLIT_LAYOUT_OPTIONS: Record<SplitLayout, string> = {
	"left-right": "左右拆分 (Left-Right)",
	"top-bottom": "上下拆分 (Top-Bottom)",
};

const MARKDOWN_STYLE_OPTIONS: Record<MarkdownSerializeStyle, string> = {
	"heading-list": "标题 + 列表（# 中心 / ## 分支 / - 子节点）",
	list: "纯无序列表（- 缩进层级）",
};

const THEME_MODE_OPTIONS: Record<ThemeMode, string> = {
	auto: "跟随 Obsidian 主题",
	light: "始终浅色",
	dark: "始终深色",
};

const CONTEXT_MENU_LANGUAGE_OPTIONS: Record<ContextMenuLanguage, string> = {
	"zh-CN": "简体中文",
	"zh-TW": "繁體中文",
	en: "English",
	ja: "日本語",
	ko: "한국어",
};

const EXPORT_SCALE_OPTIONS: Record<string, string> = {
	"1": "1x (标准)",
	"2": "2x (高清，推荐)",
	"3": "3x (超清)",
};

const HOTKEY_HELP_TEXT =
	"填写 KeyboardEvent.key 名称（例如 Tab、Enter、F2、Delete、F1、Space）。切换脑图/源码默认快捷键为 Ctrl+.；注意在中文输入法且光标位于源码或节点编辑框内时，Windows 输入法可能先拦截 Ctrl+. 切换标点，建议在 Obsidian「设置 → 快捷键」中将其改绑为 Alt+M 或 Ctrl+Shift+M。";

const HOTKEY_FIELDS: ReadonlyArray<{
	key: keyof MindMapHotkeys;
	name: string;
	desc: string;
}> = [
	{
		key: "addChild",
		name: "添加子节点",
		desc: "为当前选中节点添加下级子节点（默认 Tab）",
	},
	{
		key: "addSibling",
		name: "添加兄弟节点",
		desc: "在当前节点下方添加同级节点（默认 Enter）",
	},
	{
		key: "editNode",
		name: "编辑节点内容",
		desc: "进入选中节点的编辑框（默认 F2，也可直接双击节点）",
	},
	{
		key: "deleteNode",
		name: "删除节点",
		desc: "删除当前选中的节点（默认 Delete）",
	},
	{
		key: "centerMap",
		name: "画布居中",
		desc: "将脑图重新居中到视图中央（默认 F1）",
	},
	{
		key: "toggleCollapse",
		name: "折叠 / 展开节点",
		desc: "切换当前节点的子节点折叠状态（默认 Space）",
	},
];

const HOTKEY_KEY_PREFIX = "hotkey.";

export class MindMapSettingTab extends PluginSettingTab {
	private plugin: SimpleMindMapPlugin;

	constructor(app: App, plugin: SimpleMindMapPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "常规与外观",
				items: [
					{
						name: "自动以脑图视图打开",
						desc: "打开包含 `mindmap-plugin` 属性的 Markdown 文件时，默认直接进入脑图编辑视图",
						control: {
							type: "toggle",
							key: "autoOpenMindMap",
							defaultValue: DEFAULT_SETTINGS.autoOpenMindMap,
						},
					},
					{
						name: "默认脑图布局",
						desc: "新建脑图或文件未指定方向时使用的默认展开方式",
						control: {
							type: "dropdown",
							key: "defaultDirection",
							options: DIRECTION_OPTIONS,
							defaultValue: DEFAULT_SETTINGS.defaultDirection,
						},
					},
					{
						name: "默认脑图样式",
						desc: "新建脑图或文件未指定 `mindmap-style` 时使用的节点与连线风格",
						control: {
							type: "dropdown",
							key: "defaultStylePreset",
							options: STYLE_PRESET_LABELS,
							defaultValue: DEFAULT_SETTINGS.defaultStylePreset,
						},
					},
					{
						name: "默认拆分视图布局",
						desc: "使用「切换拆分视图」命令同时编辑脑图与源码时的默认分屏方向",
						control: {
							type: "dropdown",
							key: "defaultSplitLayout",
							options: SPLIT_LAYOUT_OPTIONS,
							defaultValue: DEFAULT_SETTINGS.defaultSplitLayout,
						},
					},
					{
						name: "Markdown 保存格式",
						desc: "在图谱上编辑后写回 .md 文件的结构风格",
						control: {
							type: "dropdown",
							key: "markdownStyle",
							options: MARKDOWN_STYLE_OPTIONS,
							defaultValue: DEFAULT_SETTINGS.markdownStyle,
						},
					},
					{
						name: "主题模式",
						desc: "控制脑图画布的明暗配色",
						control: {
							type: "dropdown",
							key: "themeMode",
							options: THEME_MODE_OPTIONS,
							defaultValue: DEFAULT_SETTINGS.themeMode,
						},
					},
					{
						name: "节点右键菜单语言",
						desc: "控制画布中右键点击节点时弹出操作菜单的显示语言（默认简体中文）",
						control: {
							type: "dropdown",
							key: "contextMenuLanguage",
							options: CONTEXT_MENU_LANGUAGE_OPTIONS,
							defaultValue: DEFAULT_SETTINGS.contextMenuLanguage,
						},
					},
					{
						name: "紧凑模式",
						desc: "缩小节点间距，适合节点数量较多的大型脑图",
						control: {
							type: "toggle",
							key: "compactMode",
							defaultValue: DEFAULT_SETTINGS.compactMode,
						},
					},
				],
			},
			{
				type: "group",
				heading: "文件与图片导出",
				items: [
					{
						name: "新建脑图默认目录",
						desc: "留空则创建在当前打开文件所在目录（或库根目录）",
						control: {
							type: "text",
							key: "defaultNewFolder",
							placeholder: "例如：MindMaps",
							defaultValue: DEFAULT_SETTINGS.defaultNewFolder,
						},
					},
					{
						name: "图片导出目录",
						desc: "导出 PNG / SVG 时保存到库内的目录，留空则保存在脑图同级目录",
						control: {
							type: "text",
							key: "exportFolder",
							placeholder: "例如：Attachments/MindMaps",
							defaultValue: DEFAULT_SETTINGS.exportFolder,
						},
					},
					{
						name: "PNG 导出清晰度倍率",
						desc: "倍率越高导出图片越清晰（推荐 2x）",
						control: {
							type: "dropdown",
							key: "exportScale",
							options: EXPORT_SCALE_OPTIONS,
							defaultValue: String(DEFAULT_SETTINGS.exportScale),
						},
					},
				],
			},
			{
				type: "group",
				heading: "画布快捷键自定义",
				items: [
					{
						name: "快捷键说明",
						desc: HOTKEY_HELP_TEXT,
						searchable: false,
					},
					...HOTKEY_FIELDS.map((field) => ({
						name: field.name,
						desc: field.desc,
						control: {
							type: "text" as const,
							key: `${HOTKEY_KEY_PREFIX}${field.key}`,
							placeholder: formatHotkeyForDisplay(DEFAULT_HOTKEYS[field.key]),
							defaultValue: formatHotkeyForDisplay(DEFAULT_HOTKEYS[field.key]),
						},
					})),
					{
						name: "恢复默认快捷键",
						desc: "将画布快捷键重置为默认配置",
						action: () => {
							void this.resetHotkeys(true);
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key.startsWith(HOTKEY_KEY_PREFIX)) {
			const hotkeyKey = key.slice(
				HOTKEY_KEY_PREFIX.length
			) as keyof MindMapHotkeys;
			if (hotkeyKey in this.plugin.settings.hotkeys) {
				return formatHotkeyForDisplay(this.plugin.settings.hotkeys[hotkeyKey]);
			}
			return "";
		}

		switch (key) {
			case "autoOpenMindMap":
				return this.plugin.settings.autoOpenMindMap;
			case "defaultDirection":
				return this.plugin.settings.defaultDirection;
			case "defaultStylePreset":
				return this.plugin.settings.defaultStylePreset;
			case "defaultSplitLayout":
				return this.plugin.settings.defaultSplitLayout;
			case "markdownStyle":
				return this.plugin.settings.markdownStyle;
			case "themeMode":
				return this.plugin.settings.themeMode;
			case "contextMenuLanguage":
				return this.plugin.settings.contextMenuLanguage;
			case "compactMode":
				return this.plugin.settings.compactMode;
			case "defaultNewFolder":
				return this.plugin.settings.defaultNewFolder;
			case "exportFolder":
				return this.plugin.settings.exportFolder;
			case "exportScale":
				return String(this.plugin.settings.exportScale);
			default:
				return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key.startsWith(HOTKEY_KEY_PREFIX)) {
			const hotkeyKey = key.slice(
				HOTKEY_KEY_PREFIX.length
			) as keyof MindMapHotkeys;
			if (hotkeyKey in this.plugin.settings.hotkeys) {
				this.plugin.settings.hotkeys[hotkeyKey] = normalizeHotkeyKey(
					typeof value === "string" ? value : ""
				);
				await this.plugin.saveSettings();
				this.plugin.refreshOpenMindMaps();
			}
			return;
		}

		switch (key) {
			case "autoOpenMindMap":
				this.plugin.settings.autoOpenMindMap = Boolean(value);
				await this.plugin.saveSettings();
				return;
			case "defaultDirection":
				this.plugin.settings.defaultDirection = value as MindMapDirection;
				await this.plugin.saveSettings();
				return;
			case "defaultStylePreset":
				this.plugin.settings.defaultStylePreset = value as MindMapStylePreset;
				await this.plugin.saveSettings();
				this.plugin.refreshOpenMindMaps();
				return;
			case "defaultSplitLayout":
				this.plugin.settings.defaultSplitLayout = value as SplitLayout;
				await this.plugin.saveSettings();
				return;
			case "markdownStyle":
				this.plugin.settings.markdownStyle = value as MarkdownSerializeStyle;
				await this.plugin.saveSettings();
				return;
			case "themeMode":
				this.plugin.settings.themeMode = value as ThemeMode;
				await this.plugin.saveSettings();
				this.plugin.refreshOpenMindMaps();
				return;
			case "contextMenuLanguage":
				this.plugin.settings.contextMenuLanguage = value as ContextMenuLanguage;
				await this.plugin.saveSettings();
				this.plugin.refreshOpenMindMaps();
				return;
			case "compactMode":
				this.plugin.settings.compactMode = Boolean(value);
				await this.plugin.saveSettings();
				this.plugin.refreshOpenMindMaps();
				return;
			case "defaultNewFolder":
				this.plugin.settings.defaultNewFolder =
					typeof value === "string" ? value.trim() : "";
				await this.plugin.saveSettings();
				return;
			case "exportFolder":
				this.plugin.settings.exportFolder =
					typeof value === "string" ? value.trim() : "";
				await this.plugin.saveSettings();
				return;
			case "exportScale":
				this.plugin.settings.exportScale = Number(value) || 2;
				await this.plugin.saveSettings();
				return;
		}
	}

	display(): void {
		this.renderImperativeSettings();
	}

	private async resetHotkeys(useDeclarativeUpdate: boolean): Promise<void> {
		this.plugin.settings.hotkeys = { ...DEFAULT_HOTKEYS };
		await this.plugin.saveSettings();
		this.plugin.refreshOpenMindMaps();
		if (useDeclarativeUpdate) {
			if (requireApiVersion("1.13.0")) {
				this.update();
			}
		} else {
			this.renderImperativeSettings();
		}
	}

	private renderImperativeSettings(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- 常规设置 ---
		new Setting(containerEl).setName("常规与外观").setHeading();

		new Setting(containerEl)
			.setName("自动以脑图视图打开")
			.setDesc(
				"打开包含 `mindmap-plugin` 属性的 Markdown 文件时，默认直接进入脑图编辑视图"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoOpenMindMap)
					.onChange(async (value) => {
						await this.setControlValue("autoOpenMindMap", value);
					})
			);

		new Setting(containerEl)
			.setName("默认脑图布局")
			.setDesc("新建脑图或文件未指定方向时使用的默认展开方式")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(DIRECTION_OPTIONS)
					.setValue(this.plugin.settings.defaultDirection)
					.onChange(async (value) => {
						await this.setControlValue("defaultDirection", value);
					})
			);

		new Setting(containerEl)
			.setName("默认脑图样式")
			.setDesc("新建脑图或文件未指定 `mindmap-style` 时使用的节点与连线风格")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(STYLE_PRESET_LABELS)
					.setValue(this.plugin.settings.defaultStylePreset)
					.onChange(async (value) => {
						await this.setControlValue("defaultStylePreset", value);
					})
			);

		new Setting(containerEl)
			.setName("默认拆分视图布局")
			.setDesc("使用「切换拆分视图」命令同时编辑脑图与源码时的默认分屏方向")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(SPLIT_LAYOUT_OPTIONS)
					.setValue(this.plugin.settings.defaultSplitLayout)
					.onChange(async (value) => {
						await this.setControlValue("defaultSplitLayout", value);
					})
			);

		new Setting(containerEl)
			.setName("Markdown 保存格式")
			.setDesc("在图谱上编辑后写回 .md 文件的结构风格")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(MARKDOWN_STYLE_OPTIONS)
					.setValue(this.plugin.settings.markdownStyle)
					.onChange(async (value) => {
						await this.setControlValue("markdownStyle", value);
					})
			);

		new Setting(containerEl)
			.setName("主题模式")
			.setDesc("控制脑图画布的明暗配色")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(THEME_MODE_OPTIONS)
					.setValue(this.plugin.settings.themeMode)
					.onChange(async (value) => {
						await this.setControlValue("themeMode", value);
					})
			);

		new Setting(containerEl)
			.setName("节点右键菜单语言")
			.setDesc("控制画布中右键点击节点时弹出操作菜单的显示语言（默认简体中文）")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(CONTEXT_MENU_LANGUAGE_OPTIONS)
					.setValue(this.plugin.settings.contextMenuLanguage)
					.onChange(async (value) => {
						await this.setControlValue("contextMenuLanguage", value);
					})
			);

		new Setting(containerEl)
			.setName("紧凑模式")
			.setDesc("缩小节点间距，适合节点数量较多的大型脑图")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.compactMode)
					.onChange(async (value) => {
						await this.setControlValue("compactMode", value);
					})
			);

		// --- 文件与导出 ---
		new Setting(containerEl).setName("文件与图片导出").setHeading();

		new Setting(containerEl)
			.setName("新建脑图默认目录")
			.setDesc("留空则创建在当前打开文件所在目录（或库根目录）")
			.addText((text) =>
				text
					.setPlaceholder("例如：MindMaps")
					.setValue(this.plugin.settings.defaultNewFolder)
					.onChange(async (value) => {
						await this.setControlValue("defaultNewFolder", value);
					})
			);

		new Setting(containerEl)
			.setName("图片导出目录")
			.setDesc("导出 PNG / SVG 时保存到库内的目录，留空则保存在脑图同级目录")
			.addText((text) =>
				text
					.setPlaceholder("例如：Attachments/MindMaps")
					.setValue(this.plugin.settings.exportFolder)
					.onChange(async (value) => {
						await this.setControlValue("exportFolder", value);
					})
			);

		new Setting(containerEl)
			.setName("PNG 导出清晰度倍率")
			.setDesc("倍率越高导出图片越清晰（推荐 2x）")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(EXPORT_SCALE_OPTIONS)
					.setValue(String(this.plugin.settings.exportScale))
					.onChange(async (value) => {
						await this.setControlValue("exportScale", value);
					})
			);

		// --- 快捷键设置 ---
		new Setting(containerEl).setName("画布快捷键自定义").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: HOTKEY_HELP_TEXT,
		});

		for (const field of HOTKEY_FIELDS) {
			const displayVal = formatHotkeyForDisplay(
				this.plugin.settings.hotkeys[field.key]
			);

			new Setting(containerEl)
				.setName(field.name)
				.setDesc(field.desc)
				.addText((text) =>
					text
						.setPlaceholder(formatHotkeyForDisplay(DEFAULT_HOTKEYS[field.key]))
						.setValue(displayVal)
						.onChange(async (val) => {
							await this.setControlValue(`${HOTKEY_KEY_PREFIX}${field.key}`, val);
						})
				);
		}

		new Setting(containerEl)
			.setName("恢复默认快捷键")
			.setDesc("将画布快捷键重置为默认配置")
			.addButton((btn) =>
				btn.setButtonText("恢复默认").onClick(async () => {
					await this.resetHotkeys(false);
				})
			);
	}
}
