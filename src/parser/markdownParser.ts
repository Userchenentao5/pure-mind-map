import type { MindElixirData, NodeObj } from "mind-elixir";
import {
	MINDMAP_DIRECTION_KEY,
	MINDMAP_FRONTMATTER_KEY,
	MINDMAP_STYLE_KEY,
	type MarkdownSerializeStyle,
	type MindMapDirection,
	type MindMapStylePreset,
	codeToDirection,
	directionToCode,
} from "../settings/types";

export interface FrontmatterResult {
	raw: string | null;
	properties: Record<string, string>;
	body: string;
}

export interface PreservedMarkdownBlock {
	raw: string;
	afterNodeId: string | null;
	ancestorNodeIds?: string[];
	blankBefore: boolean;
	blankAfter: boolean;
}

export interface ParsedMindMap {
	frontmatter: FrontmatterResult;
	data: MindElixirData;
	direction: MindMapDirection;
	stylePreset?: MindMapStylePreset;
	preservedBlocks: PreservedMarkdownBlock[];
}

export interface SerializeOptions {
	existingFrontmatterRaw?: string | null;
	style: MarkdownSerializeStyle;
	direction?: MindMapDirection;
	stylePreset?: MindMapStylePreset;
	preservedBlocks?: PreservedMarkdownBlock[];
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

export function isMindMapFrontmatterValue(value: unknown): boolean {
	if (value === undefined || value === null || value === false) {
		return false;
	}
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value !== "string" && typeof value !== "number") {
		return false;
	}
	const text = String(value).trim().toLowerCase();
	return text !== "" && text !== "false";
}

export function hasMindMapFrontmatter(markdown: string): boolean {
	const { properties } = extractFrontmatter(markdown);
	return isMindMapFrontmatterValue(properties[MINDMAP_FRONTMATTER_KEY]);
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
	style: MarkdownSerializeStyle = "heading-list",
	stylePreset: MindMapStylePreset = "classic"
): string {
	const safeTitle = title.trim() || "中心主题";
	const styleLine =
		stylePreset !== "classic" ? `${MINDMAP_STYLE_KEY}: ${stylePreset}\n` : "";
	const frontmatter = `---\n${MINDMAP_FRONTMATTER_KEY}: basic\n${MINDMAP_DIRECTION_KEY}: ${direction}\n${styleLine}---\n\n`;

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

export function parseStylePresetValue(val?: string): MindMapStylePreset | undefined {
	if (val === "classic" || val === "card" || val === "bordered") {
		return val;
	}
	return undefined;
}

function unescapeTopic(text: string): string {
	return text.replace(/<br\s*\/?>/gi, "\n").trim();
}

function escapeTopicForMarkdown(topic: string): string {
	return topic.replace(/\r?\n/g, "<br>").trim() || "未命名节点";
}

type BodyToken =
	| { kind: "blank" }
	| { kind: "line"; raw: string; lineIndex: number }
	| {
			kind: "raw-block";
			raw: string;
			lineIndex: number;
			blankBefore: boolean;
			blankAfter: boolean;
	  };

interface CapturedPreservedBlock {
	raw: string;
	anchorNode: NodeObj | null;
	blankBefore: boolean;
	blankAfter: boolean;
}

function matchFenceOpen(rawLine: string): { char: "`" | "~"; length: number } | null {
	const backtickMatch = rawLine.match(/^\s*(`{3,})[^`]*$/);
	if (backtickMatch) {
		return { char: "`", length: backtickMatch[1].length };
	}
	const tildeMatch = rawLine.match(/^\s*(~{3,}).*$/);
	if (tildeMatch) {
		return { char: "~", length: tildeMatch[1].length };
	}
	return null;
}

function isFenceClose(rawLine: string, char: "`" | "~", minLength: number): boolean {
	const trimmed = rawLine.trim();
	if (trimmed.length < minLength) return false;
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed[i] !== char) return false;
	}
	return true;
}

