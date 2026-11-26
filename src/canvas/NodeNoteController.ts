import {
	App,
	Component,
	MarkdownRenderer,
	setIcon,
} from "obsidian";
import type MindElixir from "mind-elixir";
import type { NodeObj, Topic } from "mind-elixir";
import { normalizeNoteText } from "../parser/markdownParser";
import { extractSearchableNodeText } from "./nodeSearch";
import { NoteMarkdownEditor } from "./NoteMarkdownEditor";

export interface NodeNoteHost {
	getMind: () => MindElixir | null;
	getSourcePath: () => string;
	onNoteChanged: () => void;
	onLayoutChanged: () => void;
	onPanelStateChanged?: (isOpen: boolean) => void;
}

const SAVE_DEBOUNCE_MS = 250;
const HOVER_SHOW_DELAY_MS = 180;
const HOVER_HIDE_DELAY_MS = 160;

/**
 * Manages per-node Markdown notes (sticky notes) inside MindMapView:
 * - Renders an inline sticky-note indicator badge on nodes that have notes
 * - Shows a native Obsidian Markdown hover preview popover over badges
 * - Provides a floating right-side editor/preview card with auto-save
 */
export class NodeNoteController {
	private app: App;
	private host: NodeNoteHost;
	private containerEl: HTMLElement | null = null;

	// Floating editor panel elements
	private panelEl: HTMLElement | null = null;
	private panelTitleEl: HTMLElement | null = null;
	private editModeBtnEl: HTMLButtonElement | null = null;
	private previewModeBtnEl: HTMLButtonElement | null = null;
	private clearBtnEl: HTMLButtonElement | null = null;
	private noteEditor: NoteMarkdownEditor | null = null;
	private panelPreviewEl: HTMLElement | null = null;

	// Hover preview popover elements
	private hoverEl: HTMLElement | null = null;
	private hoverTitleEl: HTMLElement | null = null;
	private hoverBodyEl: HTMLElement | null = null;

	// State
	private activeNodeId: string | null = null;
	private panelMode: "edit" | "preview" = "edit";
	private isPanelOpen = false;
	private saveTimer: number | null = null;
	private lastSavedRaw: string | null = null;

	private hoveredNodeId: string | null = null;
	private hoverShowTimer: number | null = null;
	private hoverHideTimer: number | null = null;

	private panelRenderComp: Component | null = null;
	private hoverRenderComp: Component | null = null;

	constructor(app: App, host: NodeNoteHost) {
		this.app = app;
		this.host = host;
	}

	public attach(container: HTMLElement): void {
		this.detach();
		this.containerEl = container;
		this.buildPanel(container);
		this.buildHoverPreview(container);
	}

	public detach(): void {
		this.flushPendingSave();
		this.clearHoverTimers();
		this.hideHoverPreview();
		this.unloadRenderComp("panel");
		this.unloadRenderComp("hover");
		if (this.noteEditor) {
			this.noteEditor.destroy();
			this.noteEditor = null;
		}
		if (this.panelEl) {
			this.panelEl.remove();
			this.panelEl = null;
		}
		if (this.hoverEl) {
			this.hoverEl.remove();
			this.hoverEl = null;
		}
		this.panelTitleEl = null;
		this.editModeBtnEl = null;
		this.previewModeBtnEl = null;
		this.clearBtnEl = null;
		this.panelPreviewEl = null;
		this.hoverTitleEl = null;
		this.hoverBodyEl = null;
		this.containerEl = null;
		this.activeNodeId = null;
		this.isPanelOpen = false;
	}

	public isOpen(): boolean {
		return this.isPanelOpen;
	}

	public openForSelectedNode(): void {
		const mind = this.host.getMind();
		if (!mind) return;
		const targetEl =
			mind.currentNode ??
			mind.nodes.querySelector<Topic>(".me-root > .me-tpc");
		if (!targetEl?.nodeObj) return;
		this.openForNode(targetEl.nodeObj.id, "edit");
	}

	public toggleForSelectedNode(): void {
		const mind = this.host.getMind();
		if (!mind) return;
		const selectedId = mind.currentNode?.nodeObj?.id ?? null;
		if (this.isPanelOpen && selectedId && this.activeNodeId === selectedId) {
			this.close(true);
			return;
		}
		this.openForSelectedNode();
	}

