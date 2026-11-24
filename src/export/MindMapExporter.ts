import { App, Notice, normalizePath, requestUrl, type TFile } from "obsidian";
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
			console.error(`[PureMindMap] ${meta.format} export failed:`, err);
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

		return await exportImageBlob(mind, format, {
			scale: scale || 2,
			quality: format === "png" ? 1 : 0.92,
			watermarkEnabled: false,
		});
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
			const link = activeDocument.body.createEl("a", {
				attr: { href: url, download: suggestedName },
			});
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
	 * every computed CSS property in lockstep, preserving flex layout and branch paths.
	 */
	private async buildStandaloneSvg(mind: MindElixir): Promise<string> {
		const sourceEl = mind.nodes;
		const width = Math.max(sourceEl.offsetWidth, sourceEl.scrollWidth, 200);
		const height = Math.max(sourceEl.offsetHeight, sourceEl.scrollHeight, 150);
		const bgColor = resolveExportBackground(mind);

		const clone = sourceEl.cloneNode(true) as HTMLElement;
		this.inlineComputedStylesRecursive(sourceEl, clone);

		// Prevent premature text wrapping on fixed-width nodes inside <foreignObject>
		const nowrapProps: Record<string, string> = { "text-wrap": "nowrap" };
		const topicNodes = Array.from(clone.querySelectorAll<HTMLElement>("me-tpc"));
		for (const tpc of topicNodes) {
			const w = tpc.style.getPropertyValue("width");
			const maxW = tpc.style.getPropertyValue("max-width");
			if (w && w.endsWith("px") && w !== maxW) {
				tpc.setCssProps(nowrapProps);
				Array.from(tpc.children).forEach((child) => {
					if (child.instanceOf(HTMLElement)) {
						child.setCssProps(nowrapProps);
					}
				});
			}
			tpc.style.removeProperty("outline");
		}

		const cloneResetProps: Record<string, string> = {
			position: "relative",
			top: "0",
			left: "0",
			transform: "none",
			overflow: "visible",
		};
		clone.setCssProps(cloneResetProps);

		const host = createDiv({
			attr: { xmlns: "http://www.w3.org/1999/xhtml" },
		});
		const hostProps: Record<string, string> = {
			width: `${width}px`,
			height: `${height}px`,
			position: "relative",
			overflow: "visible",
			background: bgColor,
		};
		host.setCssProps(hostProps);
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
			(source.instanceOf(HTMLElement) || source.instanceOf(SVGElement)) &&
			(target.instanceOf(HTMLElement) || target.instanceOf(SVGElement))
		) {
			const computed = window.getComputedStyle(source);
			const props: Record<string, string> = {};
			for (const prop of EXPORT_COMPUTED_STYLE_PROPS) {
				const value = computed.getPropertyValue(prop);
				if (value) {
					props[prop] = value;
				}
			}
			target.setCssProps(props);
		}

		const sourceChildren = Array.from(source.children);
		const targetChildren = Array.from(target.children);
		for (let i = 0; i < sourceChildren.length; i++) {
			const srcChild = sourceChildren[i];
			const dstChild = targetChildren[i];
			if (!dstChild) continue;
			if (
				srcChild.instanceOf(HTMLElement) &&
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
					const dataUrl = await this.imageSrcToDataUrl(src);
					if (dataUrl) {
						img.setAttribute("src", dataUrl);
					}
				} catch {
					// Keep original src if conversion fails
				}
			})
		);
	}

	private async imageSrcToDataUrl(src: string): Promise<string | null> {
		if (/^https?:\/\//i.test(src)) {
			try {
				const res = await requestUrl({ url: src });
				const contentType = res.headers["content-type"] || "image/png";
				const blob = new Blob([res.arrayBuffer], { type: contentType });
				return await this.blobToDataUrl(blob);
			} catch {
				return null;
			}
		}

		return await new Promise<string | null>((resolve) => {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => {
				try {
					const canvas = activeDocument.createElement("canvas");
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

	private blobToDataUrl(blob: Blob): Promise<string | null> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () =>
				resolve(typeof reader.result === "string" ? reader.result : null);
			reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
			reader.readAsDataURL(blob);
		});
	}
}
