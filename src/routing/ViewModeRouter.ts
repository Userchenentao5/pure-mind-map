import { hasMindMapFrontmatter } from "../parser/markdownParser";
import { MINDMAP_VIEW_TYPE } from "../settings/types";

export interface LeafSnapshot {
	kind: "mindmap" | "markdown" | "other";
	filePath: string | null;
	rawMarkdown?: string | null;
}

export type ViewStateTarget =
	| { type: "markdown"; filePath: string; mode: "source" }
	| { type: "mindmap"; filePath: string };

export interface ViewModeRouterAdapter<TLeaf extends object> {
	isAutoOpenEnabled(): boolean;
	isMindMapPath(filePath: string): boolean;
	inspectLeaf(leaf: TLeaf): LeafSnapshot | null;
	prepareForSwitch(leaf: TLeaf, currentKind: "mindmap" | "markdown"): Promise<void>;
	applyViewState(leaf: TLeaf, target: ViewStateTarget): Promise<void>;
}

export interface ShortcutKeyLike {
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	key: string;
	code: string;
}

/**
 * Matches Ctrl+. (or Cmd+. on macOS) even when Chinese IME emits key === "Process" / "。"
 * with physical key code === "Period".
 */
export function isImePeriodToggleShortcut(evt: ShortcutKeyLike): boolean {
	const isModOnly = (evt.ctrlKey || evt.metaKey) && !evt.altKey && !evt.shiftKey;
	if (!isModOnly) return false;
	return evt.key === "." || evt.key === "。" || evt.code === "Period";
}

/**
 * Deep module owning the Mind Map <-> Source Mode routing state machine:
 * - Auto-open redirect evaluation for Mind Map Notes
 * - Per-tab View-Mode Override lifecycle
 * - Re-entrancy-locked commit/save-before-switch transitions
 * - Unified toggle and header-action eligibility checks
 */
export class ViewModeRouter<TLeaf extends object> {
	private adapter: ViewModeRouterAdapter<TLeaf>;
	private overrides = new WeakMap<TLeaf, string>();
	private isSwitching = false;

	constructor(adapter: ViewModeRouterAdapter<TLeaf>) {
		this.adapter = adapter;
	}

	public hasOverrideFor(leaf: TLeaf, filePath: string): boolean {
		return this.overrides.get(leaf) === filePath;
	}

	public clearOverride(leaf: TLeaf): void {
		this.overrides.delete(leaf);
	}

	/**
	 * Decides the effective view type when a tab's view state is updated.
	 * Mutates the per-tab View-Mode Override cleanly on navigation or mode entry.
	 */
	public resolveIncomingViewType(
		leaf: TLeaf,
		incomingType: string,
		filePath: string | null
	): string {
		if (
			this.adapter.isAutoOpenEnabled() &&
			incomingType === "markdown" &&
			filePath
		) {
			const forcedPath = this.overrides.get(leaf);
			if (forcedPath && forcedPath !== filePath) {
				this.overrides.delete(leaf);
			}

			if (
				this.overrides.get(leaf) !== filePath &&
				this.adapter.isMindMapPath(filePath)
			) {
				return MINDMAP_VIEW_TYPE;
			}
		} else if (incomingType === MINDMAP_VIEW_TYPE) {
			this.overrides.delete(leaf);
		}

		return incomingType;
	}

	public isMarkdownMindMapLeaf(leaf: TLeaf): boolean {
		const snap = this.adapter.inspectLeaf(leaf);
		if (!snap || snap.kind !== "markdown" || !snap.filePath) {
			return false;
		}
		if (this.adapter.isMindMapPath(snap.filePath)) {
			return true;
		}
		return (
			typeof snap.rawMarkdown === "string" &&
			hasMindMapFrontmatter(snap.rawMarkdown)
		);
	}

	public shouldAutoOpenOnLayoutReady(leaf: TLeaf): string | null {
		if (!this.adapter.isAutoOpenEnabled()) return null;
		const snap = this.adapter.inspectLeaf(leaf);
		if (!snap || snap.kind !== "markdown" || !snap.filePath) return null;
		if (this.overrides.get(leaf) === snap.filePath) return null;
		if (!this.isMarkdownMindMapLeaf(leaf)) return null;
		return snap.filePath;
	}

	public canToggleLeaf(leaf: TLeaf): boolean {
		const snap = this.adapter.inspectLeaf(leaf);
		if (!snap || !snap.filePath) return false;
		if (snap.kind === "mindmap") return true;
		if (snap.kind === "markdown") return this.isMarkdownMindMapLeaf(leaf);
		return false;
	}

	public async toggleLeaf(leaf: TLeaf): Promise<boolean> {
		const snap = this.adapter.inspectLeaf(leaf);
		if (!snap || !snap.filePath) return false;

		if (snap.kind === "mindmap") {
			await this.switchToSourceMode(leaf, snap.filePath);
			return true;
		}

		if (snap.kind === "markdown" && this.isMarkdownMindMapLeaf(leaf)) {
			await this.switchToMindMap(leaf, snap.filePath);
			return true;
		}

		return false;
	}

	public async switchToSourceMode(leaf: TLeaf, filePath: string): Promise<void> {
		if (!filePath || this.isSwitching) return;
		this.isSwitching = true;
		try {
			const snap = this.adapter.inspectLeaf(leaf);
			if (snap?.kind === "mindmap") {
				await this.adapter.prepareForSwitch(leaf, "mindmap");
			}
			this.overrides.set(leaf, filePath);
			await this.adapter.applyViewState(leaf, {
				type: "markdown",
				filePath,
				mode: "source",
			});
		} finally {
			this.isSwitching = false;
		}
	}

	public async switchToMindMap(leaf: TLeaf, filePath: string): Promise<void> {
		if (!filePath || this.isSwitching) return;
		this.isSwitching = true;
		try {
			const snap = this.adapter.inspectLeaf(leaf);
			if (snap?.kind === "markdown") {
				await this.adapter.prepareForSwitch(leaf, "markdown");
			}
			this.overrides.delete(leaf);
			await this.adapter.applyViewState(leaf, {
				type: "mindmap",
				filePath,
			});
		} finally {
			this.isSwitching = false;
		}
	}
}
