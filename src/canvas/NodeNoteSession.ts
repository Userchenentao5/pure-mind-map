import { normalizeNoteText } from "../parser/markdownParser";

export type NotePanelMode = "edit" | "preview";
export type NoteTimerHandle = ReturnType<typeof setTimeout> | number;

export interface NoteNodeSnapshot {
	id: string;
	topic: string;
	note: string;
}

export interface NodeNoteSessionOptions {
	saveDebounceMs?: number;
	hoverShowDelayMs?: number;
	hoverHideDelayMs?: number;
}

export interface NodeNoteAdapter {
	getNode(nodeId: string): NoteNodeSnapshot | null;
	getSelectedNodeId(): string | null;
	getFallbackRootNodeId(): string | null;
	selectNode(nodeId: string): void;
	writeNodeNote(nodeId: string, normalizedNote: string): void;

	showPanel(node: NoteNodeSnapshot, mode: NotePanelMode, focusEditor: boolean): void;
	hidePanel(restoreCanvasFocus: boolean): void;
	updatePanelHeader(node: NoteNodeSnapshot): void;
	applyPanelMode(mode: NotePanelMode, previewMarkdown: string): void;
	setEditorValue(value: string, clearHistory: boolean): void;
	getEditorValue(): string;
	isEditorFocused(): boolean;
	focusEditor(): void;
	updateClearButton(hasContent: boolean): void;
	onPanelStateChanged?(isOpen: boolean): void;

	showHoverPreview(node: NoteNodeSnapshot): void;
	hideHoverPreview(): void;

	scheduleTimer(fn: () => void, delayMs: number): NoteTimerHandle;
	cancelTimer(handle: NoteTimerHandle): void;
}

const DEFAULT_SAVE_DEBOUNCE_MS = 250;
const DEFAULT_HOVER_SHOW_DELAY_MS = 180;
const DEFAULT_HOVER_HIDE_DELAY_MS = 160;

/**
 * Deep Node Note Session module owning:
 * - Panel open/close/toggle lifecycle and edit/preview mode transitions
 * - Debounced auto-save, normalization deduplication, and Node-switch flush ordering
 * - External-refresh conflict reconciliation (preserving live focused edits)
 * - Hover-preview debounce timers and same-Node suppression
 */
export class NodeNoteSession {
	private adapter: NodeNoteAdapter;
	private saveDebounceMs: number;
	private hoverShowDelayMs: number;
	private hoverHideDelayMs: number;

	private activeNodeId: string | null = null;
	private panelMode: NotePanelMode = "edit";
	private panelOpen = false;
	private saveTimer: NoteTimerHandle | null = null;
	private lastSavedRaw: string | null = null;

	private hoveredNodeId: string | null = null;
	private hoverShowTimer: NoteTimerHandle | null = null;
	private hoverHideTimer: NoteTimerHandle | null = null;

	constructor(adapter: NodeNoteAdapter, options?: NodeNoteSessionOptions) {
		this.adapter = adapter;
		this.saveDebounceMs = options?.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
		this.hoverShowDelayMs =
			options?.hoverShowDelayMs ?? DEFAULT_HOVER_SHOW_DELAY_MS;
		this.hoverHideDelayMs =
			options?.hoverHideDelayMs ?? DEFAULT_HOVER_HIDE_DELAY_MS;
	}

	public isOpen(): boolean {
		return this.panelOpen;
	}

	public getActiveNodeId(): string | null {
		return this.activeNodeId;
	}

	public getMode(): NotePanelMode {
		return this.panelMode;
	}

	public openForSelectedNode(): void {
		const targetId =
			this.adapter.getSelectedNodeId() ?? this.adapter.getFallbackRootNodeId();
		if (!targetId) return;
		this.openForNode(targetId, "edit");
	}

	public toggleForSelectedNode(): void {
		const selectedId = this.adapter.getSelectedNodeId();
		if (this.panelOpen && selectedId && this.activeNodeId === selectedId) {
			this.close(true);
			return;
		}
		this.openForSelectedNode();
	}

	public openForNode(nodeId: string, mode: NotePanelMode = "edit"): void {
		const node = this.adapter.getNode(nodeId);
		if (!node) return;

		if (this.activeNodeId && this.activeNodeId !== nodeId) {
			this.flushPendingSave();
		}

		this.hideHoverPreview();
		this.activeNodeId = node.id;
		this.panelOpen = true;
		this.panelMode = mode;
		this.lastSavedRaw = normalizeNoteText(node.note);

		this.adapter.selectNode(node.id);
		this.adapter.setEditorValue(node.note, true);
		this.adapter.updatePanelHeader(node);
		this.adapter.updateClearButton(this.lastSavedRaw.length > 0);
		this.adapter.showPanel(node, mode, mode === "edit");
		this.adapter.applyPanelMode(mode, this.lastSavedRaw);
		this.adapter.onPanelStateChanged?.(true);
	}

	public close(restoreCanvasFocus = false): void {
		this.flushPendingSave();
		if (!this.panelOpen) return;
		this.panelOpen = false;
		this.activeNodeId = null;
		this.lastSavedRaw = null;
		this.adapter.hidePanel(restoreCanvasFocus);
		this.adapter.onPanelStateChanged?.(false);
	}

	public setMode(mode: NotePanelMode): void {
		if (!this.panelOpen) return;
		if (mode === "preview") {
			this.flushPendingSave();
		}
		this.panelMode = mode;
		const previewText = normalizeNoteText(this.adapter.getEditorValue());
		this.adapter.applyPanelMode(mode, previewText);
		if (mode === "edit") {
			this.adapter.focusEditor();
		}
	}

