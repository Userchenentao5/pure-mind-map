import { hasMindMapFrontmatter } from "../parser/markdownParser";
import { MINDMAP_VIEW_TYPE, type SplitLayout } from "../settings/types";

export type ObsidianSplitDirection = "vertical" | "horizontal";
export type SessionTimerHandle = ReturnType<typeof setTimeout> | number;

export interface LeafRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface LeafSnapshot {
	kind: "mindmap" | "markdown" | "other";
	filePath: string | null;
	rawMarkdown?: string | null;
}

export type ViewStateTarget =
	| { type: "markdown"; filePath: string; mode: "source" }
	| { type: "mindmap"; filePath: string; active?: boolean };

export interface SplitState<TLeaf extends object> {
	isActive: boolean;
	layout: SplitLayout | null;
	counterpartLeaf: TLeaf | null;
}

export type FileMenuOpenAction<TLeaf extends object> =
	| { action: "open-source"; targetLeaf: TLeaf | null }
	| { action: "open-mindmap"; targetLeaf: TLeaf | null }
	| { action: "none" };

export interface ShortcutKeyLike {
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	key: string;
	code: string;
}

export interface WorkspaceSessionOptions {
	sourceToMindMapDelayMs?: number;
	mindMapToSourceDelayMs?: number;
}

export interface WorkspaceSessionAdapter<TLeaf extends object> {
	isAutoOpenEnabled(): boolean;
	isLayoutReady(): boolean;
	getDefaultSplitLayout(): SplitLayout;
	isMindMapPath(filePath: string): boolean;

	getAllLeaves(): TLeaf[];
	getActiveLeaf(): TLeaf | null;
	inspectLeaf(leaf: TLeaf): LeafSnapshot | null;
	getLeafRect(leaf: TLeaf): LeafRect | null;

	commitLeafEdit(leaf: TLeaf): void;
	readLeafMarkdown(leaf: TLeaf): string | null;
	applyMarkdownToMindMapLeaf(leaf: TLeaf, markdown: string): void;
	applyMarkdownToSourceLeaf(leaf: TLeaf, markdown: string): void;
	saveLeaf(leaf: TLeaf, onlyIfDirty?: boolean): Promise<void>;

	applyViewState(leaf: TLeaf, target: ViewStateTarget): Promise<void>;
	createSplitLeaf(originLeaf: TLeaf, direction: ObsidianSplitDirection): TLeaf;
	detachLeaf(leaf: TLeaf): void;
	focusLeaf(leaf: TLeaf): void;
	recenterMindMapLeaf(leaf: TLeaf): void;
	refreshUi(): void;

	scheduleTimer(fn: () => void, delayMs: number): SessionTimerHandle;
	cancelTimer(handle: SessionTimerHandle): void;
}

interface TrackedSplitSession<TLeaf extends object> {
	filePath: string;
	mindMapLeaf: TLeaf;
	sourceLeaf: TLeaf;
	layout: SplitLayout;
}

const DEFAULT_SOURCE_TO_MINDMAP_DELAY_MS = 250;
const DEFAULT_MINDMAP_TO_SOURCE_DELAY_MS = 150;

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
 * Maps unambiguous user-facing split layout names to Obsidian's SplitDirection:
 * - "left-right" -> "vertical" (vertical divider, new pane appears to the right)
 * - "top-bottom" -> "horizontal" (horizontal divider, new pane appears below)
 */
export function splitLayoutToObsidianDirection(
	layout: SplitLayout
): ObsidianSplitDirection {
	return layout === "top-bottom" ? "horizontal" : "vertical";
}

/**
 * Infers whether two open panes are arranged left-right or top-bottom
 * based on the relative positions of their bounding box centers.
 */
export function inferLayoutFromRects(
	rectA: LeafRect | null,
	rectB: LeafRect | null
): SplitLayout | null {
	if (!rectA || !rectB) return null;
	if (
		rectA.width <= 0 ||
		rectA.height <= 0 ||
		rectB.width <= 0 ||
		rectB.height <= 0
	) {
		return null;
	}
	const cxA = rectA.left + rectA.width / 2;
	const cyA = rectA.top + rectA.height / 2;
	const cxB = rectB.left + rectB.width / 2;
	const cyB = rectB.top + rectB.height / 2;
	const dx = Math.abs(cxA - cxB);
	const dy = Math.abs(cyA - cyB);
	if (dx < 1 && dy < 1) return null;
	return dx >= dy ? "left-right" : "top-bottom";
}

