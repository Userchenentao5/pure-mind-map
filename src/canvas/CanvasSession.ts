import type { NodeObj } from "mind-elixir";
import { resolveNodeByPathKey } from "../parser/MindMapDocument";
import {
	findMatchingNodes,
	stepSearchMatchIndex,
	type NodeSearchMatch,
} from "./nodeSearch";

export type CanvasSyncReason =
	| "mount"
	| "external-refresh"
	| "selection"
	| "unselect"
	| "operation"
	| "link"
	| "style"
	| "direction"
	| "root-collapse";

export interface SearchCounterState {
	hasQuery: boolean;
	total: number;
	activeIndex: number;
	text: string;
	isEmpty: boolean;
}

export interface CanvasSessionAdapter {
	getRootNodeData(): NodeObj | null;
	applyRootCollapsedDom(collapsed: boolean): void;
	expandAncestorSilently(ancestorId: string): void;
	selectAndScrollToNode(nodeId: string): void;

	applySearchHighlights(matchNodeIds: readonly string[], activeNodeId: string): void;
	clearSearchHighlights(): void;
	updateSearchCounter(state: SearchCounterState): void;

	syncCollapseBadges(): void;
	syncNoteBadges(): void;
	notifyExternalNoteRefresh(): void;
	notifyNoteSelectionChanged(): void;
	updateQuickAddAndRootHandles(): void;
	updateNoteToolbarButton(): void;
	scheduleMinimapRender(): void;
	notifySelectionForSplitSync(): void;
}

/**
 * Deep Canvas Session module uniting MindElixir runtime state and coordination:
 * - Internal-refresh & external-selection echo guards
 * - Root-collapse state and automatic expansion on reveal / search / addChild
 * - Unified silent-ancestor-expand + select + scroll reveal routine
 * - Node search state machine (query, match cycling, highlights, counter)
 * - Single authoritative post-event overlay synchronization pipeline
 */
export class CanvasSession {
	private adapter: CanvasSessionAdapter;
	private internalRefreshDepth = 0;
	private externalSelectionDepth = 0;
	private rootCollapsed = false;

	private searchQuery = "";
	private searchMatches: NodeSearchMatch[] = [];
	private searchActiveIndex = -1;

	constructor(adapter: CanvasSessionAdapter) {
		this.adapter = adapter;
	}

	public isInternalRefresh(): boolean {
		return this.internalRefreshDepth > 0;
	}

	public isExternalSelectionSync(): boolean {
		return this.externalSelectionDepth > 0;
	}

	public isRootCollapsed(): boolean {
		return this.rootCollapsed;
	}

	public canProcessCanvasMutation(): boolean {
		return this.internalRefreshDepth === 0;
	}

	public canEmitSelectionSync(): boolean {
		return this.internalRefreshDepth === 0 && this.externalSelectionDepth === 0;
	}

	public runInternalRefresh(fn: () => void): void {
		this.internalRefreshDepth++;
		try {
			fn();
		} finally {
			this.internalRefreshDepth--;
		}
	}

	public reset(): void {
		this.rootCollapsed = false;
		this.searchQuery = "";
		this.searchMatches = [];
		this.searchActiveIndex = -1;
		this.adapter.clearSearchHighlights();
	}

	public setRootCollapsed(collapsed: boolean): void {
		if (this.rootCollapsed === collapsed) return;
		this.rootCollapsed = collapsed;
		this.adapter.applyRootCollapsedDom(collapsed);
		this.syncCanvas("root-collapse");
	}

	public toggleRootCollapsed(): void {
		this.setRootCollapsed(!this.rootCollapsed);
	}

	public ensureRootExpanded(): void {
		if (this.rootCollapsed) {
			this.setRootCollapsed(false);
		}
	}

	/**
	 * Single authoritative post-event synchronization matrix replacing 8 scattered
	 * subsets across MindMapView listeners so overlays, notes, and minimap never drift.
	 */
	public syncCanvas(reason: CanvasSyncReason): void {
		switch (reason) {
			case "mount":
			case "link":
			case "style":
				this.adapter.syncCollapseBadges();
				this.adapter.syncNoteBadges();
				this.adapter.updateQuickAddAndRootHandles();
				this.adapter.updateNoteToolbarButton();
				this.adapter.scheduleMinimapRender();
				break;
			case "external-refresh":
				this.adapter.syncCollapseBadges();
				this.adapter.notifyExternalNoteRefresh();
				this.adapter.updateQuickAddAndRootHandles();
				this.adapter.updateNoteToolbarButton();
				this.adapter.scheduleMinimapRender();
				break;
			case "operation":
				this.adapter.syncCollapseBadges();
				this.adapter.syncNoteBadges();
				this.adapter.updateQuickAddAndRootHandles();
				this.adapter.updateNoteToolbarButton();
				this.adapter.scheduleMinimapRender();
				break;
			case "selection":
				this.adapter.updateQuickAddAndRootHandles();
				this.adapter.notifyNoteSelectionChanged();
				this.adapter.updateNoteToolbarButton();
				this.adapter.scheduleMinimapRender();
				if (this.canEmitSelectionSync()) {
					this.adapter.notifySelectionForSplitSync();
				}
				break;
			case "unselect":
				this.adapter.updateQuickAddAndRootHandles();
				this.adapter.updateNoteToolbarButton();
				this.adapter.scheduleMinimapRender();
				break;
			case "direction":
				this.adapter.updateQuickAddAndRootHandles();
				this.adapter.scheduleMinimapRender();
				break;
			case "root-collapse":
				this.adapter.syncCollapseBadges();
				this.adapter.updateQuickAddAndRootHandles();
				this.adapter.scheduleMinimapRender();
				break;
		}
	}