	public onEditorInput(value: string): void {
		if (!this.panelOpen || !this.activeNodeId) return;
		this.adapter.updateClearButton(normalizeNoteText(value).length > 0);
		this.cancelSaveTimer();
		this.saveTimer = this.adapter.scheduleTimer(() => {
			this.saveTimer = null;
			if (!this.activeNodeId) return;
			this.commitValue(this.activeNodeId, this.adapter.getEditorValue());
		}, this.saveDebounceMs);
	}

	public clearActiveNote(): void {
		if (!this.panelOpen || !this.activeNodeId) return;
		this.cancelSaveTimer();
		this.adapter.setEditorValue("", false);
		this.commitValue(this.activeNodeId, "");
		if (this.panelMode === "preview") {
			this.adapter.applyPanelMode("preview", "");
		} else {
			this.adapter.focusEditor();
		}
	}

	public flushPendingSave(): void {
		this.cancelSaveTimer();
		if (!this.panelOpen || !this.activeNodeId) return;
		this.commitValue(this.activeNodeId, this.adapter.getEditorValue());
	}

	public onCanvasSelectionChanged(selectedNodeId: string | null): void {
		if (!this.panelOpen || !selectedNodeId) return;
		const node = this.adapter.getNode(selectedNodeId);
		if (!node) return;

		if (node.id === this.activeNodeId) {
			this.adapter.updatePanelHeader(node);
			return;
		}

		this.flushPendingSave();
		this.activeNodeId = node.id;
		this.lastSavedRaw = normalizeNoteText(node.note);
		this.adapter.setEditorValue(node.note, true);
		this.adapter.updatePanelHeader(node);
		this.adapter.updateClearButton(this.lastSavedRaw.length > 0);
		this.adapter.applyPanelMode(this.panelMode, this.lastSavedRaw);
	}

	public onExternalRefresh(): void {
		if (!this.panelOpen || !this.activeNodeId) return;
		const node = this.adapter.getNode(this.activeNodeId);
		if (!node) {
			this.close(false);
			return;
		}

		if (!this.adapter.isEditorFocused()) {
			this.lastSavedRaw = normalizeNoteText(node.note);
			this.adapter.setEditorValue(node.note, true);
			this.adapter.updatePanelHeader(node);
			this.adapter.updateClearButton(this.lastSavedRaw.length > 0);
			if (this.panelMode === "preview") {
				this.adapter.applyPanelMode("preview", this.lastSavedRaw);
			}
		} else {
			this.adapter.updatePanelHeader(node);
		}
	}

	public onBadgeMouseEnter(nodeId: string): void {
		if (this.panelOpen && this.activeNodeId === nodeId) {
			return;
		}
		this.clearHoverTimers();
		this.hoverShowTimer = this.adapter.scheduleTimer(() => {
			this.hoverShowTimer = null;
			const node = this.adapter.getNode(nodeId);
			if (!node || normalizeNoteText(node.note).length === 0) return;
			this.hoveredNodeId = nodeId;
			this.adapter.showHoverPreview({
				...node,
				note: normalizeNoteText(node.note),
			});
		}, this.hoverShowDelayMs);
	}

	public onBadgeMouseLeave(): void {
		this.scheduleHideHoverPreview();
	}

	public onPreviewMouseEnter(): void {
		this.clearHoverHideTimer();
	}

	public onPreviewMouseLeave(): void {
		this.scheduleHideHoverPreview();
	}

	public openHoveredForEdit(): void {
		const id = this.hoveredNodeId;
		this.hideHoverPreview();
		if (id) {
			this.openForNode(id, "edit");
		}
	}

	public hideHoverPreview(): void {
		this.clearHoverTimers();
		if (this.hoveredNodeId !== null) {
			this.hoveredNodeId = null;
			this.adapter.hideHoverPreview();
		}
	}

	public dispose(): void {
		this.flushPendingSave();
		this.clearHoverTimers();
		this.hoveredNodeId = null;
		this.panelOpen = false;
		this.activeNodeId = null;
		this.lastSavedRaw = null;
	}

	private commitValue(nodeId: string, rawValue: string): void {
		const normalized = normalizeNoteText(rawValue);
		if (normalized === this.lastSavedRaw) return;
		if (!this.adapter.getNode(nodeId)) return;

		this.lastSavedRaw = normalized;
		this.adapter.updateClearButton(normalized.length > 0);
		this.adapter.writeNodeNote(nodeId, normalized);
	}

	private scheduleHideHoverPreview(): void {
		this.clearHoverShowTimer();
		this.clearHoverHideTimer();
		this.hoverHideTimer = this.adapter.scheduleTimer(() => {
			this.hoverHideTimer = null;
			this.hideHoverPreview();
		}, this.hoverHideDelayMs);
	}

	private cancelSaveTimer(): void {
		if (this.saveTimer !== null) {
			this.adapter.cancelTimer(this.saveTimer);
			this.saveTimer = null;
		}
	}

	private clearHoverShowTimer(): void {
		if (this.hoverShowTimer !== null) {
			this.adapter.cancelTimer(this.hoverShowTimer);
			this.hoverShowTimer = null;
		}
	}

	private clearHoverHideTimer(): void {
		if (this.hoverHideTimer !== null) {
			this.adapter.cancelTimer(this.hoverHideTimer);
			this.hoverHideTimer = null;
		}
	}

	private clearHoverTimers(): void {
		this.clearHoverShowTimer();
		this.clearHoverHideTimer();
	}
}