/**
 * Deep Workspace Session module uniting:
 * - Auto-open routing & per-tab View-Mode Overrides
 * - Split View pairing, layout switching (left-right / top-bottom), and teardown
 * - Debounced, echo-suppressed bidirectional live synchronization
 * - Unified commit -> flush -> save transaction ordering across view/focus/split transitions
 */
export class WorkspaceSession<TLeaf extends object> {
	private adapter: WorkspaceSessionAdapter<TLeaf>;
	private sourceToMindMapDelayMs: number;
	private mindMapToSourceDelayMs: number;

	// Routing & View-Mode Override state
	private overrides = new WeakMap<TLeaf, string>();

	// Split View session tracking
	private splitSessions = new Set<TrackedSplitSession<TLeaf>>();

	// Shared re-entrancy guard for view/split transitions
	private isMutating = false;

	// Focus tracking for commit + flush on pane switches
	private lastActiveLeaf: TLeaf | null = null;

	// Bidirectional live sync state
	private lastKnownMarkdown = new Map<string, string>();
	private suppressedSourceEcho = new Map<string, string>();
	private applyingToSource = new Set<string>();
	private pendingSourceTimers = new Map<string, SessionTimerHandle>();
	private pendingSourceMarkdown = new Map<string, string>();
	private pendingMindMapTimers = new Map<string, SessionTimerHandle>();

	constructor(
		adapter: WorkspaceSessionAdapter<TLeaf>,
		options?: WorkspaceSessionOptions
	) {
		this.adapter = adapter;
		this.sourceToMindMapDelayMs =
			options?.sourceToMindMapDelayMs ?? DEFAULT_SOURCE_TO_MINDMAP_DELAY_MS;
		this.mindMapToSourceDelayMs =
			options?.mindMapToSourceDelayMs ?? DEFAULT_MINDMAP_TO_SOURCE_DELAY_MS;
	}

	// -------------------------------------------------------------------------
	// View-Mode Routing & View-Mode Overrides
	// -------------------------------------------------------------------------

	public hasOverrideFor(leaf: TLeaf, filePath: string): boolean {
		return this.overrides.get(leaf) === filePath;
	}

