export interface NodeImageAttachment {
	kind: "obsidian" | "markdown";
	target: string;
	alt?: string;
	size?: string;
}

export type RichMarkKind =
	| "bold"
	| "italic"
	| "strikethrough"
	| "highlight"
	| "code";

export const RICH_MARK_DELIMITERS: Record<RichMarkKind, string> = {
	bold: "**",
	italic: "*",
	strikethrough: "~~",
	highlight: "==",
	code: "`",
};

export type InlineEditNode =
	| { kind: "text"; text: string }
	| { kind: "mark"; mark: RichMarkKind; children: InlineEditNode[] }
	| { kind: "wikilink"; target: string; label: string; raw: string }
	| { kind: "extlink"; label: string; url: string; raw: string }
	| { kind: "tag"; tag: string; raw: string }
	| {
			kind: "image";
			imageKind: "obsidian" | "markdown";
			target: string;
			alt?: string;
			size?: string;
			raw: string;
	  };

export type ImageSizePreset = "auto" | "120" | "200" | "320";

export const IMAGE_SIZE_PRESETS: readonly ImageSizePreset[] = [
	"auto",
	"120",
	"200",
	"320",
];

export function isSafeExternalUrl(url: string): boolean {
	const trimmed = url.trim();
	if (/^https?:\/\/$/i.test(trimmed)) {
		return false;
	}
	return /^(https?:\/\/\S+|obsidian:\/\/\S+|app:\/\/\S+|capacitor:\/\/\S+|file:\/\/\S+|data:image\/\S+)/i.test(
		trimmed
	);
}

