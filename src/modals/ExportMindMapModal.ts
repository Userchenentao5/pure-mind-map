import { App, Modal, Setting, TFolder, type TFile } from "obsidian";
import {
	EXPORT_FORMATS,
	getExportFormatMeta,
	resolveExportFolder,
	type ExportDestination,
	type ExportFormat,
} from "../export/exporterCore";

export interface ExportModalOptions {
	sourceFile: TFile | null;
	defaultFolder: string;
	defaultScale: number;
	initialFormat?: ExportFormat;
	onConfirm: (result: ExportModalResult) => Promise<void> | void;
}

export interface ExportModalResult {
	format: ExportFormat;
	destination: ExportDestination;
	vaultFolder: string;
	fileName: string;
	scale: number;
}

export class ExportMindMapModal extends Modal {
	private options: ExportModalOptions;
	private format: ExportFormat;
	private destination: ExportDestination = "vault";
	private vaultFolder: string;
	private fileName: string;
	private scale: number;

	constructor(app: App, options: ExportModalOptions) {
		super(app);
		this.options = options;
		this.format = options.initialFormat ?? "png";
		this.vaultFolder = resolveExportFolder(
			options.defaultFolder,
			options.sourceFile?.parent?.path
		);
		this.fileName = options.sourceFile?.basename || "mind-map";
		this.scale = options.defaultScale || 2;
	}

	onOpen(): void {
		this.renderForm();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderForm(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mm-export-modal");

		contentEl.createEl("h3", { text: "导出脑图" });

		// 1. Export format
		new Setting(contentEl)
			.setName("导出格式")
			.setDesc("选择要导出的图片格式")
			.addDropdown((dropdown) => {
				for (const item of EXPORT_FORMATS) {
					dropdown.addOption(item.format, item.label);
				}
				dropdown.setValue(this.format).onChange((value) => {
					this.format = value as ExportFormat;
					this.renderForm();
				});
			});

		// 2. Destination mode (Vault folder vs Local disk save dialog)
		new Setting(contentEl)
			.setName("保存位置")
			.setDesc(
				this.destination === "local"
					? "点击导出后将弹出系统目录选择对话框，可保存到电脑任意文件夹"
					: "保存到 Obsidian 库内指定目录（不存在时自动创建）"
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("vault", "Obsidian 库内目录")
					.addOption("local", "本地磁盘任意目录（另存为对话框）")
					.setValue(this.destination)
					.onChange((value) => {
						this.destination = value as ExportDestination;
						this.renderForm();
					});
			});

		// 3. Vault folder picker + custom path input (only when destination === "vault")
		if (this.destination === "vault") {
			const vaultFolders = this.getVaultFolderPaths();
			const sourceFolder = this.options.sourceFile?.parent?.isRoot()
				? ""
				: (this.options.sourceFile?.parent?.path ?? "");

			new Setting(contentEl)
				.setName("选择库内目录")
				.setDesc("可从已有目录快速选择，或在下方输入框自定义新路径")
				.addDropdown((dropdown) => {
					dropdown.addOption(
						sourceFolder,
						sourceFolder
							? `当前脑图同级目录 (${sourceFolder})`
							: "当前脑图同级目录 (库根目录)"
					);
					if (sourceFolder !== "") {
						dropdown.addOption("", "库根目录 (/)");
					}
					for (const folderPath of vaultFolders) {
						if (folderPath !== sourceFolder && folderPath !== "") {
							dropdown.addOption(folderPath, folderPath);
						}
					}
					const matchedOption =
						this.vaultFolder === sourceFolder ||
						this.vaultFolder === "" ||
						vaultFolders.includes(this.vaultFolder)
							? this.vaultFolder
							: sourceFolder;
					dropdown.setValue(matchedOption).onChange((value) => {
						this.vaultFolder = value;
						this.renderForm();
					});
				});

			new Setting(contentEl)
				.setName("自定义目录路径")
				.setDesc("留空则保存到库根目录，支持输入多级路径如 Attachments/MindMaps")
				.addText((text) => {
					text
						.setPlaceholder("例如：Attachments/MindMaps")
						.setValue(this.vaultFolder)
						.onChange((value) => {
							this.vaultFolder = value.trim();
						});
				});
		}

		// 4. File name
		const formatMeta = getExportFormatMeta(this.format);
		new Setting(contentEl)
			.setName("文件名")
			.setDesc(`最终将保存为 ${this.fileName || "mind-map"}.${formatMeta.extension}`)
			.addText((text) => {
				text
					.setPlaceholder("输入导出文件名")
					.setValue(this.fileName)
					.onChange((value) => {
						this.fileName = value;
					});
			});

		// 5. Resolution scale (raster formats only)
		if (formatMeta.isRaster) {
			new Setting(contentEl)
				.setName("导出清晰度倍率")
				.setDesc("倍率越高越清晰，推荐 2x")
				.addDropdown((dropdown) => {
					dropdown
						.addOption("1", "1x (标准)")
						.addOption("2", "2x (高清，推荐)")
						.addOption("3", "3x (超清)")
						.setValue(String(this.scale))
						.onChange((value) => {
							this.scale = Number(value) || 2;
						});
				});
		}

		// Action buttons
		const footer = contentEl.createDiv({ cls: "mm-export-modal-actions" });
		const cancelBtn = footer.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = footer.createEl("button", {
			text: this.destination === "local" ? "选择目录并保存" : "导出到库内",
			cls: "mod-cta",
		});
		confirmBtn.addEventListener("click", () => {
			void this.submit();
		});
	}

	private async submit(): Promise<void> {
		this.close();
		await this.options.onConfirm({
			format: this.format,
			destination: this.destination,
			vaultFolder: this.vaultFolder,
			fileName: this.fileName,
			scale: this.scale,
		});
	}

	private getVaultFolderPaths(): string[] {
		const folders: string[] = [];
		for (const af of this.app.vault.getAllLoadedFiles()) {
			if (af instanceof TFolder && !af.isRoot()) {
				folders.push(af.path);
			}
		}
		folders.sort((a, b) => a.localeCompare(b));
		return folders;
	}
}
