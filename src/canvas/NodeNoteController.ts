import {
	App,
	Component,
	MarkdownRenderer,
	setIcon,
} from "obsidian";
import type MindElixir from "mind-elixir";
import type { NodeObj, Topic } from "mind-elixir";
import { normalizeNoteText } from "../parser/markdownParser";
import { extractNodeDisplayTitle } from "../parser/inlineNodeContent";
import { NoteMarkdownEditor } from "./NoteMarkdownEditor";
import {
	NodeNoteSession,
	type NoteNodeSnapshot,
	type NotePanelMode,
} from "./NodeNoteSession";

export interface NodeNoteHost {
	getMind: () => MindElixir | null;
	getSourcePath: () => string;
	openInternalLink: (href: string, openInNewTab: boolean) => void;
	onNoteChanged: () => void;
	onLayoutChanged: () => void;
	onPanelStateChanged?: (isOpen: boolean) => void;
}

/**
 * Single seam predicate so external event listeners (Split View cursor sync,
 * global Ctrl+F) never need to know private Node Note DOM class names.
 */
export function isEventInsideNodeNoteSurface(
	target: EventTarget | null
): boolean {
	if (!target || typeof target !== "object") return false;
	const el = target as HTMLElement;
	return Boolean(el.closest?.(".mm-note-panel, .mm-note-preview"));
}

/**
 * Obsidian UI adapter for NodeNoteSession:
 * - Renders inline sticky-note badges on MindElixir Nodes
 * - Hosts the floating right-side NoteMarkdownEditor (Live Preview / fallback)
 * - Renders Markdown hover preview popovers via Obsidian's MarkdownRenderer
 */
export class NodeNoteController {
	private app: App;
	private host: NodeNoteHost;
	private session: NodeNoteSession;
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
	private hoverAnchorEl: HTMLElement | null = null;

	private panelRenderComp: Component | null = null;
	private hoverRenderComp: Component | null = null;

	constructor(app: App, host: NodeNoteHost) {
		this.app = app;
		this.host = host;
		this.session = new NodeNoteSession({
			getNode: (nodeId) => this.readNodeSnapshot(nodeId),
			getSelectedNodeId: () =>
				this.host.getMind()?.currentNode?.nodeObj?.id ?? null,
			getFallbackRootNodeId: () =>
				this.host.getMind()?.nodeData?.id ?? null,
			selectNode: (nodeId) => {
				const mind = this.host.getMind();
				if (!mind) return;
				try {
					const tpc = mind.findEle(nodeId);
					if (tpc && mind.currentNode !== tpc) {
						mind.selectNode(tpc);
					}
				} catch {
					// Ignore if node is not currently mounted
				}
			},
			writeNodeNote: (nodeId, normalizedNote) => {
				this.applyNoteToMind(nodeId, normalizedNote);
			},
			showPanel: (_node, mode, focusEditor) => {
				this.panelEl?.removeClass("mm-is-hidden");
				if (mode === "edit" && focusEditor) {
					this.noteEditor?.focusEnd();
				}
			},
			hidePanel: (restoreCanvasFocus) => {
				this.panelEl?.addClass("mm-is-hidden");
				this.unloadRenderComp("panel");
				if (restoreCanvasFocus) {
					this.host.getMind()?.container?.focus();
				}
			},
			updatePanelHeader: (node) => {
				this.renderPanelHeader(node.topic);
			},
			applyPanelMode: (mode, previewMarkdown) => {
				this.renderPanelMode(mode, previewMarkdown);
			},
			setEditorValue: (value, clearHistory) => {
				this.noteEditor?.setValue(value, clearHistory);
			},
			getEditorValue: () => this.noteEditor?.getValue() ?? "",
			isEditorFocused: () => Boolean(this.noteEditor?.isFocused()),
			focusEditor: () => {
				this.noteEditor?.focusEnd();
			},
			updateClearButton: (hasContent) => {
				this.clearBtnEl?.toggleClass("mm-is-hidden", !hasContent);
			},
			onPanelStateChanged: (isOpen) => {
				this.host.onPanelStateChanged?.(isOpen);
			},
			showHoverPreview: (node) => {
				this.renderHoverPreview(node);
			},
			hideHoverPreview: () => {
				this.hoverEl?.addClass("mm-is-hidden");
				this.hoverAnchorEl = null;
				this.unloadRenderComp("hover");
			},
			scheduleTimer: (fn, delayMs) => window.setTimeout(fn, delayMs),
			cancelTimer: (handle) => window.clearTimeout(Number(handle)),
		});
	}

	public attach(container: HTMLElement): void {
		this.detach();
		this.containerEl = container;
		this.buildPanel(container);
		this.buildHoverPreview(container);
	}

	public detach(): void {
		this.session.dispose();
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
		this.hoverAnchorEl = null;
		this.containerEl = null;
	}

	public isOpen(): boolean {
		return this.session.isOpen();
	}

	public openForSelectedNode(): void {
		this.session.openForSelectedNode();
	}

	public toggleForSelectedNode(): void {
		this.session.toggleForSelectedNode();
	}