export function normalizeExternalUrlInput(rawUrl: string): string | null {
	const trimmed = rawUrl.trim();
	if (!trimmed) return null;
	if (isSafeExternalUrl(trimmed)) {
		return trimmed;
	}
	// Bare domain or host without scheme -> prefix https://
	if (/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:[/:?#]\S*)?$/.test(trimmed)) {
		return `https://${trimmed}`;
	}
	return null;
}

export function wrapMarkMarkdown(mark: RichMarkKind, inner: string): string {
	if (!inner) return "";
	const delim = RICH_MARK_DELIMITERS[mark];
	if (mark === "code") {
		return `${delim}${inner.replace(/\r?\n/g, " ")}${delim}`;
	}
	if (!inner.includes("\n")) {
		return `${delim}${inner}${delim}`;
	}
	return inner
		.split("\n")
		.map((line) => (line ? `${delim}${line}${delim}` : ""))
		.join("\n");
}

function appendTextNode(nodes: InlineEditNode[], text: string): void {
	if (!text) return;
	const prev = nodes[nodes.length - 1];
	if (prev && prev.kind === "text") {
		prev.text += text;
	} else {
		nodes.push({ kind: "text", text });
	}
}

/**
 * Parses inline Obsidian Markdown (inline code, images, wikilinks, external links,
 * tags, bold, italic, strikethrough, highlight) into a lossless WYSIWYG inline AST.
 */
export function parseNodeTopicToRichNodes(rawTopic: string): InlineEditNode[] {
	return parseRichRange(rawTopic, new Set());
}

function parseRichRange(
	input: string,
	activeMarks: ReadonlySet<RichMarkKind>
): InlineEditNode[] {
	const nodes: InlineEditNode[] = [];
	const len = input.length;
	let i = 0;
	let prevWasUnconsumedAsterisk = false;

	while (i < len) {
		const ch = input[i];

		// 1. Inline code span (`...`), highest precedence, contents stay literal
		if (ch === "`") {
			const endIdx = input.indexOf("`", i + 1);
			if (endIdx > i + 1 && !input.slice(i + 1, endIdx).includes("\n")) {
				const codeText = input.slice(i + 1, endIdx);
				nodes.push({
					kind: "mark",
					mark: "code",
					children: [{ kind: "text", text: codeText }],
				});
				i = endIdx + 1;
				prevWasUnconsumedAsterisk = false;
				continue;
			}
		}

		// 2. Obsidian image embed ![[target]] / ![[target|size]] or Markdown image ![alt](url)
		if (ch === "!") {
			const obsImg = input
				.slice(i)
				.match(/^!\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/);
			if (obsImg) {
				nodes.push({
					kind: "image",
					imageKind: "obsidian",
					target: obsImg[1].trim(),
					size: obsImg[2]?.trim() || undefined,
					raw: obsImg[0],
				});
				i += obsImg[0].length;
				prevWasUnconsumedAsterisk = false;
				continue;
			}

			const mdImg = input.slice(i).match(/^!\[([^\]\n]*)\]\(([^)\n]+)\)/);
			if (mdImg) {
				nodes.push({
					kind: "image",
					imageKind: "markdown",
					target: mdImg[2].trim(),
					alt: mdImg[1],
					raw: mdImg[0],
				});
				i += mdImg[0].length;
				prevWasUnconsumedAsterisk = false;
				continue;
			}
		}

		// 3. Obsidian wikilink [[target]] / [[target|alias]] or Markdown external link [label](url)
		if (ch === "[") {
			const wiki = input
				.slice(i)
				.match(/^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/);
			if (wiki) {
				const target = wiki[1].trim();
				const label = (wiki[2] ?? target).trim();
				nodes.push({
					kind: "wikilink",
					target,
					label,
					raw: wiki[0],
				});
				i += wiki[0].length;
				prevWasUnconsumedAsterisk = false;
				continue;
			}

			const ext = input.slice(i).match(/^\[([^\]\n]+)\]\(([^)\n]+)\)/);
			if (ext && isSafeExternalUrl(ext[2])) {
				nodes.push({
					kind: "extlink",
					label: ext[1],
					url: ext[2].trim(),
					raw: ext[0],
				});
				i += ext[0].length;
				prevWasUnconsumedAsterisk = false;
				continue;
			}
		}

		// 4. Inline Obsidian tag (#tag) when preceded by start, whitespace, or "("
		if (ch === "#") {
			const prevChar = i === 0 ? "" : input[i - 1];
			if (i === 0 || /[\s(]/.test(prevChar)) {
				const tagMatch = input
					.slice(i)
					.match(/^#([A-Za-z0-9_\-/\u4e00-\u9fa5]+)/);
				if (tagMatch) {
					nodes.push({
						kind: "tag",
						tag: tagMatch[1],
						raw: tagMatch[0],
					});
					i += tagMatch[0].length;
					prevWasUnconsumedAsterisk = false;
					continue;
				}
			}
		}

		// 5. Triple-asterisk bold+italic: ***text***
		if (
			input.slice(i, i + 3) === "***" &&
			!activeMarks.has("bold") &&
			!activeMarks.has("italic")
		) {
			const closeIdx = findClosingDelimiter(input, i + 3, "***");
			if (closeIdx > i + 3) {
				const inner = input.slice(i + 3, closeIdx);
				const nextActive = new Set(activeMarks);
				nextActive.add("bold");
				nextActive.add("italic");
				const children = parseRichRange(inner, nextActive);
				if (children.length > 0) {
					nodes.push({
						kind: "mark",
						mark: "bold",
						children: [{ kind: "mark", mark: "italic", children }],
					});
					i = closeIdx + 3;
					prevWasUnconsumedAsterisk = false;
					continue;
				}
			}
		}

		// 6. Paired two-character marks: **bold**, __bold__, ~~strikethrough~~, ==highlight==
		const twoCharMark = matchDoubleDelimiterMark(input, i, activeMarks);
		if (twoCharMark) {
			const nextActive = new Set(activeMarks);
			nextActive.add(twoCharMark.mark);
			const children = parseRichRange(twoCharMark.inner, nextActive);
			if (children.length > 0) {
				nodes.push({
					kind: "mark",
					mark: twoCharMark.mark,
					children,
				});
				i = twoCharMark.nextIndex;
				prevWasUnconsumedAsterisk = false;
				continue;
			}
		}

		// 7. Single-asterisk italic *text* (handles adjacent **bold***italic* cleanly)
		if (
			ch === "*" &&
			input[i + 1] !== "*" &&
			!activeMarks.has("italic") &&
			!prevWasUnconsumedAsterisk
		) {
			const closeIdx = findClosingSingleAsterisk(input, i + 1);
			if (closeIdx > i + 1) {
				const inner = input.slice(i + 1, closeIdx);
				const nextActive = new Set(activeMarks);
				nextActive.add("italic");
				const children = parseRichRange(inner, nextActive);
				if (children.length > 0) {
					nodes.push({
						kind: "mark",
						mark: "italic",
						children,
					});
					i = closeIdx + 1;
					prevWasUnconsumedAsterisk = false;
					continue;
				}
			}
		}

		appendTextNode(nodes, ch);
		prevWasUnconsumedAsterisk = ch === "*";
		i++;
	}

	return nodes;
}