function tokenizeMarkdownBody(lines: string[]): BodyToken[] {
	const rawTokens: Array<
		| { kind: "blank" }
		| { kind: "line"; raw: string; lineIndex: number }
		| { kind: "raw-block"; raw: string; lineIndex: number }
	> = [];

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const lineIndex = i + 1;
		const trimmed = rawLine.trim();

		if (!trimmed) {
			rawTokens.push({ kind: "blank" });
			continue;
		}

		// 1. Fenced code blocks (``` or ~~~)
		const fenceOpen = matchFenceOpen(rawLine);
		if (fenceOpen) {
			const blockLines = [rawLine];
			while (i + 1 < lines.length) {
				i++;
				blockLines.push(lines[i]);
				if (isFenceClose(lines[i], fenceOpen.char, fenceOpen.length)) {
					break;
				}
			}
			rawTokens.push({
				kind: "raw-block",
				raw: blockLines.join("\n"),
				lineIndex,
			});
			continue;
		}

		// 2. Standalone HTML comments (single-line or multi-line)
		if (trimmed.startsWith("<!--")) {
			if (/^(?:<!--[\s\S]*?-->\s*)+$/.test(trimmed)) {
				rawTokens.push({
					kind: "raw-block",
					raw: rawLine,
					lineIndex,
				});
				continue;
			}
			if (!trimmed.includes("-->")) {
				const blockLines = [rawLine];
				while (i + 1 < lines.length) {
					i++;
					blockLines.push(lines[i]);
					if (lines[i].includes("-->")) {
						break;
					}
				}
				rawTokens.push({
					kind: "raw-block",
					raw: blockLines.join("\n"),
					lineIndex,
				});
				continue;
			}
		}

		// 3. Standalone Obsidian comments (%% ... %%, including empty %%%%)
		if (trimmed.startsWith("%%")) {
			if (/^(?:%%[\s\S]*?%%\s*)+$/.test(trimmed)) {
				rawTokens.push({
					kind: "raw-block",
					raw: rawLine,
					lineIndex,
				});
				continue;
			}
			if (!trimmed.slice(2).includes("%%")) {
				let closingIndex = -1;
				for (let j = i + 1; j < lines.length; j++) {
					if (lines[j].includes("%%")) {
						closingIndex = j;
						break;
					}
				}
				if (closingIndex !== -1) {
					const blockLines = lines.slice(i, closingIndex + 1);
					i = closingIndex;
					rawTokens.push({
						kind: "raw-block",
						raw: blockLines.join("\n"),
						lineIndex,
					});
					continue;
				}
			}
		}

		rawTokens.push({ kind: "line", raw: rawLine, lineIndex });
	}

	const tokens: BodyToken[] = [];
	let hasSeenNonBlank = false;
	let sawBlankSincePrevNonBlank = false;

	for (let i = 0; i < rawTokens.length; i++) {
		const token = rawTokens[i];
		if (token.kind === "blank") {
			sawBlankSincePrevNonBlank = true;
			tokens.push(token);
			continue;
		}

		if (token.kind === "raw-block") {
			const blankBefore = hasSeenNonBlank && sawBlankSincePrevNonBlank;
			let j = i + 1;
			let sawBlankAfter = false;
			while (j < rawTokens.length && rawTokens[j].kind === "blank") {
				sawBlankAfter = true;
				j++;
			}
			const blankAfter = sawBlankAfter && j < rawTokens.length;
			tokens.push({
				kind: "raw-block",
				raw: token.raw,
				lineIndex: token.lineIndex,
				blankBefore,
				blankAfter,
			});
		} else {
			tokens.push(token);
		}

		hasSeenNonBlank = true;
		sawBlankSincePrevNonBlank = false;
	}

	return tokens;
}