	public openForNode(nodeId: string, mode: NotePanelMode = "edit"): void {
		this.session.openForNode(nodeId, mode);
	}

	public close(restoreCanvasFocus = false): void {
		this.session.close(restoreCanvasFocus);
	}

	public flushPendingSave(): void {
		this.session.flushPendingSave();
	}

	public onCanvasSelectionChanged(mind: MindElixir): void {
		if (mind.currentNodes.length !== 1 || !mind.currentNode?.nodeObj) {
			return;
		}
		this.session.onCanvasSelectionChanged(mind.currentNode.nodeObj.id);
	}

	public onExternalRefresh(mind: MindElixir): void {
		this.syncBadges(mind);
		this.session.onExternalRefresh();
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

	private readNodeSnapshot(nodeId: string): NoteNodeSnapshot | null {
		const mind = this.host.getMind();
		if (!mind) return null;
		const node = this.findNodeObjById(mind.nodeData, nodeId);
		if (!node) return null;
		return {
			id: node.id,
			topic: node.topic ?? "",
			note: node.note ?? "",
		};
	}

	private applyNoteToMind(nodeId: string, normalized: string): void {
		const mind = this.host.getMind();
		if (!mind) return;
		const node = this.findNodeObjById(mind.nodeData, nodeId);
		if (!node) return;

		if (normalized) {
			node.note = normalized;
		} else {
			delete node.note;
		}

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

		this.syncBadges(mind);
		this.host.onNoteChanged();
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
			evt.preventDefault();
			evt.stopPropagation();
		};
		badge.addEventListener("pointerdown", stop);
		badge.addEventListener("mousedown", stop);
		badge.addEventListener("dblclick", stop);
		badge.addEventListener("click", (evt) => {
			stop(evt);
			const id = badge.dataset.nodeId;
			if (id) {
				this.session.openForNode(id, "edit");
			}
		});
		badge.addEventListener("mouseenter", () => {
			const id = badge.dataset.nodeId;
			if (id) {
				this.hoverAnchorEl = badge;
				this.session.onBadgeMouseEnter(id);
			}
		});
		badge.addEventListener("mouseleave", () => {
			this.session.onBadgeMouseLeave();
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
			this.session.setMode("edit");
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
			this.session.setMode("preview");
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
			this.session.clearActiveNote();
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
			this.session.close(true);
		});

		const body = panel.createDiv({ cls: "mm-note-panel-body" });
		const noteEditor = new NoteMarkdownEditor({
			app: this.app,
			containerEl: body,
			placeholder:
				"在此输入节点备注（支持实时预览、标题、列表、代码块、[[双链]] 等）...",
			onChange: (value) => {
				this.session.onEditorInput(value);
			},
			onBlur: () => {
				this.session.flushPendingSave();
			},
			onEscape: () => {
				this.session.close(true);
			},
		});

		const preview = body.createDiv({
			cls: "mm-note-panel-preview markdown-rendered mm-is-hidden",
		});
		this.bindRenderedLinkClicks(preview);

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
		hover.addEventListener("mouseenter", () => {
			this.session.onPreviewMouseEnter();
		});
		hover.addEventListener("mouseleave", () => {
			this.session.onPreviewMouseLeave();
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
			this.session.openHoveredForEdit();
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
				this.host.openInternalLink(href, evt.ctrlKey || evt.metaKey);
			}
		});
	}

	private renderPanelHeader(topic: string): void {
		if (!this.panelTitleEl) return;
		const displayTopic = extractNodeDisplayTitle(topic, "未命名节点");
		this.panelTitleEl.setText(displayTopic);
		this.panelTitleEl.setAttribute("title", displayTopic);
	}

	private renderPanelMode(mode: NotePanelMode, previewMarkdown: string): void {
		const isPreview = mode === "preview";
		this.editModeBtnEl?.toggleClass("is-active", !isPreview);
		this.previewModeBtnEl?.toggleClass("is-active", isPreview);
		this.noteEditor?.setVisible(!isPreview);
		this.panelPreviewEl?.toggleClass("mm-is-hidden", !isPreview);
		if (!isPreview || !this.panelPreviewEl) return;

		this.unloadRenderComp("panel");
		this.panelPreviewEl.empty();

		if (!previewMarkdown) {
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
			previewMarkdown,
			this.panelPreviewEl,
			this.host.getSourcePath(),
			comp
		);
	}

	private renderHoverPreview(node: NoteNodeSnapshot): void {
		const anchorEl = this.hoverAnchorEl;
		if (
			!this.containerEl ||
			!this.hoverEl ||
			!this.hoverTitleEl ||
			!this.hoverBodyEl ||
			!anchorEl?.isConnected
		) {
			return;
		}

		this.hoverTitleEl.setText(extractNodeDisplayTitle(node.topic, "备注"));
		this.unloadRenderComp("hover");
		this.hoverBodyEl.empty();
		const comp = new Component();
		comp.load();
		this.hoverRenderComp = comp;
		void MarkdownRenderer.render(
			this.app,
			node.note,
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