	/**
	 * Decides the effective view type when a tab's view state is updated.
	 * Skips auto-open hijacking during initial workspace restoration (before layoutReady)
	 * and preserves deferred Split View Source Mode tabs paired with an open Mind Map pane.
	 */
	public resolveIncomingViewType(
		leaf: TLeaf,
		incomingType: string,
		filePath: string | null,
		incomingMode?: string | null
	): string {
		if (!this.adapter.isLayoutReady()) {
			return incomingType;
		}

		if (
			this.adapter.isAutoOpenEnabled() &&
			incomingType === "markdown" &&
			filePath
		) {
			const forcedPath = this.overrides.get(leaf);
			if (forcedPath && forcedPath !== filePath) {
				this.overrides.delete(leaf);
			}

			// Preserve Obsidian deferred Split View Source Mode tabs hydrated after layoutReady
			if (
				(incomingMode === "source" || incomingMode === "preview") &&
				this.hasOtherMindMapLeaf(leaf, filePath)
			) {
				this.overrides.set(leaf, filePath);
				return "markdown";
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

	private isMindMapNoteLeaf(leaf: TLeaf): boolean {
		const snap = this.adapter.inspectLeaf(leaf);
		if (!snap || !snap.filePath) return false;
		if (snap.kind === "mindmap") return true;
		if (snap.kind === "markdown") return this.isMarkdownMindMapLeaf(leaf);
		return false;
	}

	public canToggleViewMode(leaf: TLeaf): boolean {
		if (!this.isMindMapNoteLeaf(leaf)) return false;
		return !this.getSplitState(leaf).isActive;
	}

	public async toggleViewMode(leaf: TLeaf): Promise<boolean> {
		if (!this.canToggleViewMode(leaf)) return false;
		const snap = this.adapter.inspectLeaf(leaf);
		if (!snap || !snap.filePath) return false;

		if (snap.kind === "mindmap") {
			await this.openSourceMode(leaf, snap.filePath);
			return true;
		}

		if (snap.kind === "markdown" && this.isMarkdownMindMapLeaf(leaf)) {
			await this.openMindMap(leaf, snap.filePath);
			return true;
		}

		return false;
	}

	public async openSourceMode(
		leaf: TLeaf,
		filePath: string,
		options?: { focus?: boolean }
	): Promise<void> {
		if (!filePath || this.isMutating) return;
		const snap = this.adapter.inspectLeaf(leaf);
		if (
			snap?.kind === "mindmap" &&
			snap.filePath === filePath &&
			this.getSplitState(leaf).isActive
		) {
			return;
		}
		this.isMutating = true;
		try {
			await this.prepareLeavesForTransition(filePath, [leaf]);
			this.overrides.set(leaf, filePath);
			await this.adapter.applyViewState(leaf, {
				type: "markdown",
				filePath,
				mode: "source",
			});
			if (options?.focus) {
				this.adapter.focusLeaf(leaf);
			}
			this.pruneStaleSplitSessions();
			this.adapter.refreshUi();
		} finally {
			this.isMutating = false;
		}
	}

	public async openMindMap(
		leaf: TLeaf,
		filePath: string,
		options?: { focus?: boolean }
	): Promise<void> {
		if (!filePath || this.isMutating) return;
		const snap = this.adapter.inspectLeaf(leaf);
		if (
			snap?.kind === "markdown" &&
			snap.filePath === filePath &&
			this.getSplitState(leaf).isActive
		) {
			return;
		}
		this.isMutating = true;
		try {
			if (snap && (snap.kind === "mindmap" || snap.kind === "markdown") && snap.filePath) {
				await this.prepareLeavesForTransition(snap.filePath, [leaf]);
			}
			this.overrides.delete(leaf);
			await this.adapter.applyViewState(leaf, {
				type: "mindmap",
				filePath,
				active: options?.focus,
			});
			if (options?.focus) {
				this.adapter.focusLeaf(leaf);
			}
			this.pruneStaleSplitSessions();
			this.adapter.refreshUi();
		} finally {
			this.isMutating = false;
		}
	}

	/**
	 * Runs on workspace layout ready: converts standalone Mind Map Notes to Mind Map view
	 * when auto-open is enabled, while preserving restored Split Views by installing
	 * View-Mode Overrides on Source Mode panes paired with an open Mind Map pane.
	 */
	public async restoreOnLayoutReady(): Promise<void> {
		if (!this.adapter.isAutoOpenEnabled()) {
			this.adapter.refreshUi();
			return;
		}

		const allLeaves = this.adapter.getAllLeaves();
		const openMindMapPaths = new Set<string>();
		for (const leaf of allLeaves) {
			const snap = this.adapter.inspectLeaf(leaf);
			if (snap?.kind === "mindmap" && snap.filePath) {
				openMindMapPaths.add(snap.filePath);
			}
		}

		const leavesToConvert: Array<{ leaf: TLeaf; filePath: string }> = [];
		for (const leaf of allLeaves) {
			const snap = this.adapter.inspectLeaf(leaf);
			if (!snap || snap.kind !== "markdown" || !snap.filePath) continue;
			if (this.overrides.get(leaf) === snap.filePath) continue;

			if (openMindMapPaths.has(snap.filePath)) {
				this.overrides.set(leaf, snap.filePath);
				continue;
			}
			if (!this.isMarkdownMindMapLeaf(leaf)) continue;
			leavesToConvert.push({ leaf, filePath: snap.filePath });
		}

		for (const { leaf, filePath } of leavesToConvert) {
			await this.openMindMap(leaf, filePath);
		}

		this.pruneStaleSplitSessions();
		this.adapter.refreshUi();
	}

	// -------------------------------------------------------------------------
	// Split View Lifecycle
	// -------------------------------------------------------------------------

	public canSplit(leaf: TLeaf): boolean {
		return this.isMindMapNoteLeaf(leaf);
	}

	/**
	 * Decides the context-aware File Explorer menu action for a Markdown file:
	 * - Already in Split View -> none (single-pane switching is locked)
	 * - Open in Mind Map only -> open in Source Mode
	 * - Open in Source Mode only -> open in Mind Map
	 * - Not open: Mind Map Note with auto-open enabled -> open in Source Mode; otherwise open in Mind Map
	 */
	public getFileMenuOpenAction(filePath: string): FileMenuOpenAction<TLeaf> {
		if (!filePath) return { action: "none" };

		const mindMapLeaves = this.findLeavesByKind(filePath, "mindmap");
		const markdownLeaves = this.findLeavesByKind(filePath, "markdown");

		if (mindMapLeaves.length > 0 && markdownLeaves.length > 0) {
			return { action: "none" };
		}
		if (mindMapLeaves.length > 0) {
			return { action: "open-source", targetLeaf: mindMapLeaves[0] };
		}
		if (markdownLeaves.length > 0) {
			return { action: "open-mindmap", targetLeaf: markdownLeaves[0] };
		}
		if (
			this.adapter.isAutoOpenEnabled() &&
			this.adapter.isMindMapPath(filePath)
		) {
			return { action: "open-source", targetLeaf: null };
		}
		return { action: "open-mindmap", targetLeaf: null };
	}

	public getSplitState(leaf: TLeaf): SplitState<TLeaf> {
		const snap = this.adapter.inspectLeaf(leaf);
		if (!snap || !snap.filePath) {
			return { isActive: false, layout: null, counterpartLeaf: null };
		}
		if (
			snap.kind !== "mindmap" &&
			!(snap.kind === "markdown" && this.isMarkdownMindMapLeaf(leaf))
		) {
			return { isActive: false, layout: null, counterpartLeaf: null };
		}

		const allLeaves = new Set(this.adapter.getAllLeaves());
		if (!allLeaves.has(leaf)) {
			return { isActive: false, layout: null, counterpartLeaf: null };
		}

		const expectedCounterpartKind: "mindmap" | "markdown" =
			snap.kind === "mindmap" ? "markdown" : "mindmap";

		// 1. Check tracked Split View sessions first
		for (const session of this.splitSessions) {
			if (session.filePath !== snap.filePath) continue;
			const isMindMapSide =
				snap.kind === "mindmap" && session.mindMapLeaf === leaf;
			const isSourceSide =
				snap.kind === "markdown" && session.sourceLeaf === leaf;
			if (!isMindMapSide && !isSourceSide) continue;

			const counterpart = isMindMapSide
				? session.sourceLeaf
				: session.mindMapLeaf;
			if (!allLeaves.has(counterpart)) continue;

			const counterpartSnap = this.adapter.inspectLeaf(counterpart);
			if (
				counterpartSnap?.kind === expectedCounterpartKind &&
				counterpartSnap.filePath === snap.filePath
			) {
				const inferred = inferLayoutFromRects(
					this.adapter.getLeafRect(leaf),
					this.adapter.getLeafRect(counterpart)
				);
				if (inferred) {
					session.layout = inferred;
				}
				return {
					isActive: true,
					layout: session.layout,
					counterpartLeaf: counterpart,
				};
			}
		}

		// 2. Fallback: detect manually opened counterpart leaf for the same file
		for (const candidate of allLeaves) {
			if (candidate === leaf) continue;
			const candidateSnap = this.adapter.inspectLeaf(candidate);
			if (
				candidateSnap?.kind === expectedCounterpartKind &&
				candidateSnap.filePath === snap.filePath
			) {
				const inferred =
					inferLayoutFromRects(
						this.adapter.getLeafRect(leaf),
						this.adapter.getLeafRect(candidate)
					) ?? "left-right";
				return {
					isActive: true,
					layout: inferred,
					counterpartLeaf: candidate,
				};
			}
		}

		return { isActive: false, layout: null, counterpartLeaf: null };
	}

	public async openOrSwitchSplit(
		originLeaf: TLeaf,
		targetLayout: SplitLayout
	): Promise<boolean> {
		if (this.isMutating) return false;
		const snap = this.adapter.inspectLeaf(originLeaf);
		if (!snap || !snap.filePath) return false;
		if (
			snap.kind !== "mindmap" &&
			!(snap.kind === "markdown" && this.isMarkdownMindMapLeaf(originLeaf))
		) {
			return false;
		}

		const filePath = snap.filePath;
		const originKind: "mindmap" | "markdown" = snap.kind;
		const oppositeKind: "mindmap" | "markdown" =
			originKind === "mindmap" ? "markdown" : "mindmap";

		this.isMutating = true;
		try {
			const current = this.getSplitState(originLeaf);

			if (
				current.isActive &&
				current.counterpartLeaf &&
				current.layout === targetLayout
			) {
				this.trackSplitSession(
					originLeaf,
					current.counterpartLeaf,
					originKind,
					filePath,
					targetLayout
				);
				this.adapter.refreshUi();
				return true;
			}

			const involvedLeaves = current.counterpartLeaf
				? [originLeaf, current.counterpartLeaf]
				: [originLeaf];
			await this.prepareLeavesForTransition(filePath, involvedLeaves);

			if (current.isActive && current.counterpartLeaf) {
				this.removeSplitSessionsForLeaf(current.counterpartLeaf);
				this.adapter.detachLeaf(current.counterpartLeaf);
			}

			const direction = splitLayoutToObsidianDirection(targetLayout);
			const newLeaf = this.adapter.createSplitLeaf(originLeaf, direction);

			if (oppositeKind === "markdown") {
				this.overrides.set(newLeaf, filePath);
				await this.adapter.applyViewState(newLeaf, {
					type: "markdown",
					filePath,
					mode: "source",
				});
			} else {
				this.overrides.delete(newLeaf);
				await this.adapter.applyViewState(newLeaf, {
					type: "mindmap",
					filePath,
				});
			}

			this.trackSplitSession(
				originLeaf,
				newLeaf,
				originKind,
				filePath,
				targetLayout
			);
			this.adapter.focusLeaf(originLeaf);
			this.recenterMindMapsForFile(filePath);
			this.adapter.refreshUi();
			return true;
		} finally {
			this.isMutating = false;
		}
	}

	public async toggleSplitLayout(
		originLeaf: TLeaf,
		targetLayout: SplitLayout
	): Promise<boolean> {
		const current = this.getSplitState(originLeaf);
		if (current.isActive && current.layout === targetLayout) {
			return this.closeSplit(originLeaf);
		}
		return this.openOrSwitchSplit(originLeaf, targetLayout);
	}

	public async toggleSplit(originLeaf: TLeaf): Promise<boolean> {
		const current = this.getSplitState(originLeaf);
		if (current.isActive) {
			return this.closeSplit(originLeaf);
		}
		return this.openOrSwitchSplit(
			originLeaf,
			this.adapter.getDefaultSplitLayout()
		);
	}

	public async flipSplitLayout(originLeaf: TLeaf): Promise<boolean> {
		const current = this.getSplitState(originLeaf);
		if (!current.isActive) {
			return this.openOrSwitchSplit(
				originLeaf,
				this.adapter.getDefaultSplitLayout()
			);
		}
		const nextLayout: SplitLayout =
			current.layout === "left-right" ? "top-bottom" : "left-right";
		return this.openOrSwitchSplit(originLeaf, nextLayout);
	}

	public async swapSplitPositions(originLeaf: TLeaf): Promise<boolean> {
		if (this.isMutating) return false;
		const snap = this.adapter.inspectLeaf(originLeaf);
		if (!snap || !snap.filePath) return false;
		if (snap.kind !== "mindmap" && snap.kind !== "markdown") return false;

		const current = this.getSplitState(originLeaf);
		if (!current.isActive || !current.counterpartLeaf) return false;

		const filePath = snap.filePath;
		const originKind: "mindmap" | "markdown" = snap.kind;
		const oldMindMapLeaf =
			originKind === "mindmap" ? originLeaf : current.counterpartLeaf;
		const oldSourceLeaf =
			originKind === "markdown" ? originLeaf : current.counterpartLeaf;
		const layout = current.layout ?? this.adapter.getDefaultSplitLayout();

		this.isMutating = true;
		try {
			await this.prepareLeavesForTransition(filePath, [
				oldMindMapLeaf,
				oldSourceLeaf,
			]);

			// Swap View-Mode Overrides before applying view states so auto-open
			// never hijacks the newly assigned Source Mode pane.
			this.overrides.set(oldMindMapLeaf, filePath);
			this.overrides.delete(oldSourceLeaf);

			await this.adapter.applyViewState(oldMindMapLeaf, {
				type: "markdown",
				filePath,
				mode: "source",
			});
			await this.adapter.applyViewState(oldSourceLeaf, {
				type: "mindmap",
				filePath,
			});

			this.trackSplitSession(
				oldSourceLeaf,
				oldMindMapLeaf,
				"mindmap",
				filePath,
				layout
			);
			const nextFocusLeaf =
				originKind === "mindmap" ? oldSourceLeaf : oldMindMapLeaf;
			this.adapter.focusLeaf(nextFocusLeaf);
			this.recenterMindMapsForFile(filePath);
			this.adapter.refreshUi();
			return true;
		} finally {
			this.isMutating = false;
		}
	}

	public async closeSplit(originLeaf: TLeaf): Promise<boolean> {
		if (this.isMutating) return false;
		const snap = this.adapter.inspectLeaf(originLeaf);
		if (!snap || !snap.filePath) return false;
		if (snap.kind !== "mindmap" && snap.kind !== "markdown") return false;

		const current = this.getSplitState(originLeaf);
		if (!current.isActive || !current.counterpartLeaf) return false;

		const filePath = snap.filePath;

		this.isMutating = true;
		try {
			await this.prepareLeavesForTransition(filePath, [
				originLeaf,
				current.counterpartLeaf,
			]);
			this.removeSplitSessionsForLeaf(current.counterpartLeaf);
			this.removeSplitSessionsForLeaf(originLeaf);
			this.adapter.detachLeaf(current.counterpartLeaf);
			this.adapter.focusLeaf(originLeaf);
			this.recenterMindMapsForFile(filePath);
			this.adapter.refreshUi();
			return true;
		} finally {
			this.isMutating = false;
		}
	}

	// -------------------------------------------------------------------------
	// Bidirectional Live Synchronization & Workspace Events
	// -------------------------------------------------------------------------

	public recordSyncedMarkdown(filePath: string, markdown: string): void {
		if (!filePath) return;
		this.lastKnownMarkdown.set(filePath, markdown);
	}

	public onSourceEditorChange(filePath: string, markdown: string): void {
		if (!filePath) return;
		if (this.findLeavesByKind(filePath, "mindmap").length === 0) return;

		if (this.applyingToSource.has(filePath)) return;
		if (this.suppressedSourceEcho.get(filePath) === markdown) return;

		this.suppressedSourceEcho.delete(filePath);
		this.cancelMindMapTimer(filePath);

		this.pendingSourceMarkdown.set(filePath, markdown);
		this.cancelSourceTimer(filePath);

		const timer = this.adapter.scheduleTimer(() => {
			this.pendingSourceTimers.delete(filePath);
			this.commitSourceToMindMap(filePath);
		}, this.sourceToMindMapDelayMs);
		this.pendingSourceTimers.set(filePath, timer);
	}

	public onMindMapChange(filePath: string): void {
		if (!filePath) return;
		if (this.findLeavesByKind(filePath, "markdown").length === 0) return;

		this.cancelSourceTimer(filePath);
		this.pendingSourceMarkdown.delete(filePath);
		this.cancelMindMapTimer(filePath);

		const timer = this.adapter.scheduleTimer(() => {
			this.pendingMindMapTimers.delete(filePath);
			void this.commitMindMapToSource(filePath);
		}, this.mindMapToSourceDelayMs);
		this.pendingMindMapTimers.set(filePath, timer);
	}

	public flushSourceToMindMap(filePath: string): boolean {
		if (!filePath || !this.pendingSourceMarkdown.has(filePath)) {
			return false;
		}
		this.cancelSourceTimer(filePath);
		return this.commitSourceToMindMap(filePath);
	}

	public async flushMindMapToSource(filePath: string): Promise<boolean> {
		if (!filePath || !this.pendingMindMapTimers.has(filePath)) {
			return false;
		}
		this.cancelMindMapTimer(filePath);
		return this.commitMindMapToSource(filePath);
	}

	public onActiveLeafChange(leaf: TLeaf | null): void {
		const prev = this.lastActiveLeaf;
		this.lastActiveLeaf = leaf;

		if (prev && prev !== leaf) {
			const prevSnap = this.adapter.inspectLeaf(prev);
			if (prevSnap?.kind === "mindmap") {
				this.adapter.commitLeafEdit(prev);
				if (prevSnap.filePath) {
					void this.flushMindMapToSource(prevSnap.filePath);
				}
			}
		}

		if (leaf) {
			const nextSnap = this.adapter.inspectLeaf(leaf);
			if (nextSnap?.kind === "mindmap" && nextSnap.filePath) {
				this.flushSourceToMindMap(nextSnap.filePath);
			}
		}

		this.adapter.refreshUi();
	}

	public onLayoutChange(): void {
		this.pruneStaleSplitSessions();
		this.adapter.refreshUi();
	}

	public dispose(): void {
		for (const timer of this.pendingSourceTimers.values()) {
			this.adapter.cancelTimer(timer);
		}
		for (const timer of this.pendingMindMapTimers.values()) {
			this.adapter.cancelTimer(timer);
		}
		this.pendingSourceTimers.clear();
		this.pendingMindMapTimers.clear();
		this.pendingSourceMarkdown.clear();
		this.lastKnownMarkdown.clear();
		this.suppressedSourceEcho.clear();
		this.applyingToSource.clear();
		this.splitSessions.clear();
		this.lastActiveLeaf = null;
	}

	// -------------------------------------------------------------------------
	// Internal Implementation
	// -------------------------------------------------------------------------

	/**
	 * Unified commit -> flush -> save transaction used before every view switch,
	 * split open, split layout change, or split close.
	 */
	private async prepareLeavesForTransition(
		filePath: string,
		leaves: TLeaf[]
	): Promise<void> {
		// 1. Commit any active Node Inline Editor first so newly typed text enters the sync pipeline
		for (const leaf of leaves) {
			const snap = this.adapter.inspectLeaf(leaf);
			if (snap?.kind === "mindmap") {
				this.adapter.commitLeafEdit(leaf);
			}
		}

		// 2. Flush any pending bidirectional live sync for this file
		this.flushSourceToMindMap(filePath);
		await this.flushMindMapToSource(filePath);

		// 3. Persist any remaining dirty state on the involved leaves
		for (const leaf of leaves) {
			const snap = this.adapter.inspectLeaf(leaf);
			if (snap && (snap.kind === "mindmap" || snap.kind === "markdown")) {
				await this.adapter.saveLeaf(leaf, true);
			}
		}
	}

	private commitSourceToMindMap(filePath: string): boolean {
		const markdown = this.pendingSourceMarkdown.get(filePath);
		this.pendingSourceMarkdown.delete(filePath);
		if (markdown === undefined) return false;

		const mindMapLeaves = this.findLeavesByKind(filePath, "mindmap");
		if (mindMapLeaves.length === 0) return false;
		if (this.lastKnownMarkdown.get(filePath) === markdown) return false;

		this.lastKnownMarkdown.set(filePath, markdown);
		for (const leaf of mindMapLeaves) {
			this.adapter.applyMarkdownToMindMapLeaf(leaf, markdown);
		}
		return true;
	}

	private async commitMindMapToSource(filePath: string): Promise<boolean> {
		const sourceLeaves = this.findLeavesByKind(filePath, "markdown");
		if (sourceLeaves.length === 0) return false;

		const primaryMindMapLeaf = this.findPrimaryMindMapLeaf(filePath);
		if (!primaryMindMapLeaf) return false;

		const markdown = this.adapter.readLeafMarkdown(primaryMindMapLeaf);
		if (markdown === null) return false;
		if (this.lastKnownMarkdown.get(filePath) === markdown) return false;

		this.lastKnownMarkdown.set(filePath, markdown);
		this.suppressedSourceEcho.set(filePath, markdown);
		this.applyingToSource.add(filePath);
		try {
			for (const sourceLeaf of sourceLeaves) {
				this.adapter.applyMarkdownToSourceLeaf(sourceLeaf, markdown);
			}
			await this.adapter.saveLeaf(primaryMindMapLeaf, false);
		} finally {
			this.applyingToSource.delete(filePath);
		}
		return true;
	}

	private findLeavesByKind(
		filePath: string,
		kind: "mindmap" | "markdown"
	): TLeaf[] {
		const matches: TLeaf[] = [];
		for (const leaf of this.adapter.getAllLeaves()) {
			const snap = this.adapter.inspectLeaf(leaf);
			if (snap?.kind === kind && snap.filePath === filePath) {
				matches.push(leaf);
			}
		}
		return matches;
	}

	private hasOtherMindMapLeaf(leaf: TLeaf, filePath: string): boolean {
		for (const candidate of this.adapter.getAllLeaves()) {
			if (candidate === leaf) continue;
			const snap = this.adapter.inspectLeaf(candidate);
			if (snap?.kind === "mindmap" && snap.filePath === filePath) {
				return true;
			}
		}
		return false;
	}

	private findPrimaryMindMapLeaf(filePath: string): TLeaf | null {
		const active = this.adapter.getActiveLeaf();
		if (active) {
			const activeSnap = this.adapter.inspectLeaf(active);
			if (activeSnap?.kind === "mindmap" && activeSnap.filePath === filePath) {
				return active;
			}
		}
		return this.findLeavesByKind(filePath, "mindmap")[0] ?? null;
	}

	private recenterMindMapsForFile(filePath: string): void {
		for (const leaf of this.findLeavesByKind(filePath, "mindmap")) {
			this.adapter.recenterMindMapLeaf(leaf);
		}
	}

	private pruneStaleSplitSessions(): void {
		const allLeaves = new Set(this.adapter.getAllLeaves());
		for (const session of Array.from(this.splitSessions)) {
			if (
				!allLeaves.has(session.mindMapLeaf) ||
				!allLeaves.has(session.sourceLeaf)
			) {
				this.splitSessions.delete(session);
				continue;
			}
			const mindSnap = this.adapter.inspectLeaf(session.mindMapLeaf);
			const sourceSnap = this.adapter.inspectLeaf(session.sourceLeaf);
			if (
				mindSnap?.kind !== "mindmap" ||
				sourceSnap?.kind !== "markdown" ||
				mindSnap.filePath !== session.filePath ||
				sourceSnap.filePath !== session.filePath
			) {
				this.splitSessions.delete(session);
			}
		}
	}

	private trackSplitSession(
		originLeaf: TLeaf,
		counterpartLeaf: TLeaf,
		originKind: "mindmap" | "markdown",
		filePath: string,
		layout: SplitLayout
	): void {
		this.removeSplitSessionsForLeaf(originLeaf);
		this.removeSplitSessionsForLeaf(counterpartLeaf);
		this.splitSessions.add({
			filePath,
			mindMapLeaf: originKind === "mindmap" ? originLeaf : counterpartLeaf,
			sourceLeaf: originKind === "markdown" ? originLeaf : counterpartLeaf,
			layout,
		});
	}

	private removeSplitSessionsForLeaf(leaf: TLeaf): void {
		for (const session of Array.from(this.splitSessions)) {
			if (session.mindMapLeaf === leaf || session.sourceLeaf === leaf) {
				this.splitSessions.delete(session);
			}
		}
	}

	private cancelSourceTimer(filePath: string): void {
		const existing = this.pendingSourceTimers.get(filePath);
		if (existing !== undefined) {
			this.adapter.cancelTimer(existing);
			this.pendingSourceTimers.delete(filePath);
		}
	}

	private cancelMindMapTimer(filePath: string): void {
		const existing = this.pendingMindMapTimers.get(filePath);
		if (existing !== undefined) {
			this.adapter.cancelTimer(existing);
			this.pendingMindMapTimers.delete(filePath);
		}
	}
}