export function markdownToMindMap(
	markdown: string,
	fallbackTitle = "中心主题"
): ParsedMindMap {
	const frontmatter = extractFrontmatter(markdown);
	const direction = parseDirectionValue(frontmatter.properties[MINDMAP_DIRECTION_KEY]);
	const stylePreset = parseStylePresetValue(frontmatter.properties[MINDMAP_STYLE_KEY]);

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

	const tokens = tokenizeMarkdownBody(body.split(/\r?\n/));
	const usedIds = new Set<string>();
	const capturedBlocks: CapturedPreservedBlock[] = [];
	const parentMap = new WeakMap<NodeObj, NodeObj | null>();

	const hasHeading = tokens.some(
		(t) => t.kind === "line" && /^\s*#{1,6}\s+/.test(t.raw)
	);
	let root: NodeObj;

	if (hasHeading) {
		root = parseHeadingAndListBody(
			tokens,
			fallbackTitle,
			usedIds,
			capturedBlocks,
			parentMap
		);
	} else {
		root = parsePureListBody(
			tokens,
			fallbackTitle,
			usedIds,
			capturedBlocks,
			parentMap
		);
	}

	if (extra?.nodeIds) {
		applySavedNodeIds(root, "0", extra.nodeIds);
	}

	const preservedBlocks: PreservedMarkdownBlock[] = capturedBlocks.map((block) => {
		const ancestorNodeIds: string[] = [];
		let cursor = block.anchorNode ? parentMap.get(block.anchorNode) ?? null : null;
		while (cursor) {
			ancestorNodeIds.push(cursor.id);
			cursor = parentMap.get(cursor) ?? null;
		}
		return {
			raw: block.raw,
			afterNodeId: block.anchorNode ? block.anchorNode.id : null,
			ancestorNodeIds,
			blankBefore: block.blankBefore,
			blankAfter: block.blankAfter,
		};
	});

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
		stylePreset,
		preservedBlocks,
	};
}

function parseHeadingAndListBody(
	tokens: BodyToken[],
	fallbackTitle: string,
	usedIds: Set<string>,
	capturedBlocks: CapturedPreservedBlock[],
	parentMap: WeakMap<NodeObj, NodeObj | null>
): NodeObj {
	let root: NodeObj | null = null;
	let isSyntheticRoot = false;
	const headingStack: Array<{ level: number; node: NodeObj }> = [];
	const listStack: Array<{ indent: number; node: NodeObj }> = [];
	let currentHeadingParent: NodeObj | null = null;
	let lastNode: NodeObj | null = null;

	const ensureRoot = (): NodeObj => {
		if (!root) {
			root = {
				id: makeDeterministicId("root", usedIds),
				topic: fallbackTitle,
				children: [],
			};
			parentMap.set(root, null);
			isSyntheticRoot = true;
			headingStack.push({ level: 1, node: root });
			currentHeadingParent = root;
		}
		return root;
	};

	for (const token of tokens) {
		if (token.kind === "blank") continue;

		if (token.kind === "raw-block") {
			capturedBlocks.push({
				raw: token.raw,
				anchorNode: lastNode,
				blankBefore: token.blankBefore,
				blankAfter: token.blankAfter,
			});
			continue;
		}

		const { raw: rawLine, lineIndex } = token;
		const trimmed = rawLine.trim();

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
					parentMap.set(root, null);
					isSyntheticRoot = false;
				}
				headingStack.length = 0;
				headingStack.push({ level: 1, node: root });
				currentHeadingParent = root;
				lastNode = root;
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
			parentMap.set(node, parent);

			headingStack.push({ level, node });
			currentHeadingParent = node;
			lastNode = node;
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
			parentMap.set(node, parent);

			listStack.push({ indent, node });
			lastNode = node;
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
		parentMap.set(node, parent);
		lastNode = node;
	}

	return ensureRoot();
}

