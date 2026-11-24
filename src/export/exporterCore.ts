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
	const baseName = options.baseName.trim() || "mind-map";
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

export function escapeCdata(content: string): string {
	return content.replace(/\]\]>/g, "]]]]><![CDATA[>");
}

export function shouldIncludeExportCssRule(cssText: string): boolean {
	return (
		cssText.includes("me-") ||
		cssText.includes("map-container") ||
		cssText.includes("mm-")
	);
}

export interface StandaloneSvgParams {
	width: number;
	height: number;
	bgColor: string;
	cssVars: Record<string, string | undefined>;
	collectedCss: string;
	serializedHtml: string;
}

export function assembleStandaloneSvg(params: StandaloneSvgParams): string {
	const safeBg = escapeXmlAttr(params.bgColor || "#ffffff");
	const cssVarEntries = Object.entries(params.cssVars)
		.filter(([, value]) => Boolean(value))
		.map(([key, value]) => `${key}: ${value};`)
		.join(" ");
	const containerStyle = escapeXmlAttr(
		`${cssVarEntries} width:${params.width}px; height:${params.height}px; background:${params.bgColor || "#ffffff"}; overflow:visible;`.trim()
	);
	const safeCss = escapeCdata(params.collectedCss);

	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<svg xmlns="http://www.w3.org/2000/svg" width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}">`,
		`<rect width="100%" height="100%" fill="${safeBg}" />`,
		`<foreignObject width="100%" height="100%">`,
		`<div xmlns="http://www.w3.org/1999/xhtml" class="map-container" style="${containerStyle}">`,
		`<style><![CDATA[${safeCss}]]></style>`,
		params.serializedHtml,
		`</div>`,
		`</foreignObject>`,
		`</svg>`,
	].join("\n");
}
