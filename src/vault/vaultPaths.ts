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

export function sanitizeVaultFileName(
	raw: string,
	fallback = "mind-map"
): string {
	const cleaned = raw
		.trim()
		.replace(/[\\/:*?"<>|]+/g, "-")
		.replace(/\.+$/g, "")
		.trim();
	return cleaned || fallback;
}

export function resolveDefaultVaultFolder(
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
	const baseName = sanitizeVaultFileName(options.baseName, "mind-map");
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
