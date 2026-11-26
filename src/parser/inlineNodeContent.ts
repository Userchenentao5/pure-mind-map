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
 * Single canonical parser for inline Obsidian Markdown inside a Node
 * (inline code, images, wikilinks, external links, tags, bold, italic,
 * strikethrough, highlight). All canvas HTML rendering, Node Inline Editor
 * AST manipulation, search text extraction, and display titles derive from
 * this AST so inline grammar never drifts across modules.
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

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function parseObsidianImageSize(size?: string): string {
	if (!size) return "";
	const trimmed = size.trim();
	const whMatch = trimmed.match(/^(\d+)x(\d+)$/i);
	if (whMatch) {
		return ` style="width:${whMatch[1]}px;height:${whMatch[2]}px"`;
	}
	const wMatch = trimmed.match(/^(\d+)$/);
	if (wMatch) {
		return ` style="width:${wMatch[1]}px;height:auto"`;
	}
	return "";
}

function renderInlineNodesToHtml(
	nodes: readonly InlineEditNode[],
	resolveVaultImage?: (target: string) => string | null
): string {
	let html = "";
	for (const node of nodes) {
		switch (node.kind) {
			case "text":
				html += escapeHtml(node.text).replace(/\r?\n/g, "<br>");
				break;
			case "mark": {
				const inner = renderInlineNodesToHtml(node.children, resolveVaultImage);
				if (node.mark === "bold") {
					html += `<strong>${inner}</strong>`;
				} else if (node.mark === "italic") {
					html += `<em>${inner}</em>`;
				} else if (node.mark === "strikethrough") {
					html += `<del>${inner}</del>`;
				} else if (node.mark === "highlight") {
					html += `<mark class="mm-highlight">${inner}</mark>`;
				} else {
					html += `<code class="mm-inline-code">${inner}</code>`;
				}
				break;
			}
			case "wikilink":
				html += `<a class="internal-link mm-wikilink" data-href="${escapeHtml(node.target)}" href="${escapeHtml(node.target)}">${escapeHtml(node.label)}</a>`;
				break;
			case "extlink":
				html += `<a class="external-link mm-extlink" href="${escapeHtml(node.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(node.label)}</a>`;
				break;
			case "tag":
				html += `<span class="mm-tag">#${escapeHtml(node.tag)}</span>`;
				break;
			case "image":
				if (node.imageKind === "obsidian") {
					const resolved = resolveVaultImage
						? resolveVaultImage(node.target)
						: null;
					if (!resolved) {
						html += `<span class="mm-broken-img" title="${escapeHtml(node.target)}">🖼️ ${escapeHtml(node.target)}</span>`;
					} else {
						const sizeStyle = parseObsidianImageSize(node.size);
						html += `<img class="mm-node-img" src="${escapeHtml(resolved)}" alt="${escapeHtml(node.target)}"${sizeStyle} draggable="false" />`;
					}
				} else {
					const resolved =
						(isSafeExternalUrl(node.target) ? node.target : null) ||
						(resolveVaultImage ? resolveVaultImage(node.target) : null);
					if (!resolved) {
						html += `<span class="mm-broken-img">🖼️ ${escapeHtml(node.alt || node.target)}</span>`;
					} else {
						html += `<img class="mm-node-img" src="${escapeHtml(resolved)}" alt="${escapeHtml(node.alt ?? "")}" draggable="false" />`;
					}
				}
				break;
		}
	}
	return html;
}

/**
 * Renders inline Obsidian Markdown (wikilinks, embedded images, external links,
 * bold/italic/code/strikethrough/highlight/tags) to safe HTML from the canonical AST.
 */
export function renderNodeMarkdown(
	raw: string,
	resolveVaultImage?: (target: string) => string | null
): string {
	return renderInlineNodesToHtml(
		parseNodeTopicToRichNodes(raw),
		resolveVaultImage
	);
}

function projectNodesToPlainText(
	nodes: readonly InlineEditNode[],
	includeLinkTargets: boolean
): string {
	let out = "";
	for (const node of nodes) {
		switch (node.kind) {
			case "text":
				out += node.text;
				break;
			case "mark":
				out += projectNodesToPlainText(node.children, includeLinkTargets);
				break;
			case "wikilink":
				out +=
					includeLinkTargets && node.label !== node.target
						? `${node.label} ${node.target}`
						: node.label;
				break;
			case "extlink":
				out += includeLinkTargets ? `${node.label} ${node.url}` : node.label;
				break;
			case "tag":
				out += `#${node.tag}`;
				break;
			case "image":
				if (node.imageKind === "obsidian") {
					out += node.target;
				} else {
					out += includeLinkTargets
						? `${node.alt ?? ""} ${node.target}`.trim()
						: node.alt || node.target;
				}
				break;
		}
	}
	return out;
}

/**
 * Projects a Node's inline Markdown into human-readable searchable plain text
 * (including both wikilink alias and target) via the canonical inline AST.
 */
export function extractSearchableNodeText(rawTopic: string): string {
	return projectNodesToPlainText(parseNodeTopicToRichNodes(rawTopic), true);
}

/**
 * Projects a Node's inline Markdown into a concise single-line display title
 * (e.g. for Note headers and hover previews) via the canonical inline AST.
 */
export function extractNodeDisplayTitle(
	rawTopic: string,
	fallback = "未命名节点"
): string {
	const plain = projectNodesToPlainText(
		parseNodeTopicToRichNodes(rawTopic || ""),
		false
	)
		.replace(/\s+/g, " ")
		.trim();
	return plain || fallback;
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