	public openForNode(
		nodeId: string,
		mode: "edit" | "preview" = "edit"
	): void {
		const mind = this.host.getMind();
		if (!mind || !this.panelEl || !this.noteEditor) return;

		const node = this.findNodeObjById(mind.nodeData, nodeId);
		if (!node) return;

		if (this.activeNodeId && this.activeNodeId !== nodeId) {
			this.flushPendingSave();
		}

		this.hideHoverPreview();
		this.activeNodeId = node.id;
		this.isPanelOpen = true;
		this.panelMode = mode;

		// Ensure the owning node is selected on canvas so the user clearly sees context
		try {
			const tpc = mind.findEle(node.id);
			if (tpc && mind.currentNode !== tpc) {
				mind.selectNode(tpc);
			}
		} catch {
			// Ignore if node is not currently mounted
		}

		this.populatePanelFromNode(node);
		this.panelEl.removeClass("mm-is-hidden");
		this.applyPanelMode();
		this.host.onPanelStateChanged?.(true);

		if (mode === "edit") {
			this.noteEditor.focusEnd();
		}
	}

	public close(restoreCanvasFocus = false): void {
		this.flushPendingSave();
		if (!this.isPanelOpen) return;
		this.isPanelOpen = false;
		this.activeNodeId = null;
		this.lastSavedRaw = null;
		this.panelEl?.addClass("mm-is-hidden");
		this.unloadRenderComp("panel");
		this.host.onPanelStateChanged?.(false);
		if (restoreCanvasFocus) {
			this.host.getMind()?.container?.focus();
		}
	}

	public onCanvasSelectionChanged(mind: MindElixir): void {
		if (!this.isPanelOpen) return;
		if (mind.currentNodes.length !== 1 || !mind.currentNode?.nodeObj) {
			return;
		}
		const nextNode = mind.currentNode.nodeObj;
		if (nextNode.id === this.activeNodeId) {
			this.updatePanelHeader(nextNode);
			return;
		}
		this.flushPendingSave();
		this.activeNodeId = nextNode.id;
		this.populatePanelFromNode(nextNode);
		this.applyPanelMode();
	}

	public onExternalRefresh(mind: MindElixir): void {
		this.syncBadges(mind);
		if (!this.isPanelOpen || !this.activeNodeId) return;
		const node = this.findNodeObjById(mind.nodeData, this.activeNodeId);
		if (!node) {
			this.close(false);
			return;
		}
		if (this.noteEditor && !this.noteEditor.isFocused()) {
			this.populatePanelFromNode(node);
			if (this.panelMode === "preview") {
				this.renderPanelPreview();
			}
		} else {
			this.updatePanelHeader(node);
		}
	}

	public syncBadges(mind: MindElixir): void {
		if (!mind.nodes?.isConnected) return;
		let layoutChanged = false;

		const topics = mind.nodes.querySelectorAll<Topic>(".me-tpc");
		topics.forEach((tpc) => {
			const nodeObj = tpc.nodeObj;
			if (!nodeObj) return;
			const hasNote = normalizeNoteText(nodeObj.note).length > 0;
			const existing = tpc.querySelector<HTMLElement>(".mm-node-note-badge");

			if (hasNote && !existing) {
				const badge = this.createBadgeElement(nodeObj.id);
				tpc.appendChild(badge);
				layoutChanged = true;
			} else if (!hasNote && existing) {
				existing.remove();
				layoutChanged = true;
			} else if (hasNote && existing) {
				existing.dataset.nodeId = nodeObj.id;
			}
		});

		if (layoutChanged) {
			this.host.onLayoutChanged();
		}
	}

