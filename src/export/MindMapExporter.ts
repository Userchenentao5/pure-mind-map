import { App, Notice, normalizePath, type TFile } from "obsidian";
import type MindElixir from "mind-elixir";
import { exportImageBlob } from "@mind-elixir/export-mindmap";
import {
	allocateUniqueVaultPath,
	assembleStandaloneSvg,
	resolveExportFolder,
	shouldIncludeExportCssRule,
} from "./exporterCore";

export interface ExportRequest {
	mind: MindElixir;
	sourceFile: TFile | null;
	configuredFolder: string;
	scale: number;
}

/**
 * Deep module owning Mind Map PNG & standalone SVG export:
 * - PNG rasterization via @mind-elixir/export-mindmap
 * - Standalone SVG cloning, image data-URL inlining, stylesheet collection, and safe XML/CDATA assembly
 * - Export folder creation and collision-free vault path allocation
 */
export class MindMapExporter {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	public async exportPng(request: ExportRequest): Promise<string | null> {
		try {
			new Notice("正在生成 PNG 图片...");
			const blob = await exportImageBlob(
				request.mind as unknown as Parameters<typeof exportImageBlob>[0],
				"png",
				{
					scale: request.scale || 2,
					watermarkEnabled: false,
				}
			);
			const arrayBuffer = await blob.arrayBuffer();
			const outPath = await this.allocateTargetPath(
				request.sourceFile,
				request.configuredFolder,
				"png"
			);
			await this.app.vault.createBinary(outPath, arrayBuffer);
			new Notice(`已导出 PNG 到库内：${outPath}`);
			return outPath;
		} catch (err) {
			console.error("[SimpleMindMap] PNG export failed:", err);
			new Notice(
				`导出 PNG 失败：${err instanceof Error ? err.message : String(err)}`
			);
			return null;
		}
	}

	public async exportSvg(request: ExportRequest): Promise<string | null> {
		try {
			new Notice("正在生成 SVG 图片...");
			const svgContent = await this.buildStandaloneSvg(request.mind);
			const outPath = await this.allocateTargetPath(
				request.sourceFile,
				request.configuredFolder,
				"svg"
			);
			await this.app.vault.create(outPath, svgContent);
			new Notice(`已导出 SVG 到库内：${outPath}`);
			return outPath;
		} catch (err) {
			console.error("[SimpleMindMap] SVG export failed:", err);
			new Notice(
				`导出 SVG 失败：${err instanceof Error ? err.message : String(err)}`
			);
			return null;
		}
	}

	private async allocateTargetPath(
		sourceFile: TFile | null,
		configuredFolder: string,
		extension: "png" | "svg"
	): Promise<string> {
		const targetFolder = resolveExportFolder(
			configuredFolder,
			sourceFile?.parent?.path
		);
		if (targetFolder) {
			const normalizedFolder = normalizePath(targetFolder);
			if (!this.app.vault.getAbstractFileByPath(normalizedFolder)) {
				await this.app.vault.createFolder(normalizedFolder);
			}
		}

		const { filePath } = allocateUniqueVaultPath({
			folder: targetFolder,
			baseName: sourceFile?.basename || "mind-map",
			extension,
			separator: "-",
			exists: (candidate) =>
				Boolean(this.app.vault.getAbstractFileByPath(normalizePath(candidate))),
		});

		return normalizePath(filePath);
	}

	private async buildStandaloneSvg(mind: MindElixir): Promise<string> {
		const nodesEl = mind.nodes;
		const width = Math.max(nodesEl.scrollWidth, nodesEl.offsetWidth, 400) + 80;
		const height = Math.max(nodesEl.scrollHeight, nodesEl.offsetHeight, 300) + 80;

		const clone = nodesEl.cloneNode(true) as HTMLElement;
		clone.style.position = "relative";
		clone.style.transform = "none";
		clone.style.padding = "40px";

		const imgs = Array.from(clone.querySelectorAll("img"));
		await Promise.all(
			imgs.map(async (img) => {
				try {
					const dataUrl = await this.imageSrcToDataUrl(img.src);
					if (dataUrl) img.src = dataUrl;
				} catch {
					// Keep original src if conversion fails
				}
			})
		);

		return assembleStandaloneSvg({
			width,
			height,
			bgColor: mind.theme.cssVar["--bgcolor"] || "#ffffff",
			cssVars: mind.theme.cssVar,
			collectedCss: this.collectMindElixirStyles(),
			serializedHtml: new XMLSerializer().serializeToString(clone),
		});
	}

	private collectMindElixirStyles(): string {
		const rules: string[] = [];
		for (const sheet of Array.from(document.styleSheets)) {
			try {
				for (const rule of Array.from(sheet.cssRules)) {
					if (shouldIncludeExportCssRule(rule.cssText)) {
						rules.push(rule.cssText);
					}
				}
			} catch {
				// Ignore cross-origin sheets
			}
		}
		return rules.join("\n");
	}

	private imageSrcToDataUrl(src: string): Promise<string | null> {
		if (!src || src.startsWith("data:")) return Promise.resolve(src);
		return new Promise((resolve) => {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => {
				try {
					const canvas = document.createElement("canvas");
					canvas.width = img.naturalWidth || img.width;
					canvas.height = img.naturalHeight || img.height;
					const ctx = canvas.getContext("2d");
					if (!ctx) return resolve(null);
					ctx.drawImage(img, 0, 0);
					resolve(canvas.toDataURL("image/png"));
				} catch {
					resolve(null);
				}
			};
			img.onerror = () => resolve(null);
			img.src = src;
		});
	}
}
