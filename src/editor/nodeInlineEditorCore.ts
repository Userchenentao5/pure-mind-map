export const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"avif",
]);

export function isImageExtension(extension: string): boolean {
	return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

export function isEmbeddableExtension(extension: string): boolean {
	const lower = extension.toLowerCase();
	return lower === "md" || IMAGE_EXTENSIONS.has(lower);
}

export interface LinkCandidate {
	path: string;
	basename: string;
	name: string;
	extension: string;
	folderPath: string;
	mtime: number;
}

export interface LinkTriggerMatch {
	isEmbed: boolean;
	start: number;
	end: number;
	query: string;
}

export interface TextEditResult {
	text: string;
	caretStart: number;
	caretEnd: number;
}

export type FuzzyScorer = (query: string) => (text: string) => { score: number } | null;

export function findLinkTrigger(text: string, caret: number): LinkTriggerMatch | null {
	const safeCaret = Math.max(0, Math.min(caret, text.length));
	const before = text.slice(0, safeCaret);
	const regexMatch = before.match(/(!?)\[\[([^[\]\n|]*)$/);
	if (!regexMatch || regexMatch.index === undefined) {
		return null;
	}

	const isEmbed = regexMatch[1] === "!";
	const query = regexMatch[2] ?? "";
	const start = regexMatch.index;
	const after = text.slice(safeCaret);
	const closingLen = after.startsWith("]]") ? 2 : 0;

	return {
		isEmbed,
		start,
		end: safeCaret + closingLen,
		query,
	};
}

export function rankLinkCandidates<T extends LinkCandidate>(
	files: readonly T[],
	query: string,
	isEmbed: boolean,
	createScorer: FuzzyScorer,
	limit = 15
): T[] {
	const pool = isEmbed
		? files.filter((file) => isEmbeddableExtension(file.extension))
		: files.filter((file) => file.extension.toLowerCase() === "md");

	const trimmed = query.trim();
	if (!trimmed) {
		return [...pool].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
	}

	const scoreText = createScorer(trimmed);
	const scored: Array<{ file: T; score: number }> = [];

	for (const file of pool) {
		const nameRes = scoreText(file.basename);
		const pathRes = scoreText(file.path);
		const best =
			nameRes && pathRes
				? Math.max(nameRes.score + 5, pathRes.score)
				: nameRes
					? nameRes.score + 5
					: pathRes
						? pathRes.score
						: null;
		if (best !== null) {
			scored.push({ file, score: best });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((entry) => entry.file);
}

export function formatWikiLink(generatedLink: string, basename: string): string {
	const trimmed = generatedLink.trim();
	if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
		return trimmed;
	}
	return `[[${basename}]]`;
}

export function formatEmbedLink(
	fileName: string,
	basename: string,
	extension: string
): string {
	if (extension.toLowerCase() === "md") {
		return `![[${basename}]]`;
	}
	return `![[${fileName}]]`;
}

export function replaceTextRange(
	text: string,
	start: number,
	end: number,
	replacement: string,
	caretStartOffset = replacement.length,
	caretEndOffset = replacement.length
): TextEditResult {
	const safeStart = Math.max(0, Math.min(start, text.length));
	const safeEnd = Math.max(safeStart, Math.min(end, text.length));
	const nextText = text.slice(0, safeStart) + replacement + text.slice(safeEnd);
	return {
		text: nextText,
		caretStart: safeStart + caretStartOffset,
		caretEnd: safeStart + caretEndOffset,
	};
}

export function wrapTextSelection(
	text: string,
	start: number,
	end: number,
	prefix: string,
	suffix: string,
	placeholder: string
): TextEditResult {
	const safeStart = Math.max(0, Math.min(start, text.length));
	const safeEnd = Math.max(safeStart, Math.min(end, text.length));
	const selected = text.slice(safeStart, safeEnd);
	const inner = selected || placeholder;
	const wrapped = `${prefix}${inner}${suffix}`;
	return replaceTextRange(
		text,
		safeStart,
		safeEnd,
		wrapped,
		prefix.length,
		prefix.length + inner.length
	);
}

export function wrapExternalLink(
	text: string,
	start: number,
	end: number,
	defaultLabel = "链接"
): TextEditResult {
	const safeStart = Math.max(0, Math.min(start, text.length));
	const safeEnd = Math.max(safeStart, Math.min(end, text.length));
	const selected = text.slice(safeStart, safeEnd);
	const label = selected || defaultLabel;
	const mdLink = `[${label}](https://)`;
	return replaceTextRange(
		text,
		safeStart,
		safeEnd,
		mdLink,
		label.length + 3,
		mdLink.length - 1
	);
}

export function getSuggesterFooterText(isEmbed: boolean): string {
	return isEmbed
		? "↑↓ 选择附件/笔记  ·  Enter 插入嵌入  ·  Esc 关闭"
		: "↑↓ 选择笔记  ·  Enter 插入双链  ·  Esc 关闭";
}

export function cycleSelectionIndex(
	current: number,
	length: number,
	delta: number
): number {
	if (length <= 0) return 0;
	return ((current + delta) % length + length) % length;
}
