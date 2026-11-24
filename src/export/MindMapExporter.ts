import { App, Notice, normalizePath, requestUrl, type TFile } from "obsidian";
import type MindElixir from "mind-elixir";
import {
	exportImageBlob,
	resolveExportBackground,
} from "@mind-elixir/export-mindmap";
import {
	MindMapExportPipeline,
	type ExportDestination,
	type ExportFormat,
	type ExportFormatMeta,
	type LocalSaveOutcome,
	type RenderedExportPayload,
	type StandaloneSvgSource,
} from "./MindMapExportPipeline";

export interface ExportRequest {
	mind: MindElixir;
	sourceFile: TFile | null;
	format: ExportFormat;
	destination: ExportDestination;
	vaultFolder?: string;
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
 * Curated computed CSS properties to inline on cloned mind-elixir nodes so
 * standalone SVG <foreignObject> matches the live canvas layout pixel-for-pixel.
 */
const EXPORT_COMPUTED_STYLE_PROPS: readonly string[] = [
	"box-sizing",
	"display",
	"position",
	"top",
	"right",
	"bottom",
	"left",
	"width",
	"height",
	"min-width",
	"min-height",
	"max-width",
	"max-height",
	"flex",
	"flex-basis",
	"flex-direction",
	"flex-grow",
	"flex-shrink",
	"flex-wrap",
	"gap",
	"row-gap",
	"column-gap",
	"align-content",
	"align-items",
	"align-self",
	"justify-content",
	"justify-items",
	"justify-self",
	"order",
	"float",
	"clear",
	"margin",
	"margin-top",
	"margin-right",
	"margin-bottom",
	"margin-left",
	"padding",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"border",
	"border-top",
	"border-right",
	"border-bottom",
	"border-left",
	"border-width",
	"border-top-width",
	"border-right-width",
	"border-bottom-width",
	"border-left-width",
	"border-style",
	"border-top-style",
	"border-right-style",
	"border-bottom-style",
	"border-left-style",
	"border-color",
	"border-top-color",
	"border-right-color",
	"border-bottom-color",
	"border-left-color",
	"border-radius",
	"border-top-left-radius",
	"border-top-right-radius",
	"border-bottom-left-radius",
	"border-bottom-right-radius",
	"background",
	"background-color",
	"background-image",
	"background-repeat",
	"background-size",
	"background-position",
	"color",
	"font",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"line-height",
	"text-align",
	"text-decoration",
	"text-transform",
	"text-shadow",
	"text-overflow",
	"white-space",
	"word-break",
	"word-wrap",
	"vertical-align",
	"opacity",
	"visibility",
	"transform",
	"transform-origin",
	"box-shadow",
	"outline",
	"z-index",
	"overflow",
	"overflow-x",
	"overflow-y",
	"fill",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-dasharray",
	"direction",
	"unicode-bidi",
	"writing-mode",
];

/**
 * Obsidian/DOM adapter wiring MindMapExportPipeline to Vault file I/O,
 * browser File System Access / download fallback, and live canvas SVG cloning.
 */
export class MindMapExporter {
	private app: App;
	private pipeline: MindMapExportPipeline<MindElixir>;

	constructor(app: App) {
		this.app = app;
		this.pipeline = new MindMapExportPipeline<MindElixir>({
			renderSvgSource: (mind) => this.captureSvgSource(mind),
			renderRasterBytes: async (mind, format, options) => {
				const blob = await exportImageBlob(mind, format, {
					scale: options.scale,
					quality: options.quality,
					watermarkEnabled: false,
				});
				return await blob.arrayBuffer();
			},
			normalizeVaultPath: (path) => normalizePath(path),
			vaultPathExists: (path) =>
				Boolean(this.app.vault.getAbstractFileByPath(path)),
			ensureVaultFolder: async (folderPath) => {
				await this.app.vault.createFolder(folderPath);
			},
			writeVaultBinary: async (path, data) => {
				await this.app.vault.createBinary(path, data);
			},
			writeVaultText: async (path, text) => {
				await this.app.vault.create(path, text);
			},
			saveLocalFile: (payload, suggestedName, meta) =>
				this.saveToLocalDisk(payload, suggestedName, meta),
			notify: (message) => {
				new Notice(message);
			},
			logError: (context, err) => {
				console.error(context, err);
			},
		});
	}

	public async exportMindMap(request: ExportRequest): Promise<string | null> {
		return this.pipeline.exportMindMap({
			mind: request.mind,
			sourceBasename: request.sourceFile?.basename,
			sourceFolder: request.sourceFile?.parent?.path,
			format: request.format,
			destination: request.destination,
			vaultFolder: request.vaultFolder,
			fileName: request.fileName,
			scale: request.scale,
		});
	}

	private async saveToLocalDisk(
		payload: RenderedExportPayload,
		suggestedName: string,
		meta: ExportFormatMeta
	): Promise<LocalSaveOutcome> {
		const blob =
			payload.kind === "svg"
				? new Blob([payload.svgText], { type: payload.mimeType })
				: new Blob([payload.data], { type: payload.mimeType });

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
			return { method: "picker", savedName: handle.name };
		}

		// Fallback when File System Access API is unavailable (e.g. mobile)
		const url = URL.createObjectURL(blob);
		try {
			const link = activeDocument.body.createEl("a", {
				attr: { href: url, download: suggestedName },
			});
			link.click();
			link.remove();
			return { method: "download", savedName: suggestedName };
		} finally {
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		}
	}

	/**
	 * Clones mind.nodes and inlines every computed CSS property in lockstep,
	 * preserving flex layout, branch paths, and embedded images for standalone SVG.
	 */
	private async captureSvgSource(mind: MindElixir): Promise<StandaloneSvgSource> {
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
		return {
			width,
			height,
			bgColor,
			serializedHostHtml,
		};
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
