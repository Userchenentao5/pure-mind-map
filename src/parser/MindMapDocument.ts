import type { MindElixirData } from "mind-elixir";
import {
	MINDMAP_DIRECTION_KEY,
	directionToCode,
	type MarkdownSerializeStyle,
	type MindMapDirection,
} from "../settings/types";
import { markdownToMindMap, mindMapToMarkdown } from "./markdownParser";

export interface ReconcileOptions {
	fallbackTitle: string;
	defaultDirection: MindMapDirection;
	clear: boolean;
	hasCanvas: boolean;
}

export type ReconcileDecision =
	| { action: "noop" }
	| {
			action: "mount" | "refresh";
			data: MindElixirData;
			direction: MindMapDirection;
	  };

/**
 * Pure in-process Mind Map Note document model:
 * - Reconciles incoming external Markdown (noop / mount / refresh)
 * - Tracks frontmatter preservation and layout direction precedence
 * - Separates pure serialization reads from confirmed disk saves
 */
export class MindMapDocument {
	private existingFrontmatterRaw: string | null = null;
	private currentDirection: MindMapDirection;
	private lastSavedMarkdown = "";
	private hasLocalEdits = false;

	constructor(defaultDirection: MindMapDirection) {
		this.currentDirection = defaultDirection;
	}

	public get direction(): MindMapDirection {
		return this.currentDirection;
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

	public clear(defaultDirection: MindMapDirection): void {
		this.existingFrontmatterRaw = null;
		this.currentDirection = defaultDirection;
		this.lastSavedMarkdown = "";
		this.hasLocalEdits = false;
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
		this.currentDirection = parsed.frontmatter.properties[MINDMAP_DIRECTION_KEY]
			? parsed.direction
			: options.defaultDirection;
		parsed.data.direction = directionToCode(this.currentDirection);

		this.lastSavedMarkdown = markdown;
		this.hasLocalEdits = false;

		return {
			action: options.clear || !options.hasCanvas ? "mount" : "refresh",
			data: parsed.data,
			direction: this.currentDirection,
		};
	}
}