function matchDoubleDelimiterMark(
	input: string,
	start: number,
	activeMarks: ReadonlySet<RichMarkKind>
): { mark: RichMarkKind; inner: string; nextIndex: number } | null {
	const pair = input.slice(start, start + 2);
	let mark: RichMarkKind | null = null;
	if (pair === "**" || pair === "__") {
		mark = "bold";
	} else if (pair === "~~") {
		mark = "strikethrough";
	} else if (pair === "==") {
		mark = "highlight";
	}
	if (!mark || activeMarks.has(mark)) return null;

	const closeIdx = findClosingDelimiter(input, start + 2, pair);
	if (closeIdx <= start + 2) return null;

	return {
		mark,
		inner: input.slice(start + 2, closeIdx),
		nextIndex: closeIdx + 2,
	};
}

function findClosingDelimiter(
	input: string,
	fromIndex: number,
	delim: string
): number {
	let inCode = false;
	const dLen = delim.length;
	for (let i = fromIndex; i <= input.length - dLen; i++) {
		const ch = input[i];
		if (ch === "\n") return -1;
		if (ch === "`") {
			inCode = !inCode;
			continue;
		}
		if (!inCode && input.slice(i, i + dLen) === delim) {
			return i;
		}
	}
	return -1;
}

function findClosingSingleAsterisk(input: string, fromIndex: number): number {
	let inCode = false;
	for (let i = fromIndex; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\n") return -1;
		if (ch === "`") {
			inCode = !inCode;
			continue;
		}
		if (!inCode && ch === "*") {
			// *** means closing "*" immediately followed by opening "**" (e.g. *a***b**)
			if (input[i + 1] === "*" && input[i + 2] === "*") {
				return i;
			}
			// Exact "**" inside italic (e.g. *a **b** c*) -> skip bold delimiter
			if (input[i + 1] === "*") {
				i++;
				continue;
			}
			return i;
		}
	}
	return -1;
}

export function serializeImageAttachment(image: NodeImageAttachment): string {
	if (image.kind === "obsidian") {
		const sizeSuffix = image.size?.trim() ? `|${image.size.trim()}` : "";
		return `![[${image.target}${sizeSuffix}]]`;
	}
	return `![${image.alt ?? ""}](${image.target})`;
}

export function serializeRichNodesToMarkdown(
	nodes: readonly InlineEditNode[]
): string {
	let out = "";
	for (const node of nodes) {
		if (node.kind === "text") {
			out += node.text;
		} else if (node.kind === "mark") {
			const inner = serializeRichNodesToMarkdown(node.children);
			out += wrapMarkMarkdown(node.mark, inner);
		} else {
			out += node.raw;
		}
	}
	return out;
}

export function normalizeCommittedTopic(raw: string): string {
	return raw
		.replace(/\r\n/g, "\n")
		.replace(/\u200B/g, "")
		.replace(/\u00A0/g, " ")
		.trim();
}

export function getImageSizePreset(size?: string): ImageSizePreset {
	const trimmed = size?.trim();
	if (trimmed === "120" || trimmed === "200" || trimmed === "320") {
		return trimmed;
	}
	return "auto";
}

export function applyImageSizePreset(
	image: NodeImageAttachment,
	preset: ImageSizePreset
): NodeImageAttachment {
	if (image.kind !== "obsidian") return image;
	return {
		...image,
		size: preset === "auto" ? undefined : preset,
	};
}

export function formatImageSizeLabel(preset: ImageSizePreset): string {
	switch (preset) {
		case "120":
			return "小";
		case "200":
			return "中";
		case "320":
			return "大";
		case "auto":
		default:
			return "自动";
	}
}
