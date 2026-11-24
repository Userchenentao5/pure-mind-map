import { App, Notice, normalizePath, type TFile } from "obsidian";
import type MindElixir from "mind-elixir";
import {
	exportImageBlob,
	resolveExportBackground,
} from "@mind-elixir/export-mindmap";
import {
	EXPORT_COMPUTED_STYLE_PROPS,
	allocateUniqueVaultPath,
	assembleStandaloneSvg,
	getExportFormatMeta,
	resolveExportFolder,
	sanitizeExportBaseName,
	type ExportDestination,
	type ExportFormat,
} from "./exporterCore";

export interface ExportRequest {
	mind: MindElixir;
	sourceFile: TFile | null;
	format: ExportFormat;
	destination: ExportDestination;
	vaultFolder: string;
	fileName?: string;
	scale: number;
}

interface SaveFilePickerWindow extends Window {
	showSaveFilePicker?: (options?: {
		suggestedName?: string;
		types?: Array<{
			description?: string;
			accept: Record<string, string[]>;
		}>;
	}) => Promise<{
		name: string;
		createWritable: () => Promise<{
			write: (data: Blob | ArrayBuffer | string) => Promise<void>;
			close: () => Promise<void>;
		}>;
	}>;
}

/**
 * Deep module owning Mind Map multi-format export (PNG, SVG, JPEG, WebP)
 * to either an Obsidian Vault folder or a user-selected local disk folder.
 */
export class MindMapExporter {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	public async exportMindMap(request: ExportRequest): Promise<string | null> {
		const meta = getExportFormatMeta(request.format);
		const baseName = sanitizeExportBaseName(
			request.fileName ?? request.sourceFile?.basename ?? "mind-map"
		);

