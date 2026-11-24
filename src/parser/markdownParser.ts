import type { MindElixirData, NodeObj } from "mind-elixir";
import {
	MINDMAP_DIRECTION_KEY,
	MINDMAP_FRONTMATTER_KEY,
	type MarkdownSerializeStyle,
	type MindMapDirection,
	codeToDirection,
	directionToCode,
} from "../settings/types";

export interface FrontmatterResult {
	raw: string | null;
	properties: Record<string, string>;
	body: string;
}

export interface ParsedMindMap {
	frontmatter: FrontmatterResult;
	data: MindElixirData;
	direction: MindMapDirection;
}

export interface SerializeOptions {
	existingFrontmatterRaw?: string | null;
	style: MarkdownSerializeStyle;
	direction?: MindMapDirection;
}

interface ExtraMetadata {
	arrows?: MindElixirData["arrows"];
	summaries?: MindElixirData["summaries"];
	nodeIds?: Record<string, string>;
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const EXTRA_META_REGEX = /\n*<!--\s*mindmap-extra:\s*(\{[\s\S]*?\})\s*-->\s*$/;

export function extractFrontmatter(markdown: string): FrontmatterResult {
	const normalized = markdown.replace(/^\uFEFF/, "");
	const match = normalized.match(FRONTMATTER_REGEX);
	if (!match) {
		return {
			raw: null,
			properties: {},
			body: normalized,
		};
	}

	const raw = match[1];
	const body = normalized.slice(match[0].length);
	const properties: Record<string, string> = {};

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;
		const key = trimmed.slice(0, colonIdx).trim();
		const value = trimmed
			.slice(colonIdx + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key) {
			properties[key] = value;
		}
	}

	return { raw, properties, body };
}

export function hasMindMapFrontmatter(markdown: string): boolean {
	const { properties } = extractFrontmatter(markdown);
	const value = properties[MINDMAP_FRONTMATTER_KEY];
	return value !== undefined && value !== "" && value.toLowerCase() !== "false";
}

export function ensureMindMapFrontmatter(
	markdown: string,
	direction: MindMapDirection = "side"
): string {
	const { raw, properties, body } = extractFrontmatter(markdown);
	const updatedRaw = upsertFrontmatterLines(raw, {
		[MINDMAP_FRONTMATTER_KEY]: properties[MINDMAP_FRONTMATTER_KEY] || "basic",
		[MINDMAP_DIRECTION_KEY]: properties[MINDMAP_DIRECTION_KEY] || direction,
	});
	const cleanBody = body.replace(/^\r?\n+/, "");
	return `---\n${updatedRaw}\n---\n\n${cleanBody}`;
}

export function createDefaultMindMapMarkdown(
	title: string,
	direction: MindMapDirection = "side",
	style: MarkdownSerializeStyle = "heading-list"
): string {
	const safeTitle = title.trim() || "中心主题";
	const frontmatter = `---\n${MINDMAP_FRONTMATTER_KEY}: basic\n${MINDMAP_DIRECTION_KEY}: ${direction}\n---\n\n`;

	if (style === "list") {
		return (
			frontmatter +
			`- ${safeTitle}\n` +
			`  - 分支一\n` +
			`    - 子节点 1\n` +
			`  - 分支二\n` +
			`    - 子节点 2\n`
		);
	}

	return (
		frontmatter +
		`# ${safeTitle}\n\n` +
		`## 分支一\n` +
		`- 子节点 1\n\n` +
		`## 分支二\n` +
		`- 子节点 2\n`
	);
}