function parsePureListBody(
	tokens: BodyToken[],
	fallbackTitle: string,
	usedIds: Set<string>,
	capturedBlocks: CapturedPreservedBlock[],
	parentMap: WeakMap<NodeObj, NodeObj | null>
): NodeObj {
	const topNodes: NodeObj[] = [];
	const listStack: Array<{ indent: number; node: NodeObj }> = [];
	let lastNode: NodeObj | null = null;

	for (const token of tokens) {
		if (token.kind === "blank") continue;

		if (token.kind === "raw-block") {
			capturedBlocks.push({
				raw: token.raw,
				anchorNode: lastNode,
				blankBefore: token.blankBefore,
				blankAfter: token.blankAfter,
			});
			continue;
		}

		const { raw: rawLine, lineIndex } = token;
		const trimmed = rawLine.trim();

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
			parentMap.set(node, null);
		} else {
			const parent = listStack[listStack.length - 1].node;
			parent.children = parent.children ?? [];
			parent.children.push(node);
			parentMap.set(node, parent);
		}

		listStack.push({ indent, node });
		lastNode = node;
	}

	if (topNodes.length === 0) {
		const root: NodeObj = {
			id: makeDeterministicId("root", usedIds),
			topic: fallbackTitle,
			children: [],
		};
		parentMap.set(root, null);
		return root;
	}

	if (topNodes.length === 1) {
		return topNodes[0];
	}

	const root: NodeObj = {
		id: makeDeterministicId("root", usedIds),
		topic: fallbackTitle,
		children: topNodes,
	};
	parentMap.set(root, null);
	for (const topNode of topNodes) {
		parentMap.set(topNode, root);
	}
	return root;
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

class MarkdownBodyWriter {
	public readonly lines: string[] = [];
	private pendingBlank = false;

	public pushNodeLine(line: string, forceBlankBefore = false): void {
		if (
			(forceBlankBefore || this.pendingBlank) &&
			this.lines.length > 0 &&
			this.lines[this.lines.length - 1] !== ""
		) {
			this.lines.push("");
		}
		this.pendingBlank = false;
		this.lines.push(line);
	}

	public pushPreservedBlocks(
		blocks: PreservedMarkdownBlock[] | undefined,
		forceBlankBeforeFirst = false
	): void {
		if (!blocks || blocks.length === 0) return;
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			const needsBlank =
				(i === 0 && forceBlankBeforeFirst) ||
				block.blankBefore ||
				this.pendingBlank;
			if (
				needsBlank &&
				this.lines.length > 0 &&
				this.lines[this.lines.length - 1] !== ""
			) {
				this.lines.push("");
			}
			this.lines.push(block.raw);
			this.pendingBlank = block.blankAfter;
		}
	}
}

function collectPresentNodeIds(node: NodeObj, out: Set<string>): void {
	out.add(node.id);
	const children = node.children ?? [];
	for (const child of children) {
		collectPresentNodeIds(child, out);
	}
}

function partitionPreservedBlocks(
	root: NodeObj,
	preservedBlocks: PreservedMarkdownBlock[] | undefined
): {
	preambleBlocks: PreservedMarkdownBlock[];
	blocksAfterNode: Map<string, PreservedMarkdownBlock[]>;
	trailingBlocks: PreservedMarkdownBlock[];
} {
	const preambleBlocks: PreservedMarkdownBlock[] = [];
	const blocksAfterNode = new Map<string, PreservedMarkdownBlock[]>();
	const trailingBlocks: PreservedMarkdownBlock[] = [];

	if (!preservedBlocks || preservedBlocks.length === 0) {
		return { preambleBlocks, blocksAfterNode, trailingBlocks };
	}

	const presentNodeIds = new Set<string>();
	collectPresentNodeIds(root, presentNodeIds);

	const appendAfter = (nodeId: string, block: PreservedMarkdownBlock): void => {
		const list = blocksAfterNode.get(nodeId);
		if (list) {
			list.push(block);
		} else {
			blocksAfterNode.set(nodeId, [block]);
		}
	};

	for (const block of preservedBlocks) {
		if (block.afterNodeId === null) {
			preambleBlocks.push(block);
			continue;
		}
		if (presentNodeIds.has(block.afterNodeId)) {
			appendAfter(block.afterNodeId, block);
			continue;
		}
		const fallbackAncestor = block.ancestorNodeIds?.find((id) =>
			presentNodeIds.has(id)
		);
		if (fallbackAncestor) {
			appendAfter(fallbackAncestor, block);
			continue;
		}
		trailingBlocks.push(block);
	}

	return { preambleBlocks, blocksAfterNode, trailingBlocks };
}

