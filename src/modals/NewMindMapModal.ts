import { App, Modal, Setting } from "obsidian";
import { STYLE_PRESET_LABELS } from "../canvas/canvasConfig";
import type { MindMapDirection, MindMapStylePreset } from "../settings/types";

export interface NewMindMapModalResult {
	title: string;
	folder: string;
	direction: MindMapDirection;
	stylePreset: MindMapStylePreset;
}

export interface NewMindMapModalOptions {
	defaultTitle: string;
	defaultFolder: string;
	defaultDirection: MindMapDirection;
	defaultStylePreset: MindMapStylePreset;
	onConfirm: (result: NewMindMapModalResult) => Promise<void> | void;
}

const DIRECTION_OPTIONS: Record<MindMapDirection, string> = {
	side: "两侧分布 (Side)",
	right: "向右展开 (Right)",
	left: "向左展开 (Left)",
	down: "向下展开 (Down)",
};

export class NewMindMapModal extends Modal {
	private options: NewMindMapModalOptions;
	private titleText: string;
	private folderPath: string;
	private direction: MindMapDirection;
	private stylePreset: MindMapStylePreset;

	constructor(app: App, options: NewMindMapModalOptions) {
		super(app);
		this.options = options;
		this.titleText = options.defaultTitle;
		this.folderPath = options.defaultFolder;
		this.direction = options.defaultDirection;
		this.stylePreset = options.defaultStylePreset;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl).setName("新建脑图").setHeading();

		new Setting(contentEl)
			.setName("脑图标题")
			.setDesc("将作为文件名与中心主题")
			.addText((text) => {
				text
					.setPlaceholder("例如：产品规划")
					.setValue(this.titleText)
					.onChange((val) => {
						this.titleText = val;
					});
				text.inputEl.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter") {
						evt.preventDefault();
						this.submit();
					}
				});
			});

		new Setting(contentEl)
			.setName("脑图样式")
			.setDesc("选择节点外观与连接线风格（后续也可在画布工具栏随时切换）")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(STYLE_PRESET_LABELS)
					.setValue(this.stylePreset)
					.onChange((val) => {
						this.stylePreset = val as MindMapStylePreset;
					})
			);

		new Setting(contentEl)
			.setName("展开布局")
			.setDesc("设置脑图节点的展开方向")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(DIRECTION_OPTIONS)
					.setValue(this.direction)
					.onChange((val) => {
						this.direction = val as MindMapDirection;
					})
			);

		new Setting(contentEl)
			.setName("保存目录")
			.setDesc("留空则保存在当前文件目录或库根目录")
			.addText((text) =>
				text
					.setPlaceholder("例如：MindMaps")
					.setValue(this.folderPath)
					.onChange((val) => {
						this.folderPath = val;
					})
			);

		const footer = contentEl.createDiv({ cls: "mm-export-modal-actions" });
		const cancelBtn = footer.createEl("button", {
			text: "取消",
			attr: { type: "button" },
		});
		cancelBtn.addEventListener("click", () => this.close());

		const createBtn = footer.createEl("button", {
			text: "创建脑图",
			cls: "mod-cta",
			attr: { type: "button" },
		});
		createBtn.addEventListener("click", () => this.submit());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		const cleanTitle = this.titleText.trim() || this.options.defaultTitle;
		const cleanFolder = this.folderPath.trim();
		this.close();
		void this.options.onConfirm({
			title: cleanTitle,
			folder: cleanFolder,
			direction: this.direction,
			stylePreset: this.stylePreset,
		});
	}
}