function makeDeterministicId(pathKey: string, usedIds: Set<string>): string {
	let hash = 2166136261;
	for (let i = 0; i < pathKey.length; i++) {
		hash ^= pathKey.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	const base = `mm-${(hash >>> 0).toString(36)}`;
	let candidate = base;
	let suffix = 1;
	while (usedIds.has(candidate)) {
		candidate = `${base}-${suffix++}`;
	}
	usedIds.add(candidate);
	return candidate;
}

function getIndentWidth(indentStr: string): number {
	let width = 0;
	for (const ch of indentStr) {
		width += ch === "\t" ? 2 : 1;
	}
	return width;
}

function parseDirectionValue(val?: string): MindMapDirection {
	if (val === "left" || val === "right" || val === "side" || val === "down") {
		return val;
	}
	return "side";
}

function unescapeTopic(text: string): string {
	return text.replace(/<br\s*\/?>/gi, "\n").trim();
}

function escapeTopicForMarkdown(topic: string): string {
	return topic.replace(/\r?\n/g, "<br>").trim() || "未命名节点";
}

export function markdownToMindMap(
	markdown: string,
	fallbackTitle = "中心主题"
): ParsedMindMap {
	const frontmatter = extractFrontmatter(markdown);
	const direction = parseDirectionValue(frontmatter.properties[MINDMAP_DIRECTION_KEY]);

	let body = frontmatter.body;
	let extra: ExtraMetadata | null = null;
	const extraMatch = body.match(EXTRA_META_REGEX);
	if (extraMatch) {
		try {
			extra = JSON.parse(extraMatch[1]) as ExtraMetadata;
			body = body.slice(0, extraMatch.index).trimEnd();
		} catch {
			extra = null;
		}
	}

	const lines = body.split(/\r?\n/);
	const usedIds = new Set<string>();

	const hasHeading = lines.some((l) => /^\s*#{1,6}\s+/.test(l));
	let root: NodeObj;

	if (hasHeading) {
		root = parseHeadingAndListBody(lines, fallbackTitle, usedIds);
	} else {
		root = parsePureListBody(lines, fallbackTitle, usedIds);
	}

	if (extra?.nodeIds) {
		applySavedNodeIds(root, "0", extra.nodeIds);
	}

	const data: MindElixirData = {
		nodeData: root,
		direction: directionToCode(direction),
		arrows: extra?.arrows ?? [],
		summaries: extra?.summaries ?? [],
	};

	return {
		frontmatter,
		data,
		direction,
	};
}

function parseHeadingAndListBody(
	lines: string[],
	fallbackTitle: string,
	usedIds: Set<string>
): NodeObj {
	let root: NodeObj | null = null;
	let isSyntheticRoot = false;
	const headingStack: Array<{ level: number; node: NodeObj }> = [];
	const listStack: Array<{ indent: number; node: NodeObj }> = [];
	let currentHeadingParent: NodeObj | null = null;
	let lineIndex = 0;

	const ensureRoot = (): NodeObj => {
		if (!root) {
			root = {
				id: makeDeterministicId("root", usedIds),
				topic: fallbackTitle,
				children: [],
			};
			isSyntheticRoot = true;
			headingStack.push({ level: 1, node: root });
			currentHeadingParent = root;
		}
		return root;
	};

	for (const rawLine of lines) {
		lineIndex++;
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		// Skip empty Obsidian comment markers (e.g. %%%% or %% %%) and HTML comments
		if (/^%%\s*%%$/.test(trimmed) || /^<!--[\s\S]*-->$/.test(trimmed)) {
			continue;
		}

		const headingMatch = rawLine.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/);
		if (headingMatch) {
			const level = headingMatch[1].length;
			const topic = unescapeTopic(headingMatch[2]);
			listStack.length = 0;

			if (level === 1 && (!root || isSyntheticRoot)) {
				if (root && isSyntheticRoot) {
					// Promote this real H1 to root instead of nesting it under a synthetic fallback root
					root.topic = topic;
					isSyntheticRoot = false;
				} else {
					root = {
						id: makeDeterministicId(`h1:${topic}`, usedIds),
						topic,
						children: [],
					};
					isSyntheticRoot = false;
				}
				headingStack.length = 0;
				headingStack.push({ level: 1, node: root });
				currentHeadingParent = root;
				continue;
			}

			const ensuredRoot = ensureRoot();
			const node: NodeObj = {
				id: makeDeterministicId(`h${level}:${lineIndex}:${topic}`, usedIds),
				topic,
				children: [],
			};

			while (
				headingStack.length > 0 &&
				headingStack[headingStack.length - 1].level >= level
			) {
				headingStack.pop();
			}

			const parent =
				headingStack.length > 0
					? headingStack[headingStack.length - 1].node
					: ensuredRoot;
			parent.children = parent.children ?? [];
			parent.children.push(node);

			headingStack.push({ level, node });
			currentHeadingParent = node;
			continue;
		}

		const listMatch = rawLine.match(/^(\s*)[-*+]\s+(.*)$/);
		if (listMatch) {
			const indent = getIndentWidth(listMatch[1]);
			const topic = unescapeTopic(listMatch[2]);
			const baseParent = currentHeadingParent ?? ensureRoot();

			const node: NodeObj = {
				id: makeDeterministicId(`li:${lineIndex}:${topic}`, usedIds),
				topic,
				children: [],
			};

			while (
				listStack.length > 0 &&
				listStack[listStack.length - 1].indent >= indent
			) {
				listStack.pop();
			}

			const parent =
				listStack.length > 0
					? listStack[listStack.length - 1].node
					: baseParent;
			parent.children = parent.children ?? [];
			parent.children.push(node);

			listStack.push({ indent, node });
			continue;
		}

		// Plain paragraph line -> attach as child of current parent so nothing is lost
		const parent =
			listStack.length > 0
				? listStack[listStack.length - 1].node
				: currentHeadingParent ?? ensureRoot();
		const node: NodeObj = {
			id: makeDeterministicId(`p:${lineIndex}:${trimmed}`, usedIds),
			topic: unescapeTopic(trimmed),
			children: [],
		};
		parent.children = parent.children ?? [];
		parent.children.push(node);
	}

	return ensureRoot();
}

function parsePureListBody(
	lines: string[],
	fallbackTitle: string,
	usedIds: Set<string>
): NodeObj {
	const topNodes: NodeObj[] = [];
	const listStack: Array<{ indent: number; node: NodeObj }> = [];
	let lineIndex = 0;

	for (const rawLine of lines) {
		lineIndex++;
		const trimmed = rawLine.trim();
		if (!trimmed) continue;

		const listMatch = rawLine.match(/^(\s*)[-*+]\s+(.*)$/);
		const indent = listMatch ? getIndentWidth(listMatch[1]) : 0;
		const topic = unescapeTopic(listMatch ? listMatch[2] : trimmed);

		const node: NodeObj = {
			id: makeDeterministicId(`list:${lineIndex}:${topic}`, usedIds),
			topic,
			children: [],
		};

		while (
			listStack.length > 0 &&
			listStack[listStack.length - 1].indent >= indent
		) {
			listStack.pop();
		}

		if (listStack.length === 0) {
			topNodes.push(node);
		} else {
			const parent = listStack[listStack.length - 1].node;
			parent.children = parent.children ?? [];
			parent.children.push(node);
		}

		listStack.push({ indent, node });
	}

	if (topNodes.length === 0) {
		return {
			id: makeDeterministicId("root", usedIds),
			topic: fallbackTitle,
			children: [],
		};
	}

	if (topNodes.length === 1) {
		return topNodes[0];
	}

	return {
		id: makeDeterministicId("root", usedIds),
		topic: fallbackTitle,
		children: topNodes,
	};
}

function applySavedNodeIds(
	node: NodeObj,
	pathKey: string,
	nodeIds: Record<string, string>
): void {
	if (nodeIds[pathKey]) {
		node.id = nodeIds[pathKey];
	}
	const children = node.children ?? [];
	for (let i = 0; i < children.length; i++) {
		applySavedNodeIds(children[i], `${pathKey}.${i}`, nodeIds);
	}
}

function collectNodeIds(
	node: NodeObj,
	pathKey: string,
	out: Record<string, string>
): void {
	out[pathKey] = node.id;
	const children = node.children ?? [];
	for (let i = 0; i < children.length; i++) {
		collectNodeIds(children[i], `${pathKey}.${i}`, out);
	}
}

function upsertFrontmatterLines(
	existingRaw: string | null | undefined,
	updates: Record<string, string>
): string {
	const lines = existingRaw ? existingRaw.split(/\r?\n/) : [];
	const seen = new Set<string>();
	const result: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx > 0 && !trimmed.startsWith("#")) {
			const key = trimmed.slice(0, colonIdx).trim();
			if (key in updates) {
				result.push(`${key}: ${updates[key]}`);
				seen.add(key);
				continue;
			}
		}
		result.push(line);
	}

	for (const [key, value] of Object.entries(updates)) {
		if (!seen.has(key)) {
			result.push(`${key}: ${value}`);
		}
	}

	return result.join("\n").trim();
}