export function mindMapToMarkdown(
	data: MindElixirData,
	options: SerializeOptions
): string {
	const direction = options.direction ?? codeToDirection(data.direction);
	const frontmatterUpdates: Record<string, string> = {
		[MINDMAP_FRONTMATTER_KEY]: "basic",
		[MINDMAP_DIRECTION_KEY]: direction,
	};
	const existingHasStyle = Boolean(
		options.existingFrontmatterRaw &&
			new RegExp(`^\\s*${MINDMAP_STYLE_KEY}\\s*:`, "m").test(
				options.existingFrontmatterRaw
			)
	);
	if (
		options.stylePreset &&
		(options.stylePreset !== "classic" || existingHasStyle)
	) {
		frontmatterUpdates[MINDMAP_STYLE_KEY] = options.stylePreset;
	}
	const frontmatterBody = upsertFrontmatterLines(
		options.existingFrontmatterRaw,
		frontmatterUpdates
	);

	const root = data.nodeData;
	const { preambleBlocks, blocksAfterNode, trailingBlocks } =
		partitionPreservedBlocks(root, options.preservedBlocks);
	const writer = new MarkdownBodyWriter();

	writer.pushPreservedBlocks(preambleBlocks);

	if (options.style === "list") {
		serializeAsList(root, 0, writer, blocksAfterNode);
	} else {
		serializeAsHeadingList(root, writer, blocksAfterNode);
	}

	writer.pushPreservedBlocks(trailingBlocks, true);

	let output = `---\n${frontmatterBody}\n---\n\n${writer.lines.join("\n")}\n`;

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

function serializeAsHeadingList(
	root: NodeObj,
	writer: MarkdownBodyWriter,
	blocksAfterNode: Map<string, PreservedMarkdownBlock[]>
): void {
	writer.pushNodeLine(`# ${escapeTopicForMarkdown(root.topic)}`);
	writer.pushPreservedBlocks(blocksAfterNode.get(root.id));

	const mainBranches = root.children ?? [];
	for (const branch of mainBranches) {
		writer.pushNodeLine(`## ${escapeTopicForMarkdown(branch.topic)}`, true);
		writer.pushPreservedBlocks(blocksAfterNode.get(branch.id));
		const subChildren = branch.children ?? [];
		for (const child of subChildren) {
			serializeAsList(child, 0, writer, blocksAfterNode);
		}
	}
}

function serializeAsList(
	node: NodeObj,
	depth: number,
	writer: MarkdownBodyWriter,
	blocksAfterNode: Map<string, PreservedMarkdownBlock[]>
): void {
	const indent = "  ".repeat(depth);
	writer.pushNodeLine(`${indent}- ${escapeTopicForMarkdown(node.topic)}`);
	writer.pushPreservedBlocks(blocksAfterNode.get(node.id));
	const children = node.children ?? [];
	for (const child of children) {
		serializeAsList(child, depth + 1, writer, blocksAfterNode);
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
		const token = `\uE000MM_${placeholders.length}\uE001`;
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
	text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
	text = text.replace(/(^|[^*])\*([^*]+?)\*(?=\*\*[^*]+?\*\*)/g, "$1<em>$2</em>");
	text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");
	text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
	text = text.replace(/==(.+?)==/g, '<mark class="mm-highlight">$1</mark>');
	text = text.replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, "$1<em>$2</em>");

	// 7. Inline Obsidian tags (#tag)
	text = text.replace(
		/(^|[\s(])#([A-Za-z0-9_\-/\u4e00-\u9fa5]+)/g,
		'$1<span class="mm-tag">#$2</span>'
	);

	// 8. Preserve explicit line breaks
	text = text.replace(/\r?\n/g, "<br>");

	// Restore stashed HTML tokens
	text = text.replace(/\uE000MM_(\d+)\uE001/g, (_m, idxStr: string) => {
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
