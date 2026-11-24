import { App, PluginSettingTab, Setting } from "obsidian";
import {
	formatHotkeyForDisplay,
	normalizeHotkeyKey,
} from "../canvas/canvasConfig";
import type SimpleMindMapPlugin from "../main";
import {
	DEFAULT_HOTKEYS,
	type MarkdownSerializeStyle,
	type MindMapDirection,
	type MindMapHotkeys,
	type SplitLayout,
	type ThemeMode,
} from "./types";

export class MindMapSettingTab extends PluginSettingTab {
	private plugin: SimpleMindMapPlugin;

	constructor(app: App, plugin: SimpleMindMapPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- 常规设置 ---
		new Setting(containerEl).setName("常规与外观").setHeading();

		new Setting(containerEl)
			.setName("自动以脑图视图打开")
			.setDesc("打开包含 `mindmap-plugin` 属性的 Markdown 文件时，默认直接进入脑图编辑视图")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoOpenMindMap)
					.onChange(async (value) => {
						this.plugin.settings.autoOpenMindMap = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("默认脑图布局")
			.setDesc("新建脑图或文件未指定方向时使用的默认展开方式")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("side", "两侧分布 (Side)")
					.addOption("right", "向右展开 (Right)")
					.addOption("left", "向左展开 (Left)")
					.addOption("down", "向下展开 (Down)")
					.setValue(this.plugin.settings.defaultDirection)
					.onChange(async (value) => {
						this.plugin.settings.defaultDirection = value as MindMapDirection;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("默认拆分视图布局")
			.setDesc("使用「切换拆分视图」命令同时编辑脑图与源码时的默认分屏方向")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("left-right", "左右拆分 (Left-Right)")
					.addOption("top-bottom", "上下拆分 (Top-Bottom)")
					.setValue(this.plugin.settings.defaultSplitLayout)
					.onChange(async (value) => {
						this.plugin.settings.defaultSplitLayout = value as SplitLayout;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Markdown 保存格式")
			.setDesc("在图谱上编辑后写回 .md 文件的结构风格")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("heading-list", "标题 + 列表（# 中心 / ## 分支 / - 子节点）")
					.addOption("list", "纯无序列表（- 缩进层级）")
					.setValue(this.plugin.settings.markdownStyle)
					.onChange(async (value) => {
						this.plugin.settings.markdownStyle =
							value as MarkdownSerializeStyle;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("主题模式")
			.setDesc("控制脑图画布的明暗配色")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", "跟随 Obsidian 主题")
					.addOption("light", "始终浅色")
					.addOption("dark", "始终深色")
					.setValue(this.plugin.settings.themeMode)
					.onChange(async (value) => {
						this.plugin.settings.themeMode = value as ThemeMode;
						await this.plugin.saveSettings();
						this.plugin.refreshOpenMindMaps();
					})
			);

		new Setting(containerEl)
			.setName("紧凑模式")
			.setDesc("缩小节点间距，适合节点数量较多的大型脑图")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.compactMode)
					.onChange(async (value) => {
						this.plugin.settings.compactMode = value;
						await this.plugin.saveSettings();
						this.plugin.refreshOpenMindMaps();
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
						this.plugin.settings.defaultNewFolder = value.trim();
						await this.plugin.saveSettings();
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
						this.plugin.settings.exportFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("PNG 导出清晰度倍率")
			.setDesc("倍率越高导出图片越清晰（推荐 2x）")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("1", "1x (标准)")
					.addOption("2", "2x (高清，推荐)")
					.addOption("3", "3x (超清)")
					.setValue(String(this.plugin.settings.exportScale))
					.onChange(async (value) => {
						this.plugin.settings.exportScale = Number(value) || 2;
						await this.plugin.saveSettings();
					})
			);

		// --- 快捷键设置 ---
		new Setting(containerEl).setName("画布快捷键自定义").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "填写 KeyboardEvent.key 名称（例如 Tab、Enter、F2、Delete、F1、Space）。切换脑图/源码默认快捷键为 Ctrl+.；注意在中文输入法且光标位于源码或节点编辑框内时，Windows 输入法可能先拦截 Ctrl+. 切换标点，建议在 Obsidian「设置 → 快捷键」中将其改绑为 Alt+M 或 Ctrl+Shift+M。",
		});

		const hotkeyFields: Array<{
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

		for (const field of hotkeyFields) {
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
							this.plugin.settings.hotkeys[field.key] = normalizeHotkeyKey(val);
							await this.plugin.saveSettings();
							this.plugin.refreshOpenMindMaps();
						})
				);
		}

		new Setting(containerEl)
			.setName("恢复默认快捷键")
			.setDesc("将画布快捷键重置为默认配置")
			.addButton((btn) =>
				btn.setButtonText("恢复默认").onClick(async () => {
					this.plugin.settings.hotkeys = { ...DEFAULT_HOTKEYS };
					await this.plugin.saveSettings();
					this.plugin.refreshOpenMindMaps();
					this.display();
				})
			);
	}
}
