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

/**
 * Curated computed CSS properties to inline on cloned mind-elixir nodes so
 * standalone SVG <foreignObject> matches the live canvas layout pixel-for-pixel.
 */
export const EXPORT_COMPUTED_STYLE_PROPS: readonly string[] = [
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

export interface UniqueVaultPathOptions {
	folder: string;
	baseName: string;
	extension: string;
	separator?: string;
	exists: (path: string) => boolean;
}

export interface UniqueVaultPathResult {
	filePath: string;
	title: string;
}

export function cleanVaultFolder(folder?: string | null): string {
	if (!folder) return "";
	return folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function sanitizeExportBaseName(raw: string, fallback = "mind-map"): string {
	const cleaned = raw
		.trim()
		.replace(/[\\/:*?"<>|]+/g, "-")
		.replace(/\.+$/g, "")
		.trim();
	return cleaned || fallback;
}

export function resolveExportFolder(
	configuredFolder: string,
	sourceFileFolder?: string | null
): string {
	const configured = cleanVaultFolder(configuredFolder);
	if (configured) return configured;
	return cleanVaultFolder(sourceFileFolder);
}

export function allocateUniqueVaultPath(
	options: UniqueVaultPathOptions
): UniqueVaultPathResult {
	const folder = cleanVaultFolder(options.folder);
	const baseName = sanitizeExportBaseName(options.baseName, "mind-map");
	const ext = options.extension.replace(/^\./, "");
	const sep = options.separator ?? "-";

	let counter = 0;
	while (true) {
		const title = counter === 0 ? baseName : `${baseName}${sep}${counter}`;
		const fileName = `${title}.${ext}`;
		const candidate = folder ? `${folder}/${fileName}` : fileName;
		if (!options.exists(candidate)) {
			return { filePath: candidate, title };
		}
		counter++;
	}
}

export function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface StandaloneSvgParams {
	width: number;
	height: number;
	bgColor: string;
	serializedHostHtml: string;
}

export function assembleStandaloneSvg(params: StandaloneSvgParams): string {
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