	public flushPendingSave(): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.isPanelOpen || !this.activeNodeId || !this.noteEditor) return;
		this.commitNoteValue(this.activeNodeId, this.noteEditor.getValue());
	}

	private createBadgeElement(nodeId: string): HTMLElement {
		const badge = createSpan({
			cls: "mm-node-note-badge",
			attr: {
				role: "button",
				title: "查看/编辑备注",
			},
		});
		badge.dataset.nodeId = nodeId;
		setIcon(badge, "sticky-note");

		const stop = (evt: Event) => {
			evt.stopPropagation();
		};
		badge.addEventListener("pointerdown", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		badge.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		badge.addEventListener("dblclick", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		badge.addEventListener("click", (evt) => {
			evt.preventDefault();
			stop(evt);
			const id = badge.dataset.nodeId;
			if (id) {
				this.openForNode(id, "edit");
			}
		});
		badge.addEventListener("mouseenter", () => {
			const id = badge.dataset.nodeId;
			if (id) {
				this.scheduleShowHoverPreview(id, badge);
			}
		});
		badge.addEventListener("mouseleave", () => {
			this.scheduleHideHoverPreview();
		});
		return badge;
	}

	private buildPanel(container: HTMLElement): void {
		const panel = container.createDiv({ cls: "mm-note-panel mm-is-hidden" });

		const header = panel.createDiv({ cls: "mm-note-panel-header" });
		const titleWrap = header.createDiv({ cls: "mm-note-panel-title-wrap" });
		const titleIcon = titleWrap.createSpan({ cls: "mm-note-panel-icon" });
		setIcon(titleIcon, "sticky-note");
		const titleEl = titleWrap.createSpan({ cls: "mm-note-panel-title" });

		const actions = header.createDiv({ cls: "mm-note-panel-actions" });

		const editBtn = actions.createEl("button", {
			cls: "mm-note-panel-btn is-active",
			attr: {
				type: "button",
				title: "编辑备注",
				"aria-label": "编辑备注",
			},
		});
		setIcon(editBtn, "pencil");
		editBtn.addEventListener("click", () => {
			this.panelMode = "edit";
			this.applyPanelMode();
			this.noteEditor?.focusEnd();
		});

		const previewBtn = actions.createEl("button", {
			cls: "mm-note-panel-btn",
			attr: {
				type: "button",
				title: "阅读预览",
				"aria-label": "阅读预览",
			},
		});
		setIcon(previewBtn, "eye");
		previewBtn.addEventListener("click", () => {
			this.flushPendingSave();
			this.panelMode = "preview";
			this.applyPanelMode();
		});

		const clearBtn = actions.createEl("button", {
			cls: "mm-note-panel-btn mm-note-clear-btn",
			attr: {
				type: "button",
				title: "清空备注",
				"aria-label": "清空备注",
			},
		});
		setIcon(clearBtn, "trash-2");
		clearBtn.addEventListener("click", () => {
			if (!this.noteEditor || !this.activeNodeId) return;
			this.noteEditor.setValue("", false);
			this.commitNoteValue(this.activeNodeId, "");
			if (this.panelMode === "preview") {
				this.renderPanelPreview();
			} else {
				this.noteEditor.focusEnd();
			}
		});

		const closeBtn = actions.createEl("button", {
			cls: "mm-note-panel-btn",
			attr: {
				type: "button",
				title: "关闭备注面板 (Esc)",
				"aria-label": "关闭备注面板",
			},
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => {
			this.close(true);
		});

		const body = panel.createDiv({ cls: "mm-note-panel-body" });
		const noteEditor = new NoteMarkdownEditor({
			app: this.app,
			containerEl: body,
			placeholder:
				"在此输入节点备注（支持实时预览、标题、列表、代码块、[[双链]] 等）...",
			onChange: (value) => {
				this.updateClearButtonVisibility(value);
				this.scheduleSave();
			},
			onBlur: () => {
				this.flushPendingSave();
			},
			onEscape: () => {
				this.close(true);
			},
		});

		const preview = body.createDiv({
			cls: "mm-note-panel-preview markdown-rendered mm-is-hidden",
		});
		this.bindRenderedLinkClicks(preview);

		// Native Live Preview already renders Markdown inline while editing,
		// so hide the redundant Edit/Preview mode toggles unless running in textarea fallback.
		const isNative = noteEditor.isNativeLivePreview();
		editBtn.toggleClass("mm-is-hidden", isNative);
		previewBtn.toggleClass("mm-is-hidden", isNative);

		const footerText = isNative
			? "支持 Markdown 实时预览 · 以引用块 (>) 保存 · Esc 关闭"
			: "支持 Markdown · 以引用块 (>) 保存 · Esc 关闭";
		panel.createDiv({
			cls: "mm-note-panel-footer",
			text: footerText,
		});

		this.panelEl = panel;
		this.panelTitleEl = titleEl;
		this.editModeBtnEl = editBtn;
		this.previewModeBtnEl = previewBtn;
		this.clearBtnEl = clearBtn;
		this.noteEditor = noteEditor;
		this.panelPreviewEl = preview;
	}

	private buildHoverPreview(container: HTMLElement): void {
		const hover = container.createDiv({ cls: "mm-note-preview mm-is-hidden" });
		const stopProp = (evt: Event) => {
			evt.stopPropagation();
		};
		hover.addEventListener("pointerdown", stopProp);
		hover.addEventListener("mousedown", stopProp);
		hover.addEventListener("click", stopProp);
		hover.addEventListener("wheel", stopProp, { passive: true });
		hover.addEventListener("mouseenter", () => {
			this.clearHoverHideTimer();
		});
		hover.addEventListener("mouseleave", () => {
			this.scheduleHideHoverPreview();
		});

		const header = hover.createDiv({ cls: "mm-note-preview-header" });
		const titleEl = header.createSpan({ cls: "mm-note-preview-title" });
		const editBtn = header.createEl("button", {
			cls: "mm-note-panel-btn",
			attr: {
				type: "button",
				title: "编辑备注",
				"aria-label": "编辑备注",
			},
		});
		setIcon(editBtn, "pencil");
		editBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const id = this.hoveredNodeId;
			this.hideHoverPreview();
			if (id) {
				this.openForNode(id, "edit");
			}
		});

		const body = hover.createDiv({
			cls: "mm-note-preview-body markdown-rendered",
		});
		this.bindRenderedLinkClicks(body);

		this.hoverEl = hover;
		this.hoverTitleEl = titleEl;
		this.hoverBodyEl = body;
	}

	private bindRenderedLinkClicks(container: HTMLElement): void {
		container.addEventListener("click", (evt) => {
			const target = evt.target as HTMLElement | null;
			const link = target?.closest<HTMLAnchorElement>("a.internal-link");
			if (!link) return;
			evt.preventDefault();
			evt.stopPropagation();
			const href = link.dataset.href || link.getAttribute("href");
			if (href) {
				const openInNewTab = evt.ctrlKey || evt.metaKey;
				void this.app.workspace.openLinkText(
					href,
					this.host.getSourcePath(),
					openInNewTab
				);
			}
		});
	}

	private populatePanelFromNode(node: NodeObj): void {
		this.updatePanelHeader(node);
		const noteText = node.note ?? "";
		this.lastSavedRaw = normalizeNoteText(noteText);
		this.noteEditor?.setValue(noteText, true);
		this.updateClearButtonVisibility(noteText);
	}

	private updatePanelHeader(node: NodeObj): void {
		if (!this.panelTitleEl) return;
		const displayTopic =
			extractSearchableNodeText(node.topic || "未命名节点")
				.replace(/\s+/g, " ")
				.trim() || "未命名节点";
		this.panelTitleEl.setText(displayTopic);
		this.panelTitleEl.setAttribute("title", displayTopic);
	}

	private updateClearButtonVisibility(value: string): void {
		this.clearBtnEl?.toggleClass(
			"mm-is-hidden",
			normalizeNoteText(value).length === 0
		);
	}

	private applyPanelMode(): void {
		const isPreview = this.panelMode === "preview";
		this.editModeBtnEl?.toggleClass("is-active", !isPreview);
		this.previewModeBtnEl?.toggleClass("is-active", isPreview);
		this.noteEditor?.setVisible(!isPreview);
		this.panelPreviewEl?.toggleClass("mm-is-hidden", !isPreview);
		if (isPreview) {
			this.renderPanelPreview();
		}
	}

	private renderPanelPreview(): void {
		if (!this.panelPreviewEl) return;
		this.unloadRenderComp("panel");
		this.panelPreviewEl.empty();

		const text = normalizeNoteText(this.noteEditor?.getValue() ?? "");
		if (!text) {
			this.panelPreviewEl.createDiv({
				cls: "mm-note-empty-hint",
				text: "暂无备注内容",
			});
			return;
		}

		const comp = new Component();
		comp.load();
		this.panelRenderComp = comp;
		void MarkdownRenderer.render(
			this.app,
			text,
			this.panelPreviewEl,
			this.host.getSourcePath(),
			comp
		);
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			if (!this.activeNodeId || !this.noteEditor) return;
			this.commitNoteValue(this.activeNodeId, this.noteEditor.getValue());
		}, SAVE_DEBOUNCE_MS);
	}

	private commitNoteValue(nodeId: string, rawValue: string): void {
		const mind = this.host.getMind();
		if (!mind) return;
		const normalized = normalizeNoteText(rawValue);
		if (normalized === this.lastSavedRaw) return;

		const node = this.findNodeObjById(mind.nodeData, nodeId);
		if (!node) return;

		if (normalized) {
			node.note = normalized;
		} else {
			delete node.note;
		}

		// Sync live DOM node reference too in case mind.nodeData and Topic.nodeObj diverged
		try {
			const tpc = mind.findEle(nodeId);
			if (tpc?.nodeObj && tpc.nodeObj !== node) {
				if (normalized) {
					tpc.nodeObj.note = normalized;
				} else {
					delete tpc.nodeObj.note;
				}
			}
		} catch {
			// Ignore unmounted node
		}

		this.lastSavedRaw = normalized;
		this.updateClearButtonVisibility(normalized);
		this.syncBadges(mind);
		this.host.onNoteChanged();
	}

	private scheduleShowHoverPreview(
		nodeId: string,
		anchorEl: HTMLElement
	): void {
		if (this.isPanelOpen && this.activeNodeId === nodeId) {
			return;
		}
		this.clearHoverTimers();
		this.hoverShowTimer = window.setTimeout(() => {
			this.hoverShowTimer = null;
			this.showHoverPreview(nodeId, anchorEl);
		}, HOVER_SHOW_DELAY_MS);
	}

	private scheduleHideHoverPreview(): void {
		this.clearHoverShowTimer();
		this.clearHoverHideTimer();
		this.hoverHideTimer = window.setTimeout(() => {
			this.hoverHideTimer = null;
			this.hideHoverPreview();
		}, HOVER_HIDE_DELAY_MS);
	}

	private showHoverPreview(nodeId: string, anchorEl: HTMLElement): void {
		const mind = this.host.getMind();
		if (
			!mind ||
			!this.containerEl ||
			!this.hoverEl ||
			!this.hoverTitleEl ||
			!this.hoverBodyEl ||
			!anchorEl.isConnected
		) {
			return;
		}

		const node = this.findNodeObjById(mind.nodeData, nodeId);
		const noteText = normalizeNoteText(node?.note);
		if (!node || !noteText) return;

		this.hoveredNodeId = nodeId;
		const displayTopic =
			extractSearchableNodeText(node.topic || "备注")
				.replace(/\s+/g, " ")
				.trim() || "备注";
		this.hoverTitleEl.setText(displayTopic);

		this.unloadRenderComp("hover");
		this.hoverBodyEl.empty();
		const comp = new Component();
		comp.load();
		this.hoverRenderComp = comp;
		void MarkdownRenderer.render(
			this.app,
			noteText,
			this.hoverBodyEl,
			this.host.getSourcePath(),
			comp
		);

		this.hoverEl.removeClass("mm-is-hidden");

		const hostRect = this.containerEl.getBoundingClientRect();
		const anchorRect = anchorEl.getBoundingClientRect();
		const cardWidth = Math.min(300, Math.max(200, hostRect.width - 24));
		const cardMaxHeight = Math.min(260, Math.max(120, hostRect.height - 80));

		let left = anchorRect.left - hostRect.left;
		if (left + cardWidth > hostRect.width - 12) {
			left = hostRect.width - cardWidth - 12;
		}
		left = Math.max(12, left);

		let top = anchorRect.bottom - hostRect.top + 8;
		if (top + cardMaxHeight > hostRect.height - 12) {
			top = Math.max(56, anchorRect.top - hostRect.top - cardMaxHeight - 8);
		}

		this.hoverEl.setCssProps({
			"--mm-note-preview-left": `${Math.round(left)}px`,
			"--mm-note-preview-top": `${Math.round(top)}px`,
			"--mm-note-preview-width": `${Math.round(cardWidth)}px`,
		});
	}

	private hideHoverPreview(): void {
		this.hoveredNodeId = null;
		this.hoverEl?.addClass("mm-is-hidden");
		this.unloadRenderComp("hover");
	}

	private clearHoverShowTimer(): void {
		if (this.hoverShowTimer !== null) {
			window.clearTimeout(this.hoverShowTimer);
			this.hoverShowTimer = null;
		}
	}

	private clearHoverHideTimer(): void {
		if (this.hoverHideTimer !== null) {
			window.clearTimeout(this.hoverHideTimer);
			this.hoverHideTimer = null;
		}
	}

	private clearHoverTimers(): void {
		this.clearHoverShowTimer();
		this.clearHoverHideTimer();
	}

	private unloadRenderComp(kind: "panel" | "hover"): void {
		if (kind === "panel" && this.panelRenderComp) {
			this.panelRenderComp.unload();
			this.panelRenderComp = null;
		} else if (kind === "hover" && this.hoverRenderComp) {
			this.hoverRenderComp.unload();
			this.hoverRenderComp = null;
		}
	}

	private findNodeObjById(
		root: NodeObj | null | undefined,
		targetId: string
	): NodeObj | null {
		if (!root) return null;
		if (root.id === targetId) return root;
		for (const child of root.children ?? []) {
			const hit = this.findNodeObjById(child, targetId);
			if (hit) return hit;
		}
		return null;
	}
}
