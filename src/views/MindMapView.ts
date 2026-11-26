import {
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
	codeToDirection,
	directionToCode,
} from "../settings/types";
import { ExportMindMapModal } from "../modals/ExportMindMapModal";
import { NodeInlineEditor } from "../editor/NodeInlineEditor";
import { MindMapExporter } from "../export/MindMapExporter";
import type { ExportFormat } from "../export/MindMapExportPipeline";
import {
	buildCanvasKeypressOptions,
	buildCanvasTheme,
	buildContextMenuOption,
	createCanvasRelinkScheduler,
	isImageEventTarget,
	type CanvasRelinkScheduler,
} from "../canvas/canvasConfig";

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

	constructor(leaf: WorkspaceLeaf, plugin: SimpleMindMapPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.document = new MindMapDocument(plugin.settings.defaultDirection);
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
			clear,
			hasCanvas: this.mind !== null,
		});

		if (decision.action === "noop") {
			return;
		}

		if (decision.action === "mount") {
			void this.mountMindMap(decision.data);
		} else if (this.mind) {
			this.isInternalRefresh = true;
			try {
				this.mind.direction = directionToCode(decision.direction);
				this.mind.refresh(decision.data);
				this.mind.clearHistory?.();
			} finally {
				this.isInternalRefresh = false;
			}
			this.updateDirectionButtons();
		}
		this.refreshSplitButtons();
	}

	clear(): void {
		this.document.clear(this.plugin.settings.defaultDirection);
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
		this.applyCurrentTheme();
		this.mind.changeCompact(this.plugin.settings.compactMode);

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

	private destroyMindMap(): void {
		this.relinkScheduler.cancel();
		if (this.nodesResizeObserver) {
			this.nodesResizeObserver.disconnect();
			this.nodesResizeObserver = null;
		}
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
		await mind.init(data);
		this.observeNodesLayout(mind);
		this.updateDirectionButtons();

		// Wait one frame for layout metrics before linking and centering
		window.requestAnimationFrame(() => {
			if (this.mind === mind) {
				if (this.isCanvasLayoutReady()) {
					mind.linkDiv();
				}
				mind.toCenter();
			}
		});

		mind.bus.addListener("operation", (op) => {
			if (this.isInternalRefresh) return;
			if (op.name === "beginEdit") {
				queueMicrotask(() =>
					this.inlineEditor.onBeginNodeEdit(mind, op.target.id)
				);
				return;
			}
			this.markLocalEditAndScheduleSave();
		});

		mind.bus.addListener("changeDirection", (dir) => {
			if (this.isInternalRefresh) return;
			this.document.setDirection(codeToDirection(dir));
			this.updateDirectionButtons();
			this.markLocalEditAndScheduleSave();
		});

		mind.bus.addListener("refresh", () => {
			if (this.isInternalRefresh) return;
			this.markLocalEditAndScheduleSave();
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
			(name) => styles.getPropertyValue(name)
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
			onClick: () => void,
			extraClass?: string
		): HTMLButtonElement => {
			const btn = container.createEl("button", {
				cls: `mm-toolbar-btn ${extraClass ?? ""}`.trim(),
				attr: { "aria-label": title, title, type: "button" },
			});
			setIcon(btn, icon);
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick();
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
