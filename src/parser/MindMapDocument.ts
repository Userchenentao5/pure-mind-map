import type { MindElixirData } from "mind-elixir";
import {
	MINDMAP_DIRECTION_KEY,
	directionToCode,
	type MarkdownSerializeStyle,
	type MindMapDirection,
	type MindMapStylePreset,
} from "../settings/types";
import {
	findNodePathKeyById,
	markdownToMindMap,
	mindMapToMarkdown,
	resolveNodeByPathKey,
	type NodeLineEntry,
	type PreservedMarkdownBlock,
} from "./markdownParser";

export { findNodePathKeyById, resolveNodeByPathKey };

/**
 * Pure lookup of a 0-based Markdown line number from a precomputed NodeLineEntry index.
 */
export function findLineInNodeIndex(
	nodeLines: readonly NodeLineEntry[],
	pathKey: string,
	topicFallback?: string
): number | null {
	const exact = nodeLines.find((entry) => entry.pathKey === pathKey);
	if (exact) return exact.line;

	if (topicFallback) {
		const byTopic = nodeLines.find((entry) => entry.topic === topicFallback);
		if (byTopic) return byTopic.line;
	}
	return null;
}

/**
 * Pure lookup of the owning Node pathKey for a 0-based Markdown cursor line
 * (exact match, or nearest preceding Node line for comments/notes/code blocks).
 */
export function findNodePathInLineIndex(
	nodeLines: readonly NodeLineEntry[],
	cursorLine: number
): string | null {
	if (cursorLine < 0 || nodeLines.length === 0) return null;

	let best: { pathKey: string; line: number } | null = null;
	for (const entry of nodeLines) {
		if (entry.line === cursorLine) {
			return entry.pathKey;
		}
		if (entry.line < cursorLine) {
			if (!best || entry.line >= best.line) {
				best = { pathKey: entry.pathKey, line: entry.line };
			}
		}
	}

	return best ? best.pathKey : null;
}

/**
 * Lightweight per-file cache of parsed NodeLineEntry snapshots so Split View
 * cursor navigation and Node clicks avoid re-parsing unchanged Markdown.
 */
export class MarkdownLineIndexCache {
	private entries = new Map<
		string,
		{ markdown: string; nodeLines: readonly NodeLineEntry[] }
	>();

	public getLineIndex(
		filePath: string,
		markdown: string
	): readonly NodeLineEntry[] {
		const cached = this.entries.get(filePath);
		if (cached && cached.markdown === markdown) {
			return cached.nodeLines;
		}
		const nodeLines = markdownToMindMap(markdown).nodeLines;
		this.entries.set(filePath, { markdown, nodeLines });
		return nodeLines;
	}

	public findLineForNodePath(
		filePath: string,
		markdown: string,
		pathKey: string,
		topicFallback?: string
	): number | null {
		return findLineInNodeIndex(
			this.getLineIndex(filePath, markdown),
			pathKey,
			topicFallback
		);
	}

	public findNodePathForLine(
		filePath: string,
		markdown: string,
		cursorLine: number
	): string | null {
		return findNodePathInLineIndex(
			this.getLineIndex(filePath, markdown),
			cursorLine
		);
	}

	public clear(): void {
		this.entries.clear();
	}
}

export interface ReconcileOptions {
	fallbackTitle: string;
	defaultDirection: MindMapDirection;
	defaultStylePreset?: MindMapStylePreset;
	clear: boolean;
	hasCanvas: boolean;
}

export type ReconcileDecision =
	| { action: "noop" }
	| {
			action: "mount" | "refresh";
			data: MindElixirData;
			direction: MindMapDirection;
			stylePreset: MindMapStylePreset;
	  };

/**
 * Pure in-process Mind Map Note document model:
 * - Reconciles incoming external Markdown (noop / mount / refresh)
 * - Tracks frontmatter preservation, layout direction, and style preset precedence
 * - Separates pure serialization reads from confirmed disk saves
 */
export class MindMapDocument {
	private existingFrontmatterRaw: string | null = null;
	private preservedBlocks: PreservedMarkdownBlock[] = [];
	private nodeLines: readonly NodeLineEntry[] = [];
	private currentDirection: MindMapDirection;
	private currentStylePreset: MindMapStylePreset;
	private hasExplicitStylePreset = false;
	private lastSavedMarkdown = "";
	private hasLocalEdits = false;