export function mindMapToMarkdown(
	data: MindElixirData,
	options: SerializeOptions
): string {
	const direction = options.direction ?? codeToDirection(data.direction);
	const frontmatterBody = upsertFrontmatterLines(options.existingFrontmatterRaw, {
		[MINDMAP_FRONTMATTER_KEY]: "basic",
		[MINDMAP_DIRECTION_KEY]: direction,
	});

	const lines: string[] = [];
	const root = data.nodeData;

	if (options.style === "list") {
		serializeAsList(root, 0, lines);
	} else {
		serializeAsHeadingList(root, lines);
	}

	let output = `---\n${frontmatterBody}\n---\n\n${lines.join("\n")}\n`;

	const hasArrows = Boolean(data.arrows && data.arrows.length > 0);
	const hasSummaries = Boolean(data.summaries && data.summaries.length > 0);
	if (hasArrows || hasSummaries) {
		const nodeIds: Record<string, string> = {};
		collectNodeIds(root, "0", nodeIds);
		const extra: ExtraMetadata = {
			arrows: data.arrows ?? [],
			summaries: data.summaries ?? [],
			nodeIds,
		};
		output += `\n<!-- mindmap-extra: ${JSON.stringify(extra)} -->\n`;
	}

	return output;
}

function serializeAsHeadingList(root: NodeObj, lines: string[]): void {
	lines.push(`# ${escapeTopicForMarkdown(root.topic)}`);

	const mainBranches = root.children ?? [];
	for (const branch of mainBranches) {
		lines.push("");
		lines.push(`## ${escapeTopicForMarkdown(branch.topic)}`);
		const subChildren = branch.children ?? [];
		for (const child of subChildren) {
			serializeAsList(child, 0, lines);
		}
	}
}