	/**
	 * Reveals and selects a Node by tree pathKey (used by Split View Source -> MindMap
	 * locate sync), silently expanding root and any collapsed ancestors without echo.
	 */
	public revealNodeByPathKey(pathKey: string): boolean {
		const root = this.adapter.getRootNodeData();
		if (!root || !pathKey) return false;
		const resolved = resolveNodeByPathKey(root, pathKey);
		if (!resolved) return false;

		this.externalSelectionDepth++;
		try {
			this.revealNodeWithAncestors(resolved.node.id, resolved.ancestorIds);
		} finally {
			this.externalSelectionDepth--;
		}
		this.syncCanvas("operation");
		return true;
	}

	public runSearch(query: string, jumpToFirst: boolean): void {
		this.searchQuery = query;
		this.adapter.clearSearchHighlights();
		const root = this.adapter.getRootNodeData();
		if (!root || !query.trim()) {
			this.searchMatches = [];
			this.searchActiveIndex = -1;
			this.emitSearchCounter();
			return;
		}

		this.searchMatches = findMatchingNodes(root, query);
		if (this.searchMatches.length === 0) {
			this.searchActiveIndex = -1;
			this.emitSearchCounter();
			return;
		}

		this.searchActiveIndex = jumpToFirst
			? 0
			: Math.max(
					0,
					Math.min(this.searchActiveIndex, this.searchMatches.length - 1)
				);
		this.focusActiveSearchMatch();
	}

	public stepSearch(delta: 1 | -1, queryOverride?: string): void {
		const query = queryOverride ?? this.searchQuery;
		if (!query.trim()) return;

		if (this.searchMatches.length === 0) {
			this.runSearch(query, true);
			return;
		}

		this.searchActiveIndex = stepSearchMatchIndex(
			this.searchActiveIndex,
			this.searchMatches.length,
			delta
		);
		this.focusActiveSearchMatch();
	}

	public clearSearch(): void {
		this.searchQuery = "";
		this.searchMatches = [];
		this.searchActiveIndex = -1;
		this.adapter.clearSearchHighlights();
	}

	private focusActiveSearchMatch(): void {
		const activeMatch =
			this.searchActiveIndex >= 0
				? this.searchMatches[this.searchActiveIndex]
				: undefined;
		if (!activeMatch) {
			this.emitSearchCounter();
			return;
		}

		this.revealNodeWithAncestors(activeMatch.nodeId, activeMatch.ancestorIds);
		this.adapter.applySearchHighlights(
			this.searchMatches.map((m) => m.nodeId),
			activeMatch.nodeId
		);
		this.emitSearchCounter();
	}

	private revealNodeWithAncestors(
		nodeId: string,
		ancestorIds: readonly string[]
	): void {
		if (this.rootCollapsed && ancestorIds.length > 0) {
			this.setRootCollapsed(false);
		}
		for (const ancestorId of ancestorIds) {
			this.adapter.expandAncestorSilently(ancestorId);
		}
		this.adapter.selectAndScrollToNode(nodeId);
	}

	private emitSearchCounter(): void {
		const hasQuery = this.searchQuery.trim().length > 0;
		if (!hasQuery) {
			this.adapter.updateSearchCounter({
				hasQuery: false,
				total: 0,
				activeIndex: -1,
				text: "",
				isEmpty: false,
			});
			return;
		}
		if (this.searchMatches.length === 0) {
			this.adapter.updateSearchCounter({
				hasQuery: true,
				total: 0,
				activeIndex: -1,
				text: "无匹配",
				isEmpty: true,
			});
			return;
		}
		this.adapter.updateSearchCounter({
			hasQuery: true,
			total: this.searchMatches.length,
			activeIndex: this.searchActiveIndex,
			text: `${this.searchActiveIndex + 1} / ${this.searchMatches.length}`,
			isEmpty: false,
		});
	}
}