	constructor(
		defaultDirection: MindMapDirection,
		defaultStylePreset: MindMapStylePreset = "classic"
	) {
		this.currentDirection = defaultDirection;
		this.currentStylePreset = defaultStylePreset;
	}

	public get direction(): MindMapDirection {
		return this.currentDirection;
	}

	public get stylePreset(): MindMapStylePreset {
		return this.currentStylePreset;
	}

	public hasExplicitStyleInNote(): boolean {
		return this.hasExplicitStylePreset;
	}

	public get lastSyncedMarkdown(): string {
		return this.lastSavedMarkdown;
	}

	public hasPendingLocalEdits(): boolean {
		return this.hasLocalEdits;
	}

	public setDirection(direction: MindMapDirection): void {
		this.currentDirection = direction;
	}

	public setStylePreset(preset: MindMapStylePreset, explicit = true): void {
		this.currentStylePreset = preset;
		if (explicit) {
			this.hasExplicitStylePreset = true;
		}
	}

	public markLocalEdit(): void {
		this.hasLocalEdits = true;
	}

	/**
	 * Records the markdown being written so echo setViewData callbacks triggered
	 * during save() are skipped, without prematurely clearing dirty status if write fails.
	 */
	public markSaveInFlight(markdown: string): void {
		this.lastSavedMarkdown = markdown;
	}

	public markSaved(markdown: string): void {
		this.lastSavedMarkdown = markdown;
		this.hasLocalEdits = false;
	}

	public clear(
		defaultDirection: MindMapDirection,
		defaultStylePreset: MindMapStylePreset = "classic"
	): void {
		this.existingFrontmatterRaw = null;
		this.preservedBlocks = [];
		this.nodeLines = [];
		this.currentDirection = defaultDirection;
		this.currentStylePreset = defaultStylePreset;
		this.hasExplicitStylePreset = false;
		this.lastSavedMarkdown = "";
		this.hasLocalEdits = false;
	}

	public findLineForNodePath(
		pathKey: string,
		topicFallback?: string
	): number | null {
		return findLineInNodeIndex(this.nodeLines, pathKey, topicFallback);
	}

	public findNodePathForLine(cursorLine: number): string | null {
		return findNodePathInLineIndex(this.nodeLines, cursorLine);
	}

	/**
	 * Pure read: serializes current MindElixir state when local edits exist,
	 * or preserves the untouched raw Markdown from Source Mode otherwise.
	 * Never mutates dirty state.
	 */
	public serialize(
		data: MindElixirData | null,
		style: MarkdownSerializeStyle,
		fallbackRaw = ""
	): string {
		if (!data) {
			return this.lastSavedMarkdown || fallbackRaw;
		}
		if (!this.hasLocalEdits && this.lastSavedMarkdown) {
			return this.lastSavedMarkdown;
		}
		return mindMapToMarkdown(data, {
			existingFrontmatterRaw: this.existingFrontmatterRaw,
			style,
			direction: this.currentDirection,
			stylePreset: this.hasExplicitStylePreset
				? this.currentStylePreset
				: undefined,
			preservedBlocks: this.preservedBlocks,
		});
	}

	public reconcileExternalMarkdown(
		markdown: string,
		options: ReconcileOptions
	): ReconcileDecision {
		if (!options.clear && options.hasCanvas && markdown === this.lastSavedMarkdown) {
			this.hasLocalEdits = false;
			return { action: "noop" };
		}

		const parsed = markdownToMindMap(markdown, options.fallbackTitle);
		this.existingFrontmatterRaw = parsed.frontmatter.raw;
		this.preservedBlocks = parsed.preservedBlocks;
		this.nodeLines = parsed.nodeLines;
		this.currentDirection = parsed.frontmatter.properties[MINDMAP_DIRECTION_KEY]
			? parsed.direction
			: options.defaultDirection;
		this.hasExplicitStylePreset = parsed.stylePreset !== undefined;
		this.currentStylePreset =
			parsed.stylePreset ?? options.defaultStylePreset ?? "classic";
		parsed.data.direction = directionToCode(this.currentDirection);

		this.lastSavedMarkdown = markdown;
		this.hasLocalEdits = false;

		return {
			action: options.clear || !options.hasCanvas ? "mount" : "refresh",
			data: parsed.data,
			direction: this.currentDirection,
			stylePreset: this.currentStylePreset,
		};
	}
}
