import {
	allocateUniqueVaultPath,
	cleanVaultFolder,
	sanitizeVaultFileName,
} from "../vault/vaultPaths";

export type ExportFormat = "png" | "svg" | "jpeg" | "webp";
export type ExportDestination = "vault" | "local";

export interface ExportFormatMeta {
	format: ExportFormat;
	label: string;
	extension: string;
	mimeType: string;
	isRaster: boolean;
}

export const EXPORT_FORMATS: readonly ExportFormatMeta[] = [
	{
		format: "png",
		label: "PNG（高清位图，推荐）",
		extension: "png",
		mimeType: "image/png",
		isRaster: true,
	},
	{
		format: "svg",
		label: "SVG（矢量缩放格式）",
		extension: "svg",
		mimeType: "image/svg+xml",
		isRaster: false,
	},
	{
		format: "jpeg",
		label: "JPEG（体积更小）",
		extension: "jpg",
		mimeType: "image/jpeg",
		isRaster: true,
	},
	{
		format: "webp",
		label: "WebP（高压缩高清）",
		extension: "webp",
		mimeType: "image/webp",
		isRaster: true,
	},
];

export function getExportFormatMeta(format: ExportFormat): ExportFormatMeta {
	return (
		EXPORT_FORMATS.find((item) => item.format === format) ?? EXPORT_FORMATS[0]
	);
}

export interface StandaloneSvgSource {
	width: number;
	height: number;
	bgColor: string;
	serializedHostHtml: string;
}

export type RenderedExportPayload =
	| { kind: "svg"; svgText: string; mimeType: string }
	| { kind: "raster"; data: ArrayBuffer; mimeType: string };

export interface LocalSaveOutcome {
	method: "picker" | "download";
	savedName: string;
}

export interface ExportPipelineRequest<TMind> {
	mind: TMind;
	sourceBasename?: string | null;
	sourceFolder?: string | null;
	format: ExportFormat;
	destination: ExportDestination;
	/**
	 * Explicit target folder inside the vault.
	 * Pass "" to explicitly export to the vault root; omit (undefined) to fall back to sourceFolder.
	 */
	vaultFolder?: string;
	fileName?: string;
	scale: number;
}

export interface MindMapExportAdapter<TMind> {
	renderSvgSource(mind: TMind): Promise<StandaloneSvgSource>;
	renderRasterBytes(
		mind: TMind,
		format: Exclude<ExportFormat, "svg">,
		options: { scale: number; quality: number }
	): Promise<ArrayBuffer>;
	normalizeVaultPath(path: string): string;
	vaultPathExists(path: string): boolean;
	ensureVaultFolder(folderPath: string): Promise<void>;
	writeVaultBinary(path: string, data: ArrayBuffer): Promise<void>;
	writeVaultText(path: string, text: string): Promise<void>;
	saveLocalFile(
		payload: RenderedExportPayload,
		suggestedName: string,
		meta: ExportFormatMeta
	): Promise<LocalSaveOutcome>;
	notify(message: string): void;
	logError(context: string, err: unknown): void;
}

function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function assembleStandaloneSvg(params: StandaloneSvgSource): string {
	const safeWidth = Math.max(1, Math.round(params.width));
	const safeHeight = Math.max(1, Math.round(params.height));
	const safeBg = escapeXmlAttr(params.bgColor || "#ffffff");

	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">`,
		`<rect width="100%" height="100%" fill="${safeBg}" />`,
		`<foreignObject x="0" y="0" width="${safeWidth}" height="${safeHeight}">`,
		params.serializedHostHtml,
		`</foreignObject>`,
		`</svg>`,
	].join("\n");
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/**
 * Deep export pipeline module owning format metadata, explicit vault-root vs
 * fallback folder resolution, unique path allocation, standalone SVG assembly,
 * destination dispatch, and error/cancellation reporting.
 */
export class MindMapExportPipeline<TMind> {
	private adapter: MindMapExportAdapter<TMind>;

	constructor(adapter: MindMapExportAdapter<TMind>) {
		this.adapter = adapter;
	}

	public async exportMindMap(
		request: ExportPipelineRequest<TMind>
	): Promise<string | null> {
		const meta = getExportFormatMeta(request.format);
		const baseName = sanitizeVaultFileName(
			request.fileName ?? request.sourceBasename ?? "mind-map",
			"mind-map"
		);

		try {
			this.adapter.notify(`正在生成 ${meta.format.toUpperCase()} 图片...`);
			const payload = await this.renderPayload(
				request.mind,
				meta,
				request.scale
			);

			if (request.destination === "local") {
				const outcome = await this.adapter.saveLocalFile(
					payload,
					`${baseName}.${meta.extension}`,
					meta
				);
				this.adapter.notify(
					outcome.method === "picker"
						? `已导出到本地：${outcome.savedName}`
						: `已触发下载：${outcome.savedName}`
				);
				return outcome.savedName;
			}

			return await this.saveToVault(payload, request, baseName, meta);
		} catch (err) {
			if (isAbortError(err)) {
				return null;
			}
			this.adapter.logError(
				`[PureMindMap] ${meta.format} export failed:`,
				err
			);
			this.adapter.notify(
				`导出 ${meta.format.toUpperCase()} 失败：${err instanceof Error ? err.message : String(err)}`
			);
			return null;
		}
	}

	private async renderPayload(
		mind: TMind,
		meta: ExportFormatMeta,
		scale: number
	): Promise<RenderedExportPayload> {
		if (meta.format === "svg") {
			const source = await this.adapter.renderSvgSource(mind);
			return {
				kind: "svg",
				svgText: assembleStandaloneSvg(source),
				mimeType: "image/svg+xml;charset=utf-8",
			};
		}

		const bytes = await this.adapter.renderRasterBytes(mind, meta.format, {
			scale: scale || 2,
			quality: meta.format === "png" ? 1 : 0.92,
		});
		return {
			kind: "raster",
			data: bytes,
			mimeType: meta.mimeType,
		};
	}

	private async saveToVault(
		payload: RenderedExportPayload,
		request: ExportPipelineRequest<TMind>,
		baseName: string,
		meta: ExportFormatMeta
	): Promise<string> {
		// Honor explicit vaultFolder (including "" for vault root); only fall back when undefined
		const targetFolder =
			request.vaultFolder !== undefined
				? cleanVaultFolder(request.vaultFolder)
				: cleanVaultFolder(request.sourceFolder);

		if (targetFolder) {
			const normalizedFolder = this.adapter.normalizeVaultPath(targetFolder);
			if (!this.adapter.vaultPathExists(normalizedFolder)) {
				await this.adapter.ensureVaultFolder(normalizedFolder);
			}
		}

		const { filePath } = allocateUniqueVaultPath({
			folder: targetFolder,
			baseName,
			extension: meta.extension,
			separator: "-",
			exists: (candidate) =>
				this.adapter.vaultPathExists(
					this.adapter.normalizeVaultPath(candidate)
				),
		});

		const normalizedPath = this.adapter.normalizeVaultPath(filePath);
		if (payload.kind === "raster") {
			await this.adapter.writeVaultBinary(normalizedPath, payload.data);
		} else {
			await this.adapter.writeVaultText(normalizedPath, payload.svgText);
		}

		this.adapter.notify(`已导出到库内：${normalizedPath}`);
		return normalizedPath;
	}
}