function serializeAsList(node: NodeObj, depth: number, lines: string[]): void {
	const indent = "  ".repeat(depth);
	lines.push(`${indent}- ${escapeTopicForMarkdown(node.topic)}`);
	const children = node.children ?? [];
	for (const child of children) {
		serializeAsList(child, depth + 1, lines);
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function sanitizeUrl(url: string): string {
	const trimmed = url.trim();
	if (/^(https?:\/\/|obsidian:\/\/|app:\/\/|capacitor:\/\/|file:\/\/|data:image\/)/i.test(trimmed)) {
		return trimmed;
	}
	return "";
}

/**
 * Renders inline Obsidian Markdown (wikilinks, embedded images, external links,
 * bold/italic/code/strikethrough/highlight/tags) to safe HTML for mind-elixir nodes.
 */
export function renderNodeMarkdown(
	raw: string,
	resolveVaultImage?: (target: string) => string | null
): string {
	const placeholders: string[] = [];
	const stash = (html: string): string => {
		const token = `\u0000MM_${placeholders.length}\u0000`;
		placeholders.push(html);
		return token;
	};

	let text = raw;

	// 1. Inline code first so syntax inside backticks is preserved literally
	text = text.replace(/`([^`]+)`/g, (_m, code: string) => {
		return stash(`<code class="mm-inline-code">${escapeHtml(code)}</code>`);
	});

	// 2. Obsidian image embeds: ![[image.png]] or ![[image.png|200]] or ![[image.png|200x120]]
	text = text.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, size?: string) => {
		const cleanTarget = target.trim();
		const resolved = resolveVaultImage ? resolveVaultImage(cleanTarget) : null;
		if (!resolved) {
			return stash(
				`<span class="mm-broken-img" title="${escapeHtml(cleanTarget)}">🖼️ ${escapeHtml(cleanTarget)}</span>`
			);
		}
		const sizeStyle = parseObsidianImageSize(size);
		return stash(
			`<img class="mm-node-img" src="${escapeHtml(resolved)}" alt="${escapeHtml(cleanTarget)}"${sizeStyle} draggable="false" />`
		);
	});

	// 3. Standard Markdown images: ![alt](url)
	text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, rawUrl: string) => {
		const trimmed = rawUrl.trim();
		const resolved =
			sanitizeUrl(trimmed) ||
			(resolveVaultImage ? resolveVaultImage(trimmed) : null);
		if (!resolved) {
			return stash(`<span class="mm-broken-img">🖼️ ${escapeHtml(alt || trimmed)}</span>`);
		}
		return stash(
			`<img class="mm-node-img" src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}" draggable="false" />`
		);
	});

	// 4. Obsidian wikilinks: [[target]] or [[target|alias]]
	text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
		const cleanTarget = target.trim();
		const label = (alias ?? cleanTarget).trim();
		return stash(
			`<a class="internal-link mm-wikilink" data-href="${escapeHtml(cleanTarget)}" href="${escapeHtml(cleanTarget)}">${escapeHtml(label)}</a>`
		);
	});

	// 5. Standard Markdown links: [label](url)
	text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, rawUrl: string) => {
		const safeUrl = sanitizeUrl(rawUrl);
		if (!safeUrl) {
			return escapeHtml(label);
		}
		return stash(
			`<a class="external-link mm-extlink" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
		);
	});

	// Escape remaining plain text
	text = escapeHtml(text);

	// 6. Inline text styles
	text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");
	text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
	text = text.replace(/==(.+?)==/g, '<mark class="mm-highlight">$1</mark>');
	text = text.replace(/(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)/g, "<em>$1</em>");

	// 7. Inline Obsidian tags (#tag)
	text = text.replace(
		/(^|[\s(])#([A-Za-z0-9_\-/\u4e00-\u9fa5]+)/g,
		'$1<span class="mm-tag">#$2</span>'
	);

	// 8. Preserve explicit line breaks
	text = text.replace(/\r?\n/g, "<br>");

	// Restore stashed HTML tokens
	text = text.replace(/\u0000MM_(\d+)\u0000/g, (_m, idxStr: string) => {
		return placeholders[Number(idxStr)] ?? "";
	});

	return text;
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