		try {
			new Notice(`正在生成 ${meta.format.toUpperCase()} 图片...`);
			const blob = await this.renderToBlob(request.mind, request.format, request.scale);

			if (request.destination === "local") {
				return await this.saveToLocalDisk(blob, `${baseName}.${meta.extension}`, meta);
			}

			return await this.saveToVault(
				blob,
				request.sourceFile,
				request.vaultFolder,
				baseName,
				meta.extension,
				meta.isRaster
			);
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				return null;
			}
			console.error(`[SimpleMindMap] ${meta.format} export failed:`, err);
			new Notice(
				`导出 ${meta.format.toUpperCase()} 失败：${err instanceof Error ? err.message : String(err)}`
			);
			return null;
		}
	}

	private async renderToBlob(
		mind: MindElixir,
		format: ExportFormat,
		scale: number
	): Promise<Blob> {
		if (format === "svg") {
			const svgContent = await this.buildStandaloneSvg(mind);
			return new Blob([svgContent], { type: "image/svg+xml;charset=utf-8" });
		}

		return await exportImageBlob(
			mind as unknown as Parameters<typeof exportImageBlob>[0],
			format,
			{
				scale: scale || 2,
				quality: format === "png" ? 1 : 0.92,
				watermarkEnabled: false,
			}
		);
	}

	private async saveToVault(
		blob: Blob,
		sourceFile: TFile | null,
		configuredFolder: string,
		baseName: string,
		extension: string,
		isBinary: boolean
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
			baseName,
			extension,
			separator: "-",
			exists: (candidate) =>
				Boolean(this.app.vault.getAbstractFileByPath(normalizePath(candidate))),
		});

		const normalizedPath = normalizePath(filePath);
		if (isBinary) {
			await this.app.vault.createBinary(normalizedPath, await blob.arrayBuffer());
		} else {
			await this.app.vault.create(normalizedPath, await blob.text());
		}

		new Notice(`已导出到库内：${normalizedPath}`);
		return normalizedPath;
	}

	private async saveToLocalDisk(
		blob: Blob,
		suggestedName: string,
		meta: { label: string; extension: string; mimeType: string }
	): Promise<string | null> {
		const win = window as SaveFilePickerWindow;
		if (typeof win.showSaveFilePicker === "function") {
			const handle = await win.showSaveFilePicker({
				suggestedName,
				types: [
					{
						description: meta.label,
						accept: { [meta.mimeType]: [`.${meta.extension}`] },
					},
				],
			});
			const writable = await handle.createWritable();
			await writable.write(blob);
			await writable.close();
			new Notice(`已导出到本地：${handle.name}`);
			return handle.name;
		}

		// Fallback when File System Access API is unavailable (e.g. mobile)
		const url = URL.createObjectURL(blob);
		try {
			const link = document.createElement("a");
			link.href = url;
			link.download = suggestedName;
			document.body.appendChild(link);
			link.click();
			link.remove();
			new Notice(`已触发下载：${suggestedName}`);
			return suggestedName;
		} finally {
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		}
	}

	/**
	 * Builds a pixel-accurate standalone SVG by cloning mind.nodes and inlining
	 * every computed CSS property in lockstep (matching @mind-elixir/export-mindmap),
	 * avoiding broken flex alignment and shifted SVG branch coordinates.
	 */
	private async buildStandaloneSvg(mind: MindElixir): Promise<string> {
		const sourceEl = mind.nodes;
		const width = Math.max(sourceEl.offsetWidth, sourceEl.scrollWidth, 200);
		const height = Math.max(sourceEl.offsetHeight, sourceEl.scrollHeight, 150);
		const bgColor = resolveExportBackground(
			mind as unknown as Parameters<typeof resolveExportBackground>[0]
		);

		const clone = sourceEl.cloneNode(true) as HTMLElement;
		this.inlineComputedStylesRecursive(sourceEl, clone);

		// Prevent premature text wrapping on fixed-width nodes inside <foreignObject>
		const topicNodes = Array.from(clone.querySelectorAll("me-tpc")) as HTMLElement[];
		for (const tpc of topicNodes) {
			const w = tpc.style.getPropertyValue("width");
			const maxW = tpc.style.getPropertyValue("max-width");
			if (w && w.endsWith("px") && w !== maxW) {
				tpc.style.setProperty("text-wrap", "nowrap");
				Array.from(tpc.children).forEach((child) => {
					if (child instanceof HTMLElement) {
						child.style.setProperty("text-wrap", "nowrap");
					}
				});
			}
			// Strip transient selection outlines from exported artwork
			tpc.style.removeProperty("outline");
		}

		clone.style.position = "relative";
		clone.style.top = "0";
		clone.style.left = "0";
		clone.style.transform = "none";
		clone.style.overflow = "visible";

		const host = document.createElement("div");
		host.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
		host.style.cssText = [
			`width:${width}px`,
			`height:${height}px`,
			"position:relative",
			"overflow:visible",
			`background:${bgColor}`,
		].join(";");
		host.appendChild(clone);

		await this.inlineImagesAsDataUrls(host);

		const serializedHostHtml = new XMLSerializer().serializeToString(host);
		return assembleStandaloneSvg({
			width,
			height,
			bgColor,
			serializedHostHtml,
		});
	}

	private inlineComputedStylesRecursive(source: Element, target: Element): void {
		if (
			(source instanceof HTMLElement || source instanceof SVGElement) &&
			(target instanceof HTMLElement || target instanceof SVGElement)
		) {
			const computed = window.getComputedStyle(source);
			for (const prop of EXPORT_COMPUTED_STYLE_PROPS) {
				const value = computed.getPropertyValue(prop);
				if (value) {
					target.style.setProperty(prop, value, computed.getPropertyPriority(prop));
				}
			}
		}

		const sourceChildren = Array.from(source.children);
		const targetChildren = Array.from(target.children);
		for (let i = 0; i < sourceChildren.length; i++) {
			const srcChild = sourceChildren[i];
			const dstChild = targetChildren[i];
			if (!dstChild) continue;
			// Omit transient editor box or drag previews if present
			if (
				srcChild instanceof HTMLElement &&
				(srcChild.id === "input-box" ||
					srcChild.classList.contains("insert-preview") ||
					srcChild.classList.contains("mind-elixir-ghost"))
			) {
				dstChild.remove();
				continue;
			}
			this.inlineComputedStylesRecursive(srcChild, dstChild);
		}
	}

	private async inlineImagesAsDataUrls(root: HTMLElement): Promise<void> {
		const imgs = Array.from(root.querySelectorAll("img"));
		await Promise.all(
			imgs.map(async (img) => {
				const src = img.getAttribute("src");
				if (!src || src.startsWith("data:")) return;
				try {
					const dataUrl = await this.fetchToDataUrl(src);
					if (dataUrl) {
						img.setAttribute("src", dataUrl);
					}
				} catch {
					// Keep original src if conversion fails
				}
			})
		);
	}

	private async fetchToDataUrl(src: string): Promise<string | null> {
		try {
			const res = await fetch(src);
			const blob = await res.blob();
			return await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			});
		} catch {
			return null;
		}
	}
}
