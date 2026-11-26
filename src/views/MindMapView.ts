import {
	Menu,
	Notice,
	TFile,
	TextFileView,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from "obsidian";
import MindElixir, {
	type MindElixirData,
	type Topic,
} from "mind-elixir";
import type SimpleMindMapPlugin from "../main";
import { MindMapDocument } from "../parser/MindMapDocument";
import { renderNodeMarkdown } from "../parser/markdownParser";
import {
	MINDMAP_ICON_ID,
	MINDMAP_VIEW_TYPE,
	SPLIT_LEFT_RIGHT_ICON_ID,
	SPLIT_TOP_BOTTOM_ICON_ID,
	type MindMapDirection,
	type MindMapStylePreset,
	codeToDirection,
	directionToCode,
} from "../settings/types";
import { ExportMindMapModal } from "../modals/ExportMindMapModal";
import { NodeInlineEditor } from "../editor/NodeInlineEditor";
import { MindMapExporter } from "../export/MindMapExporter";
import type { ExportFormat } from "../export/MindMapExportPipeline";
import {
	STYLE_PRESET_LABELS,
	buildCanvasKeypressOptions,
	buildCanvasTheme,
	buildContextMenuOption,
	createCanvasRelinkScheduler,
	isImageEventTarget,
	type CanvasRelinkScheduler,
} from "../canvas/canvasConfig";
import {
	findMatchingNodes,
	stepSearchMatchIndex,
	type NodeSearchMatch,
} from "../canvas/nodeSearch";

export class MindMapView extends TextFileView {
	private plugin: SimpleMindMapPlugin;
	private mind: MindElixir | null = null;
	private mapHostEl: HTMLElement | null = null;
	private toolbarEl: HTMLElement | null = null;
	private document: MindMapDocument;
	private isInternalRefresh = false;
	private mountedHotkeysKey = "";
	private splitHeaderActionEl: HTMLElement | null = null;
	private swapSplitHeaderActionEl: HTMLElement | null = null;
	private switchToSourceHeaderActionEl: HTMLElement | null = null;
	private inlineEditor: NodeInlineEditor;
	private exporter: MindMapExporter;
	private relinkScheduler: CanvasRelinkScheduler;
	private nodesResizeObserver: ResizeObserver | null = null;
	private quickAddBtnEl: HTMLButtonElement | null = null;
	private rootCollapseBtnEl: HTMLButtonElement | null = null;
	private isRootCollapsed = false;
	private searchBarEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private searchCountEl: HTMLElement | null = null;
	private searchMatches: NodeSearchMatch[] = [];
	private searchActiveIndex = -1;

	constructor(leaf: WorkspaceLeaf, plugin: SimpleMindMapPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.document = new MindMapDocument(
			plugin.settings.defaultDirection,
			plugin.settings.defaultStylePreset
		);
		this.inlineEditor = new NodeInlineEditor(this.app, {
			getMind: () => this.mind,
			getSourcePath: () => this.file?.path ?? "",
			resolveVaultImage: (target) => this.resolveVaultImageUrl(target),
			savePastedImage: (blob) => this.createVaultImageFromBlob(blob),
			onRelinkNeeded: () => this.relinkScheduler.schedule(),
		});
		this.exporter = new MindMapExporter(this.app);
		this.relinkScheduler = createCanvasRelinkScheduler({
			isReady: () => this.isCanvasLayoutReady(),
			linkDiv: () => {
				this.mind?.linkDiv();
			},
			requestFrame: (cb) => window.requestAnimationFrame(cb),
			cancelFrame: (id) => window.cancelAnimationFrame(id),
		});
	}

	getViewType(): string {
		return MINDMAP_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file ? this.file.basename : "脑图";
	}

	getIcon(): string {
		return MINDMAP_ICON_ID;
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mm-view-container");

		this.splitHeaderActionEl = this.addAction(
			SPLIT_LEFT_RIGHT_ICON_ID,
			"拆分视图（脑图 + 源码）",
			(evt) => {
				this.plugin.openSplitViewMenu(this.leaf, evt);
			}
		);
		this.splitHeaderActionEl.addClass("mm-split-header-action");
		this.swapSplitHeaderActionEl = this.addAction(
			"arrow-left-right",
			"调换拆分视图位置（脑图 ↔ 源码）",
			() => {
				void this.plugin.session.swapSplitPositions(this.leaf);
			}
		);
		this.swapSplitHeaderActionEl.addClass("mm-swap-split-header-action");
		this.switchToSourceHeaderActionEl = this.addAction(
			"code-2",
			"切换到 Markdown 源码模式 (Ctrl+.)",
			() => {
				if (this.file) {
					void this.plugin.session.openSourceMode(this.leaf, this.file.path);
				}
			}
		);
		this.addAction("download", "导出脑图（可选格式与目录）", () => {
			this.openExportModal();
		});

		this.toolbarEl = this.contentEl.createDiv({ cls: "mm-floating-toolbar" });
		this.buildToolbar(this.toolbarEl);
		this.buildSearchBar(this.contentEl);

		this.registerDomEvent(
			window,
			"keydown",
			(evt: KeyboardEvent) => this.handleGlobalFindShortcut(evt),
			true
		);

		this.mapHostEl = this.contentEl.createDiv({ cls: "mm-canvas-host" });
		this.registerDomEvent(
			this.mapHostEl,
			"pointerdown",
			() => {
				if (this.file) {
					this.plugin.session.flushSourceToMindMap(this.file.path);
				}
			},
			true
		);
		this.registerDomEvent(this.mapHostEl, "click", (evt) => this.handleCanvasClick(evt), true);
		this.registerDomEvent(this.mapHostEl, "mouseover", (evt) => this.handleCanvasHover(evt));
		this.registerDomEvent(
			this.mapHostEl,
			"load",
			(evt) => this.handleCanvasMediaEvent(evt),
			true
		);
		this.registerDomEvent(
			this.mapHostEl,
			"error",
			(evt) => this.handleCanvasMediaEvent(evt),
			true
		);
		this.inlineEditor.attach(this.mapHostEl);

		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				this.applyCurrentTheme();
			})
		);
		this.refreshSplitButtons();
	}

	async onClose(): Promise<void> {
		this.closeNodeSearch(false);
		this.inlineEditor.detach();
		this.destroyMindMap();
	}

	getViewData(): string {
		return this.document.serialize(
			this.mind ? this.mind.getData() : null,
			this.plugin.settings.markdownStyle,
			this.data ?? ""
		);
	}

	async save(clear?: boolean): Promise<void> {
		const snapshot = this.getViewData();
		this.document.markSaveInFlight(snapshot);
		await super.save(clear);
		if (!clear) {
			this.document.markSaved(snapshot);
		}
	}

	setViewData(data: string, clear: boolean): void {
		this.data = data;
		if (this.file?.path) {
			this.plugin.session.recordSyncedMarkdown(this.file.path, data);
		}
		this.applyMarkdownData(data, clear);
	}

	public syncFromExternalMarkdown(markdown: string): void {
		if (markdown === this.document.lastSyncedMarkdown) {
			return;
		}
		this.data = markdown;
		try {
			this.applyMarkdownData(markdown, false);
		} catch {
			// Ignore transient parse/render failures while user is mid-keystroke in Source Mode
		}
	}

	private applyMarkdownData(data: string, clear: boolean): void {
		const decision = this.document.reconcileExternalMarkdown(data, {
			fallbackTitle: this.file?.basename ?? "中心主题",
			defaultDirection: this.plugin.settings.defaultDirection,
			defaultStylePreset: this.plugin.settings.defaultStylePreset,
			clear,
			hasCanvas: this.mind !== null,
		});

		if (decision.action === "noop") {
			return;
		}

		this.applyStylePresetClass();

		if (decision.action === "mount") {
			void this.mountMindMap(decision.data);
		} else if (this.mind) {
			this.isInternalRefresh = true;
			try {
				this.mind.direction = directionToCode(decision.direction);
				this.applyCurrentTheme();
				this.mind.refresh(decision.data);
				this.mind.clearHistory?.();
			} finally {
				this.isInternalRefresh = false;
			}
			this.syncCollapseBadges(this.mind);
			this.updateQuickAddButton(this.mind);
			this.updateDirectionButtons();
		}
		this.refreshSplitButtons();
	}

	clear(): void {
		this.closeNodeSearch(false);
		this.document.clear(
			this.plugin.settings.defaultDirection,
			this.plugin.settings.defaultStylePreset
		);
		this.destroyMindMap();
	}

	public hasPendingLocalEdits(): boolean {
		return this.document.hasPendingLocalEdits();
	}

	public recenterCanvas(): void {
		if (!this.mind) return;
		const mind = this.mind;
		window.requestAnimationFrame(() => {
			if (this.mind === mind) {
				mind.toCenter();
			}
		});
	}

	public refreshSplitButtons(): void {
		const state = this.plugin.session.getSplitState(this.leaf);
		const swapIcon =
			state.layout === "top-bottom" ? "arrow-up-down" : "arrow-left-right";
		const swapTitle =
			state.layout === "top-bottom"
				? "调换上下位置（脑图 ↔ 源码）"
				: "调换左右位置（脑图 ↔ 源码）";

		if (this.toolbarEl) {
			this.toolbarEl.querySelectorAll(".mm-split-btn").forEach((el) => {
				el.removeClass("is-active");
			});
			if (state.isActive && state.layout) {
				const activeBtn = this.toolbarEl.querySelector(
					`.mm-split-${state.layout}`
				);
				activeBtn?.addClass("is-active");
			}

			const swapToolbarBtn =
				this.toolbarEl.querySelector<HTMLElement>(".mm-split-swap-btn");
			if (swapToolbarBtn) {
				swapToolbarBtn.toggleClass("mm-is-hidden", !state.isActive);
				if (state.isActive) {
					setIcon(swapToolbarBtn, swapIcon);
					swapToolbarBtn.setAttribute("aria-label", swapTitle);
					swapToolbarBtn.setAttribute("title", swapTitle);
				}
			}

			const switchSourceBtn = this.toolbarEl.querySelector<HTMLElement>(
				".mm-switch-source-btn"
			);
			switchSourceBtn?.toggleClass("mm-is-hidden", state.isActive);
		}

		if (this.splitHeaderActionEl) {
			this.splitHeaderActionEl.toggleClass("is-active", state.isActive);
			const iconId =
				state.isActive && state.layout === "top-bottom"
					? SPLIT_TOP_BOTTOM_ICON_ID
					: SPLIT_LEFT_RIGHT_ICON_ID;
			setIcon(this.splitHeaderActionEl, iconId);
		}

		if (this.swapSplitHeaderActionEl) {
			this.swapSplitHeaderActionEl.toggleClass("mm-is-hidden", !state.isActive);
			if (state.isActive) {
				setIcon(this.swapSplitHeaderActionEl, swapIcon);
				this.swapSplitHeaderActionEl.setAttribute("aria-label", swapTitle);
				this.swapSplitHeaderActionEl.setAttribute("title", swapTitle);
			}
		}

		if (this.switchToSourceHeaderActionEl) {
			this.switchToSourceHeaderActionEl.toggleClass(
				"mm-is-hidden",
				state.isActive
			);
		}
	}

	public refreshFromSettings(): void {
		if (!this.mind) return;
		if (
			!this.document.hasExplicitStyleInNote() &&
			this.document.stylePreset !== this.plugin.settings.defaultStylePreset
		) {
			this.document.setStylePreset(
				this.plugin.settings.defaultStylePreset,
				false
			);
			this.applyStylePresetClass();
		}
		this.applyCurrentTheme();
		this.mind.changeCompact(this.plugin.settings.compactMode);
		this.mind.linkDiv();

		// Remount canvas when hotkeys or context menu language changed, preserving viewport/undo otherwise
		const nextOptionsKey = this.getMountedCanvasOptionsKey();
		if (nextOptionsKey !== this.mountedHotkeysKey) {
			const currentData = this.mind.getData();
			void this.mountMindMap(currentData);
		}
	}

	private getMountedCanvasOptionsKey(): string {
		return JSON.stringify({
			hotkeys: this.plugin.settings.hotkeys,
			contextMenuLanguage: this.plugin.settings.contextMenuLanguage,
		});
	}

	public commitActiveEdit(): void {
		this.inlineEditor.commitActiveEdit();
	}

	public openInsertNoteModal(): void {
		this.inlineEditor.openInsertNoteModal();
	}

	public openInsertImageModal(): void {
		this.inlineEditor.openInsertImageModal();
	}

	public openNodeSearch(): void {
		if (!this.searchBarEl || !this.searchInputEl) return;
		this.inlineEditor.commitActiveEdit();
		this.searchBarEl.removeClass("mm-is-hidden");
		this.searchInputEl.focus();
		this.searchInputEl.select();
		if (this.searchInputEl.value.trim()) {
			this.runNodeSearch(this.searchInputEl.value, false);
		} else {
			this.updateSearchCounter();
		}
	}

	public closeNodeSearch(restoreCanvasFocus = true): void {
		this.searchBarEl?.addClass("mm-is-hidden");
		this.searchMatches = [];
		this.searchActiveIndex = -1;
		this.clearSearchHighlights();
		if (restoreCanvasFocus) {
			this.mind?.container?.focus();
		}
	}

	private handleGlobalFindShortcut(evt: KeyboardEvent): void {
		if (
			!(evt.ctrlKey || evt.metaKey) ||
			evt.altKey ||
			evt.shiftKey ||
			evt.key.toLowerCase() !== "f"
		) {
			return;
		}
		const activeView = this.app.workspace.getActiveViewOfType(MindMapView);
		const target = evt.target as Node | null;
		const isInsideThisView = Boolean(target && this.contentEl.contains(target));
		if (activeView !== this && !isInsideThisView) {
			return;
		}
		evt.preventDefault();
		evt.stopPropagation();
		this.openNodeSearch();
	}

	private buildSearchBar(container: HTMLElement): void {
		const bar = container.createDiv({ cls: "mm-search-bar mm-is-hidden" });
		const stopPointer = (evt: Event) => {
			evt.stopPropagation();
		};
		bar.addEventListener("pointerdown", stopPointer);
		bar.addEventListener("mousedown", stopPointer);
		bar.addEventListener("click", stopPointer);

		const iconEl = bar.createSpan({ cls: "mm-search-icon" });
		setIcon(iconEl, "search");

		const input = bar.createEl("input", {
			cls: "mm-search-input",
			attr: {
				type: "text",
				placeholder: "搜索节点内容...",
				"aria-label": "搜索节点内容",
			},
		});
		const countEl = bar.createSpan({ cls: "mm-search-count" });

		const prevBtn = bar.createEl("button", {
			cls: "mm-search-btn",
			attr: {
				type: "button",
				title: "上一个匹配 (Shift+Enter)",
				"aria-label": "上一个匹配",
			},
		});
		setIcon(prevBtn, "chevron-up");

		const nextBtn = bar.createEl("button", {
			cls: "mm-search-btn",
			attr: {
				type: "button",
				title: "下一个匹配 (Enter)",
				"aria-label": "下一个匹配",
			},
		});
		setIcon(nextBtn, "chevron-down");

		const closeBtn = bar.createEl("button", {
			cls: "mm-search-btn",
			attr: {
				type: "button",
				title: "关闭搜索 (Esc)",
				"aria-label": "关闭搜索",
			},
		});
		setIcon(closeBtn, "x");

		input.addEventListener("input", () => {
			this.runNodeSearch(input.value, true);
		});
		input.addEventListener("keydown", (evt) => {
			evt.stopPropagation();
			if (evt.isComposing || evt.key === "Process") return;
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.stepNodeSearch(evt.shiftKey ? -1 : 1);
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				this.closeNodeSearch(true);
			}
		});

		prevBtn.addEventListener("click", () => {
			this.stepNodeSearch(-1);
			input.focus();
		});
		nextBtn.addEventListener("click", () => {
			this.stepNodeSearch(1);
			input.focus();
		});
		closeBtn.addEventListener("click", () => {
			this.closeNodeSearch(true);
		});

		this.searchBarEl = bar;
		this.searchInputEl = input;
		this.searchCountEl = countEl;
	}

	private runNodeSearch(query: string, jumpToFirst: boolean): void {
		this.clearSearchHighlights();
		if (!this.mind || !query.trim()) {
			this.searchMatches = [];
			this.searchActiveIndex = -1;
			this.updateSearchCounter();
			return;
		}

		const data = this.mind.getData();
		this.searchMatches = findMatchingNodes(data.nodeData, query);
		if (this.searchMatches.length === 0) {
			this.searchActiveIndex = -1;
			this.updateSearchCounter();
			return;
		}

		this.searchActiveIndex = jumpToFirst
			? 0
			: Math.max(0, Math.min(this.searchActiveIndex, this.searchMatches.length - 1));
		this.focusActiveSearchMatch();
	}

	private stepNodeSearch(delta: 1 | -1): void {
		if (!this.mind || !this.searchInputEl) return;
		const query = this.searchInputEl.value;
		if (!query.trim()) return;

		if (this.searchMatches.length === 0) {
			this.runNodeSearch(query, true);
			return;
		}

		this.searchActiveIndex = stepSearchMatchIndex(
			this.searchActiveIndex,
			this.searchMatches.length,
			delta
		);
		this.focusActiveSearchMatch();
	}

	private focusActiveSearchMatch(): void {
		const mind = this.mind;
		if (!mind || this.searchActiveIndex < 0) {
			this.updateSearchCounter();
			return;
		}
		const activeMatch = this.searchMatches[this.searchActiveIndex];
		if (!activeMatch) {
			this.updateSearchCounter();
			return;
		}

		// Auto-expand root or any collapsed ancestor along the path without polluting undo history
		if (this.isRootCollapsed && activeMatch.ancestorIds.length > 0) {
			this.setRootCollapsed(mind, false);
		}
		for (const ancestorId of activeMatch.ancestorIds) {
			try {
				const ancestorEl = mind.findEle(ancestorId);
				if (ancestorEl && ancestorEl.nodeObj.expanded === false) {
					mind.expandNode(ancestorEl, true, { silent: true });
				}
			} catch {
				// Ignore if ancestor is not currently mounted
			}
		}

		this.applySearchHighlights(activeMatch.nodeId);

		try {
			const targetEl = mind.findEle(activeMatch.nodeId);
			if (targetEl) {
				mind.selectNode(targetEl);
				mind.scrollIntoView(targetEl);
			}
		} catch {
			// Node may not be mounted in focus mode
		}

		this.updateSearchCounter();
	}

	private applySearchHighlights(activeNodeId: string): void {
		this.clearSearchHighlights();
		const mind = this.mind;
		if (!mind) return;
		for (const match of this.searchMatches) {
			try {
				const el = mind.findEle(match.nodeId);
				if (!el) continue;
				el.addClass("mm-search-match");
				if (match.nodeId === activeNodeId) {
					el.addClass("mm-search-match-active");
				}
			} catch {
				// Ignore unmounted/collapsed nodes
			}
		}
	}

	private clearSearchHighlights(): void {
		if (!this.mind?.nodes) return;
		this.mind.nodes
			.querySelectorAll(".mm-search-match, .mm-search-match-active")
			.forEach((el) => {
				el.removeClass("mm-search-match");
				el.removeClass("mm-search-match-active");
			});
	}

	private updateSearchCounter(): void {
		if (!this.searchCountEl || !this.searchInputEl) return;
		const hasQuery = this.searchInputEl.value.trim().length > 0;
		if (!hasQuery) {
			this.searchCountEl.setText("");
			this.searchCountEl.removeClass("is-empty");
			return;
		}
		if (this.searchMatches.length === 0) {
			this.searchCountEl.setText("无匹配");
			this.searchCountEl.addClass("is-empty");
			return;
		}
		this.searchCountEl.setText(
			`${this.searchActiveIndex + 1} / ${this.searchMatches.length}`
		);
		this.searchCountEl.removeClass("is-empty");
	}

	private destroyMindMap(): void {
		this.clearSearchHighlights();
		this.searchMatches = [];
		this.searchActiveIndex = -1;
		this.relinkScheduler.cancel();
		if (this.nodesResizeObserver) {
			this.nodesResizeObserver.disconnect();
			this.nodesResizeObserver = null;
		}
		if (this.quickAddBtnEl) {
			this.quickAddBtnEl.remove();
			this.quickAddBtnEl = null;
		}
		if (this.rootCollapseBtnEl) {
			this.rootCollapseBtnEl.remove();
			this.rootCollapseBtnEl = null;
		}
		this.isRootCollapsed = false;
		this.inlineEditor.destroy();
		if (this.mind) {
			try {
				this.mind.destroy();
			} catch {
				// Ignore cleanup errors from detached DOM
			}
			this.mind = null;
		}
		if (this.mapHostEl) {
			this.mapHostEl.empty();
		}
	}

	private isCanvasLayoutReady(): boolean {
		const mind = this.mind;
		if (!mind || !mind.map?.isConnected) return false;
		const rootEl = mind.map.querySelector<HTMLElement>(".me-root");
		return Boolean(rootEl && (rootEl.offsetWidth > 0 || rootEl.offsetHeight > 0));
	}

	private handleCanvasMediaEvent(evt: Event): void {
		if (!isImageEventTarget(evt.target)) return;
		this.relinkScheduler.schedule();
	}

	private observeNodesLayout(mind: MindElixir): void {
		if (typeof ResizeObserver === "undefined" || !mind.nodes) return;
		let lastWidth = mind.nodes.offsetWidth;
		let lastHeight = mind.nodes.offsetHeight;
		const observer = new ResizeObserver((entries) => {
			if (this.mind !== mind) return;
			const entry = entries[entries.length - 1];
			if (!entry) return;
			const nextWidth = Math.round(entry.contentRect.width);
			const nextHeight = Math.round(entry.contentRect.height);
			if (nextWidth === lastWidth && nextHeight === lastHeight) {
				return;
			}
			lastWidth = nextWidth;
			lastHeight = nextHeight;
			this.relinkScheduler.schedule();
		});
		observer.observe(mind.nodes);
		this.nodesResizeObserver = observer;
	}

	private async mountMindMap(data: MindElixirData): Promise<void> {
		if (!this.mapHostEl) return;
		this.destroyMindMap();

		const mountEl = this.mapHostEl.createDiv({ cls: "mm-mind-elixir-root" });
		const theme = this.buildObsidianTheme();

		const mind = new MindElixir({
			el: mountEl,
			selectionContainer: this.contentEl.ownerDocument.body,
			direction: directionToCode(this.document.direction),
			editable: true,
			contextMenu: buildContextMenuOption(
				this.plugin.settings.contextMenuLanguage
			),
			toolBar: false,
			allowUndo: true,
			compact: this.plugin.settings.compactMode,
			newTopicName: "新节点",
			theme,
			keypress: buildCanvasKeypressOptions(
				this.plugin.settings.hotkeys,
				() => this.mind
			),
			markdown: (raw) =>
				renderNodeMarkdown(raw, (target) => this.resolveVaultImageUrl(target)),
			imageProxy: (url) => this.resolveVaultImageUrl(url) ?? url,
			pasteHandler: (evt) => {
				void this.handlePasteEvent(evt);
			},
		});

		this.mountedHotkeysKey = this.getMountedCanvasOptionsKey();
		const originalEditTopic: (el?: Topic) => void = mind.editTopic;
		const rawEditTopic = (el: Topic): void => {
			originalEditTopic.call(mind, el);
		};
		mind.editTopic = (el: Topic) => {
			this.inlineEditor.openRichEditor(mind, el, rawEditTopic);
		};
		this.mind = mind;
		this.isRootCollapsed = false;
		this.applyStylePresetClass();
		await mind.init(data);
		this.setupQuickAddButton(mind);
		this.setupRootCollapseButton(mind);
		this.syncCollapseBadges(mind);
		this.observeNodesLayout(mind);
		this.updateDirectionButtons();

		// Wait one frame for layout metrics before linking and centering
		window.requestAnimationFrame(() => {
			if (this.mind === mind) {
				if (this.isCanvasLayoutReady()) {
					mind.linkDiv();
				}
				this.syncCollapseBadges(mind);
				this.updateQuickAddButton(mind);
				mind.toCenter();
			}
		});

		mind.container.addEventListener("focus", () => {
			if (this.mind === mind) {
				this.updateQuickAddButton(mind);
			}
		});

		mind.bus.addListener("selectNewNode", () => {
			this.updateQuickAddButton(mind);
		});
		mind.bus.addListener("selectNodes", () => {
			this.updateQuickAddButton(mind);
		});
		mind.bus.addListener("unselectNodes", () => {
			this.updateQuickAddButton(mind);
		});
		mind.bus.addListener("linkDiv", () => {
			this.syncCollapseBadges(mind);
			this.updateQuickAddButton(mind);
		});

		mind.bus.addListener("operation", (op) => {
			if (this.isInternalRefresh) return;
			if (op.name === "beginEdit") {
				this.hideQuickAddButton();
				queueMicrotask(() =>
					this.inlineEditor.onBeginNodeEdit(mind, op.target.id)
				);
				return;
			}
			if (op.name === "addChild" && this.isRootCollapsed) {
				this.setRootCollapsed(mind, false);
			}
			queueMicrotask(() => {
				if (this.mind === mind) {
					this.syncCollapseBadges(mind);
					this.updateQuickAddButton(mind);
				}
			});
			this.markLocalEditAndScheduleSave();
		});

		mind.bus.addListener("changeDirection", (dir) => {
			if (this.isInternalRefresh) return;
			this.document.setDirection(codeToDirection(dir));
			this.updateDirectionButtons();
			this.updateQuickAddButton(mind);
			this.markLocalEditAndScheduleSave();
		});

		mind.bus.addListener("refresh", () => {
			if (this.isInternalRefresh) return;
			this.syncCollapseBadges(mind);
			this.updateQuickAddButton(mind);
			this.markLocalEditAndScheduleSave();
		});
	}

	private applyStylePresetClass(): void {
		if (!this.mapHostEl) return;
		const preset = this.document.stylePreset;
		this.mapHostEl.toggleClass("mm-style-classic", preset === "classic");
		this.mapHostEl.toggleClass("mm-style-card", preset === "card");
		this.mapHostEl.toggleClass("mm-style-bordered", preset === "bordered");
	}

	private setStylePreset(preset: MindMapStylePreset): void {
		if (!this.mind || this.document.stylePreset === preset) return;
		this.document.setStylePreset(preset, true);
		this.applyStylePresetClass();
		this.applyCurrentTheme();
		this.mind.linkDiv();
		this.syncCollapseBadges(this.mind);
		this.updateQuickAddButton(this.mind);
		this.markLocalEditAndScheduleSave();
	}

	private openStylePresetMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const current = this.document.stylePreset;
		const presets: MindMapStylePreset[] = ["classic", "card", "bordered"];
		for (const preset of presets) {
			menu.addItem((item) => {
				item
					.setTitle(STYLE_PRESET_LABELS[preset])
					.setChecked(current === preset)
					.onClick(() => {
						this.setStylePreset(preset);
					});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private setupQuickAddButton(mind: MindElixir): void {
		if (this.quickAddBtnEl) {
			this.quickAddBtnEl.remove();
			this.quickAddBtnEl = null;
		}
		const btn = mind.nodes.createEl("button", {
			cls: "mm-node-quick-add mm-is-hidden",
			attr: {
				type: "button",
				title: "添加子节点 (Tab)",
				"aria-label": "添加子节点",
			},
		});
		setIcon(btn, "plus");
		const stop = (evt: Event) => {
			evt.preventDefault();
			evt.stopPropagation();
		};
		btn.addEventListener("pointerdown", stop);
		btn.addEventListener("pointerup", stop);
		btn.addEventListener("mousedown", stop);
		btn.addEventListener("click", (evt) => {
			stop(evt);
			if (this.mind !== mind || !mind.currentNode) return;
			if (
				this.isRootCollapsed &&
				mind.currentNode.parentElement?.classList.contains("me-root")
			) {
				this.setRootCollapsed(mind, false);
			}
			void mind.addChild(mind.currentNode);
		});
		this.quickAddBtnEl = btn;
	}

	private setupRootCollapseButton(mind: MindElixir): void {
		if (this.rootCollapseBtnEl) {
			this.rootCollapseBtnEl.remove();
			this.rootCollapseBtnEl = null;
		}
		const btn = mind.nodes.createEl("button", {
			cls: "mm-root-collapse-btn mm-is-hidden",
			attr: {
				type: "button",
				title: "收起子节点",
				"aria-label": "收起子节点",
			},
		});
		const stop = (evt: Event) => {
			evt.preventDefault();
			evt.stopPropagation();
		};
		btn.addEventListener("pointerdown", stop);
		btn.addEventListener("pointerup", stop);
		btn.addEventListener("mousedown", stop);
		btn.addEventListener("click", (evt) => {
			stop(evt);
			if (this.mind !== mind) return;
			this.setRootCollapsed(mind, !this.isRootCollapsed);
		});
		this.rootCollapseBtnEl = btn;
	}

	private setRootCollapsed(mind: MindElixir, collapsed: boolean): void {
		if (this.isRootCollapsed === collapsed) return;
		const rootEl = mind.nodes.querySelector<HTMLElement>(".me-root");
		const beforeRect = rootEl?.getBoundingClientRect() ?? null;

		this.isRootCollapsed = collapsed;
		mind.nodes.toggleClass("mm-root-collapsed", collapsed);

		if (!collapsed) {
			mind.linkDiv();
		}

		if (rootEl && beforeRect) {
			const afterRect = rootEl.getBoundingClientRect();
			const dx = beforeRect.left - afterRect.left;
			const dy = beforeRect.top - afterRect.top;
			if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
				mind.move(dx, dy);
			}
		}

		this.syncCollapseBadges(mind);
		this.updateQuickAddButton(mind);
	}

	private hideQuickAddButton(): void {
		this.quickAddBtnEl?.addClass("mm-is-hidden");
		this.rootCollapseBtnEl?.addClass("mm-is-hidden");
	}

	private updateRootCollapseButton(mind: MindElixir): void {
		const btn = this.rootCollapseBtnEl;
		if (!btn || this.mind !== mind) return;

		const childCount = mind.nodeData?.children?.length ?? 0;
		const rootTpc = mind.nodes.querySelector<HTMLElement>(".me-root > .me-tpc");
		const isRootSelected = Boolean(
			mind.currentNodes.length === 1 &&
				mind.currentNode &&
				mind.currentNode === rootTpc
		);

		if (
			this.document.stylePreset === "classic" ||
			childCount === 0 ||
			!rootTpc ||
			!mind.nodes.isConnected ||
			mind.nodes.querySelector("#input-box") ||
			isRootSelected
		) {
			btn.addClass("mm-is-hidden");
			return;
		}

		let left = 0;
		let top = 0;
		let cur: HTMLElement | null = rootTpc;
		while (cur && cur !== mind.nodes) {
			left += cur.offsetLeft;
			top += cur.offsetTop;
			cur = cur.offsetParent as HTMLElement | null;
		}

		const w = rootTpc.offsetWidth;
		const h = rootTpc.offsetHeight;
		if (w === 0 && h === 0) {
			btn.addClass("mm-is-hidden");
			return;
		}

		const btnSize = 20;
		const isDown = mind.direction === 3;
		const isLeft = mind.direction === 0;

		let x: number;
		let y: number;
		let dirAttr: "right" | "left" | "down";

		if (isDown) {
			x = left + w / 2 - btnSize / 2;
			y = top + h + 6;
			dirAttr = "down";
		} else if (isLeft) {
			x = left - btnSize - 6;
			y = top + h / 2 - btnSize / 2;
			dirAttr = "left";
		} else {
			x = left + w + 6;
			y = top + h / 2 - btnSize / 2;
			dirAttr = "right";
		}

		btn.dataset.childCount = String(childCount);
		btn.dataset.dir = dirAttr;
		btn.toggleClass("is-collapsed", this.isRootCollapsed);
		const title = this.isRootCollapsed
			? `展开 ${childCount} 个分支`
			: "收起子节点";
		btn.setAttribute("title", title);
		btn.setAttribute("aria-label", title);
		btn.setCssProps({
			"--mm-rc-left": `${Math.round(x)}px`,
			"--mm-rc-top": `${Math.round(y)}px`,
		});
		btn.removeClass("mm-is-hidden");
	}

	private updateQuickAddButton(mind: MindElixir): void {
		this.updateRootCollapseButton(mind);
		const btn = this.quickAddBtnEl;
		if (!btn || this.mind !== mind) return;

		if (
			this.document.stylePreset === "classic" ||
			!mind.nodes.isConnected ||
			mind.nodes.querySelector("#input-box") ||
			mind.currentNodes.length !== 1 ||
			!mind.currentNode
		) {
			btn.addClass("mm-is-hidden");
			return;
		}

		const tpc = mind.currentNode;
		if (!tpc.isConnected) {
			btn.addClass("mm-is-hidden");
			return;
		}

		let left = 0;
		let top = 0;
		let cur: HTMLElement | null = tpc;
		while (cur && cur !== mind.nodes) {
			left += cur.offsetLeft;
			top += cur.offsetTop;
			cur = cur.offsetParent as HTMLElement | null;
		}

		const w = tpc.offsetWidth;
		const h = tpc.offsetHeight;
		if (w === 0 && h === 0) {
			btn.addClass("mm-is-hidden");
			return;
		}

		const btnSize = 20;
		const parentEl = tpc.parentElement;
		const isRoot = Boolean(parentEl?.classList.contains("me-root"));
		const isDown = mind.direction === 3;
		const isLhs = Boolean(tpc.closest(".lhs"));
		const isLeftRoot = isRoot && mind.direction === 0;

		let x: number;
		let y: number;

		// Place (+) cleanly on the outgoing connector stub (same slot as collapse/expand, mutually exclusive)
		if (isDown) {
			x = left + w / 2 - btnSize / 2;
			y = top + h + 6;
		} else if (isLhs || isLeftRoot) {
			x = left - btnSize - 6;
			y = top + h / 2 - btnSize / 2;
		} else {
			x = left + w + 6;
			y = top + h / 2 - btnSize / 2;
		}

		btn.setCssProps({
			"--mm-qa-left": `${Math.round(x)}px`,
			"--mm-qa-top": `${Math.round(y)}px`,
		});
		btn.removeClass("mm-is-hidden");
	}

	private syncCollapseBadges(mind: MindElixir): void {
		if (!mind.nodes) return;
		const expanders = mind.nodes.querySelectorAll<HTMLElement>(".me-parent > .me-epd");
		expanders.forEach((epd) => {
			const parentEl = epd.parentElement;
			const tpc = parentEl?.firstElementChild as Topic | null;
			const count = tpc?.nodeObj?.children?.length ?? 0;
			epd.dataset.childCount = String(count);
			const isExpanded = epd.classList.contains("minus");
			const title = isExpanded
				? "收起子节点"
				: `展开 ${count} 个子节点`;
			epd.setAttribute("title", title);
			epd.setAttribute("aria-label", title);
		});
	}

	private markLocalEditAndScheduleSave(): void {
		if (!this.file) return;
		this.document.markLocalEdit();
		this.requestSave();
		this.plugin.session.onMindMapChange(this.file.path);
	}

	private buildObsidianTheme() {
		const styles = getComputedStyle(activeDocument.body);
		return buildCanvasTheme(
			this.plugin.settings.themeMode,
			activeDocument.body.classList.contains("theme-dark"),
			(name) => styles.getPropertyValue(name),
			this.document.stylePreset
		);
	}

	private applyCurrentTheme(): void {
		if (!this.mind) return;
		this.mind.changeTheme(this.buildObsidianTheme(), false);
	}

	private resolveVaultImageUrl(target: string): string | null {
		const cleanTarget = target.trim();
		if (!cleanTarget) return null;

		if (/^(https?:\/\/|data:image\/|app:\/\/|capacitor:\/\/)/i.test(cleanTarget)) {
			return cleanTarget;
		}

		const sourcePath = this.file?.path ?? "";
		const linkedFile = this.app.metadataCache.getFirstLinkpathDest(
			cleanTarget,
			sourcePath
		);
		if (linkedFile) {
			return this.app.vault.getResourcePath(linkedFile);
		}

		const directFile = this.app.vault.getAbstractFileByPath(normalizePath(cleanTarget));
		if (directFile instanceof TFile) {
			return this.app.vault.getResourcePath(directFile);
		}

		return null;
	}

	private handleCanvasClick(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		if (!target) return;

		const wikiLink = target.closest<HTMLAnchorElement>("a.mm-wikilink");
		if (wikiLink) {
			evt.preventDefault();
			evt.stopPropagation();
			const href = wikiLink.dataset.href;
			if (href) {
				const openInNewTab = evt.ctrlKey || evt.metaKey;
				void this.app.workspace.openLinkText(
					href,
					this.file?.path ?? "",
					openInNewTab
				);
			}
			return;
		}

		const extLink = target.closest<HTMLAnchorElement>("a.mm-extlink");
		if (extLink) {
			evt.stopPropagation();
		}
	}

	private handleCanvasHover(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		if (!target) return;

		const wikiLink = target.closest<HTMLAnchorElement>("a.mm-wikilink");
		if (!wikiLink) return;
		const href = wikiLink.dataset.href;
		if (!href) return;

		this.app.workspace.trigger("hover-link", {
			event: evt,
			source: MINDMAP_VIEW_TYPE,
			hoverParent: this,
			targetEl: wikiLink,
			linktext: href,
			sourcePath: this.file?.path ?? "",
		});
	}

	private async createVaultImageFromBlob(blob: Blob): Promise<TFile> {
		const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
		const fileName = `mindmap-img-${Date.now()}.${ext}`;
		const targetPath = await this.app.fileManager.getAvailablePathForAttachment(
			fileName,
			this.file?.path ?? ""
		);
		const arrayBuffer = await blob.arrayBuffer();
		return this.app.vault.createBinary(targetPath, arrayBuffer);
	}

	private async handlePasteEvent(evt: ClipboardEvent): Promise<void> {
		if (!this.mind || !this.mind.currentNode || !evt.clipboardData) return;

		const items = Array.from(evt.clipboardData.items);
		const imageItem = items.find((item) => item.type.startsWith("image/"));
		if (!imageItem) return;

		evt.preventDefault();
		const blob = imageItem.getAsFile();
		if (!blob) return;

		const createdFile = await this.createVaultImageFromBlob(blob);
		await this.inlineEditor.appendImageEmbedToSelectedNode(createdFile);
		new Notice(`已粘贴图片到节点：${createdFile.name}`);
	}

	private buildToolbar(container: HTMLElement): void {
		container.empty();

		const addBtn = (
			icon: string,
			title: string,
			onClick: (evt: MouseEvent) => void,
			extraClass?: string
		): HTMLButtonElement => {
			const btn = container.createEl("button", {
				cls: `mm-toolbar-btn ${extraClass ?? ""}`.trim(),
				attr: { "aria-label": title, title, type: "button" },
			});
			setIcon(btn, icon);
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick(e);
			});
			return btn;
		};

		const addDivider = () => {
			container.createDiv({ cls: "mm-toolbar-divider" });
		};

		// Editing actions
		addBtn("plus-circle", "添加子节点 (Tab)", () => {
			void this.mind?.addChild();
		});
		addBtn("undo-2", "撤销 (Ctrl+Z)", () => {
			this.mind?.undo();
		});
		addBtn("redo-2", "重做 (Ctrl+Y)", () => {
			this.mind?.redo();
		});

		addDivider();

		// Obsidian integrations
		addBtn("link", "在选中节点插入双链 [[笔记]]", () => {
			this.openInsertNoteModal();
		});
		addBtn("image-plus", "在选中节点插入图片", () => {
			this.openInsertImageModal();
		});

		addDivider();

		// Layout direction
		addBtn(
			"git-compare",
			"两侧分布",
			() => this.setLayoutDirection("side"),
			"mm-dir-btn mm-dir-side"
		);
		addBtn(
			"arrow-right-from-line",
			"向右展开",
			() => this.setLayoutDirection("right"),
			"mm-dir-btn mm-dir-right"
		);
		addBtn(
			"arrow-left-from-line",
			"向左展开",
			() => this.setLayoutDirection("left"),
			"mm-dir-btn mm-dir-left"
		);
		addBtn(
			"arrow-down-from-line",
			"向下展开（组织架构图）",
			() => this.setLayoutDirection("down"),
			"mm-dir-btn mm-dir-down"
		);
		addBtn(
			"palette",
			"切换脑图样式（经典导图 / 卡片逻辑图 / 柔和卡片）",
			(evt) => this.openStylePresetMenu(evt),
			"mm-style-btn"
		);

		addDivider();

		// Viewport controls
		addBtn("zoom-out", "缩小", () => {
			if (!this.mind) return;
			this.mind.scale(Math.max(0.2, this.mind.scaleVal - 0.15));
		});
		addBtn("zoom-in", "放大", () => {
			if (!this.mind) return;
			this.mind.scale(Math.min(3, this.mind.scaleVal + 0.15));
		});
		addBtn("crosshair", "居中 (F1)", () => {
			this.mind?.toCenter();
		});
		addBtn("maximize-2", "自适应画布", () => {
			this.mind?.scaleFit();
		});
		addBtn("search", "搜索节点 (Ctrl+F)", () => {
			this.openNodeSearch();
		});

		addDivider();

		// Split view layout controls
		addBtn(
			SPLIT_LEFT_RIGHT_ICON_ID,
			"左右拆分视图（脑图 + 源码）",
			() => {
				void this.plugin.session.toggleSplitLayout(this.leaf, "left-right");
			},
			"mm-split-btn mm-split-left-right"
		);
		addBtn(
			SPLIT_TOP_BOTTOM_ICON_ID,
			"上下拆分视图（脑图 + 源码）",
			() => {
				void this.plugin.session.toggleSplitLayout(this.leaf, "top-bottom");
			},
			"mm-split-btn mm-split-top-bottom"
		);
		addBtn(
			"arrow-left-right",
			"调换左右位置（脑图 ↔ 源码）",
			() => {
				void this.plugin.session.swapSplitPositions(this.leaf);
			},
			"mm-split-swap-btn mm-is-hidden"
		);

		addDivider();

		// Export & Source switch
		addBtn("download", "导出脑图（可选格式与目录）", () => {
			this.openExportModal();
		});
		addBtn(
			"code-2",
			"切换到 Markdown 源码模式 (Ctrl+.)",
			() => {
				if (this.file) {
					void this.plugin.session.openSourceMode(this.leaf, this.file.path);
				}
			},
			"mm-switch-source-btn"
		);
	}

	private setLayoutDirection(dir: MindMapDirection): void {
		if (!this.mind) return;
		this.document.setDirection(dir);
		switch (dir) {
			case "left":
				this.mind.initLeft();
				break;
			case "right":
				this.mind.initRight();
				break;
			case "down":
				this.mind.initDown();
				break;
			case "side":
			default:
				this.mind.initSide();
				break;
		}
		this.updateDirectionButtons();
	}

	private updateDirectionButtons(): void {
		if (!this.toolbarEl) return;
		this.toolbarEl.querySelectorAll(".mm-dir-btn").forEach((el) => {
			el.removeClass("is-active");
		});
		const activeBtn = this.toolbarEl.querySelector(
			`.mm-dir-${this.document.direction}`
		);
		activeBtn?.addClass("is-active");
	}

	public openExportModal(initialFormat?: ExportFormat): void {
		if (!this.mind) return;
		const mind = this.mind;
		new ExportMindMapModal(this.app, {
			sourceFile: this.file,
			defaultFolder: this.plugin.settings.exportFolder,
			defaultScale: this.plugin.settings.exportScale,
			initialFormat,
			onConfirm: async (result) => {
				await this.exporter.exportMindMap({
					mind,
					sourceFile: this.file,
					format: result.format,
					destination: result.destination,
					vaultFolder: result.vaultFolder,
					fileName: result.fileName,
					scale: result.scale,
				});
			},
		}).open();
	}
}
