import {
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	TFolder,
	WorkspaceLeaf,
	addIcon,
	normalizePath,
	setIcon,
	type ViewState,
} from "obsidian";
import { around } from "monkey-around";
import { allocateUniqueVaultPath } from "./vault/vaultPaths";
import {
	createDefaultMindMapMarkdown,
	ensureMindMapFrontmatter,
	hasMindMapFrontmatter,
	isMindMapFrontmatterValue,
} from "./parser/markdownParser";
import {
	WorkspaceSession,
	isImePeriodToggleShortcut,
	type LeafRect,
	type LeafSnapshot,
	type ViewStateTarget,
} from "./session/WorkspaceSession";
import { NewMindMapModal } from "./modals/NewMindMapModal";
import { MindMapSettingTab } from "./settings/SettingsTab";
import {
	DEFAULT_HOTKEYS,
	DEFAULT_SETTINGS,
	MINDMAP_FRONTMATTER_KEY,
	MINDMAP_ICON_ID,
	MINDMAP_ICON_SVG,
	MINDMAP_VIEW_TYPE,
	SPLIT_LEFT_RIGHT_ICON_ID,
	SPLIT_LEFT_RIGHT_ICON_SVG,
	SPLIT_TOP_BOTTOM_ICON_ID,
	SPLIT_TOP_BOTTOM_ICON_SVG,
	type MindMapDirection,
	type MindMapSettings,
	type MindMapStylePreset,
} from "./settings/types";
import { MindMapView } from "./views/MindMapView";

export default class SimpleMindMapPlugin extends Plugin {
	settings: MindMapSettings = DEFAULT_SETTINGS;
	session!: WorkspaceSession<WorkspaceLeaf>;
	private unpatchSetViewState: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		addIcon(MINDMAP_ICON_ID, MINDMAP_ICON_SVG);
		addIcon(SPLIT_LEFT_RIGHT_ICON_ID, SPLIT_LEFT_RIGHT_ICON_SVG);
		addIcon(SPLIT_TOP_BOTTOM_ICON_ID, SPLIT_TOP_BOTTOM_ICON_SVG);

		this.session = this.createWorkspaceSession();

		this.registerView(
			MINDMAP_VIEW_TYPE,
			(leaf) => new MindMapView(leaf, this)
		);

		this.registerHoverLinkSource(MINDMAP_VIEW_TYPE, {
			display: "Pure Mind Map",
			defaultMod: false,
		});

		this.installViewStateInterceptor();
		this.registerCommandsAndMenus();
		this.registerImePeriodFallback();
		this.registerWorkspaceListeners();

		this.addSettingTab(new MindMapSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			void this.session.restoreOnLayoutReady();
		});
	}

	onunload(): void {
		if (this.unpatchSetViewState) {
			this.unpatchSetViewState();
			this.unpatchSetViewState = null;
		}
		this.session?.dispose();
		this.removeMarkdownHeaderButtons();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<MindMapSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			hotkeys: {
				...DEFAULT_HOTKEYS,
				...(saved?.hotkeys ?? {}),
			},
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	refreshOpenMindMaps(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MindMapView) {
				leaf.view.refreshFromSettings();
			}
		});
	}

	isMindMapFile(file: TFile | null): boolean {
		if (!file || file.extension !== "md") return false;
		const cache = this.app.metadataCache.getFileCache(file);
		return isMindMapFrontmatterValue(
			cache?.frontmatter?.[MINDMAP_FRONTMATTER_KEY]
		);
	}

	public openSplitViewMenu(leaf: WorkspaceLeaf, evt: MouseEvent): void {
		const state = this.session.getSplitState(leaf);
		const menu = new Menu();

		menu.addItem((item) => {
			item
				.setTitle("左右拆分视图（脑图 + 源码）")
				.setIcon(SPLIT_LEFT_RIGHT_ICON_ID)
				.setChecked(state.isActive && state.layout === "left-right")
				.onClick(() => {
					void this.session.openOrSwitchSplit(leaf, "left-right");
				});
		});

		menu.addItem((item) => {
			item
				.setTitle("上下拆分视图（脑图 + 源码）")
				.setIcon(SPLIT_TOP_BOTTOM_ICON_ID)
				.setChecked(state.isActive && state.layout === "top-bottom")
				.onClick(() => {
					void this.session.openOrSwitchSplit(leaf, "top-bottom");
				});
		});

		if (state.isActive) {
			menu.addSeparator();
			const swapIcon =
				state.layout === "top-bottom" ? "arrow-up-down" : "arrow-left-right";
			const swapTitle =
				state.layout === "top-bottom"
					? "调换上下位置（脑图 ↔ 源码）"
					: "调换左右位置（脑图 ↔ 源码）";
			menu.addItem((item) => {
				item
					.setTitle(swapTitle)
					.setIcon(swapIcon)
					.onClick(() => {
						void this.session.swapSplitPositions(leaf);
					});
			});
			menu.addItem((item) => {
				item
					.setTitle("关闭拆分视图")
					.setIcon("x")
					.onClick(() => {
						void this.session.closeSplit(leaf);
					});
			});
		}

		menu.showAtMouseEvent(evt);
	}

	private createWorkspaceSession(): WorkspaceSession<WorkspaceLeaf> {
		return new WorkspaceSession<WorkspaceLeaf>({
			isAutoOpenEnabled: () => this.settings.autoOpenMindMap,
			isLayoutReady: () => this.app.workspace.layoutReady,
			getDefaultSplitLayout: () => this.settings.defaultSplitLayout,
			isMindMapPath: (filePath) => {
				const af = this.app.vault.getAbstractFileByPath(filePath);
				return af instanceof TFile ? this.isMindMapFile(af) : false;
			},
			getAllLeaves: () => {
				const leaves: WorkspaceLeaf[] = [];
				this.app.workspace.iterateAllLeaves((leaf) => {
					leaves.push(leaf);
				});
				return leaves;
			},
			getActiveLeaf: () => this.app.workspace.getMostRecentLeaf(),
			inspectLeaf: (leaf): LeafSnapshot | null => {
				if (leaf.view instanceof MindMapView) {
					return {
						kind: "mindmap",
						filePath: leaf.view.file?.path ?? null,
					};
				}
				if (leaf.view instanceof MarkdownView) {
					return {
						kind: "markdown",
						filePath: leaf.view.file?.path ?? null,
						rawMarkdown: leaf.view.data,
					};
				}
				// Recognize deferred Mind Map tabs (Obsidian 1.7+) before hydration
				const viewState = leaf.getViewState();
				const stateFile =
					typeof viewState?.state?.file === "string"
						? viewState.state.file
						: null;
				if (viewState.type === MINDMAP_VIEW_TYPE && stateFile) {
					return {
						kind: "mindmap",
						filePath: stateFile,
					};
				}
				return { kind: "other", filePath: null };
			},
			getLeafRect: (leaf): LeafRect | null => {
				const el = leaf.view?.containerEl;
				if (!el) return null;
				const rect = el.getBoundingClientRect();
				return {
					left: rect.left,
					top: rect.top,
					width: rect.width,
					height: rect.height,
				};
			},
			commitLeafEdit: (leaf) => {
				if (leaf.view instanceof MindMapView) {
					leaf.view.commitActiveEdit();
				}
			},
			readLeafMarkdown: (leaf) => {
				if (leaf.view instanceof MindMapView) {
					return leaf.view.getViewData();
				}
				if (leaf.view instanceof MarkdownView) {
					return leaf.view.getViewData();
				}
				return null;
			},
			applyMarkdownToMindMapLeaf: (leaf, markdown) => {
				if (leaf.view instanceof MindMapView) {
					leaf.view.syncFromExternalMarkdown(markdown);
				}
			},
			applyMarkdownToSourceLeaf: (leaf, markdown) => {
				if (
					leaf.view instanceof MarkdownView &&
					leaf.view.getViewData() !== markdown
				) {
					leaf.view.setViewData(markdown, false);
				}
			},
			saveLeaf: async (leaf, onlyIfDirty = false) => {
				if (leaf.view instanceof MindMapView) {
					if (!onlyIfDirty || leaf.view.hasPendingLocalEdits()) {
						await leaf.view.save();
					}
				} else if (leaf.view instanceof MarkdownView) {
					await leaf.view.save();
				}
			},
			applyViewState: async (leaf, target: ViewStateTarget) => {
				if (target.type === "markdown") {
					await leaf.setViewState({
						type: "markdown",
						state: {
							file: target.filePath,
							mode: target.mode,
						},
					});
				} else {
					await leaf.setViewState({
						type: MINDMAP_VIEW_TYPE,
						active: target.active,
						state: {
							file: target.filePath,
						},
					});
				}
			},
			createSplitLeaf: (originLeaf, direction) =>
				this.app.workspace.createLeafBySplit(originLeaf, direction, false),
			detachLeaf: (leaf) => {
				leaf.detach();
			},
			focusLeaf: (leaf) => {
				this.app.workspace.setActiveLeaf(leaf, { focus: true });
			},
			recenterMindMapLeaf: (leaf) => {
				if (leaf.view instanceof MindMapView) {
					leaf.view.recenterCanvas();
				}
			},
			refreshUi: () => {
				this.refreshSplitUi();
			},
			scheduleTimer: (fn, delayMs) => window.setTimeout(fn, delayMs),
			cancelTimer: (handle) => window.clearTimeout(Number(handle)),
		});
	}

	private installViewStateInterceptor(): void {
		const { session } = this;
		this.unpatchSetViewState = around(WorkspaceLeaf.prototype, {
			setViewState(next) {
				return function (
					this: WorkspaceLeaf,
					viewState: ViewState,
					eState?: unknown
				): Promise<void> {
					const stateFile =
						typeof viewState?.state?.file === "string"
							? viewState.state.file
							: null;
					const stateMode =
						typeof viewState?.state?.mode === "string"
							? viewState.state.mode
							: null;
					const resolvedType = session.resolveIncomingViewType(
						this,
						viewState.type,
						stateFile,
						stateMode
					);
					const nextState =
						resolvedType !== viewState.type
							? { ...viewState, type: resolvedType }
							: viewState;
					return Promise.resolve(next.call(this, nextState, eState));
				};
			},
		});
	}

	private registerWorkspaceListeners(): void {
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, info) => {
				const filePath = info.file?.path;
				if (!filePath) return;
				this.session.onSourceEditorChange(filePath, editor.getValue());
			})
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.session.onActiveLeafChange(leaf);
			})
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.session.onLayoutChange();
			})
		);

		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.updateMarkdownHeaderActions(this.app.workspace.getMostRecentLeaf());
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.app.workspace.iterateAllLeaves((leaf) => {
					if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
						this.updateMarkdownHeaderActions(leaf);
					}
				});
			})
		);
	}

	private refreshSplitUi(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MindMapView) {
				leaf.view.refreshSplitButtons();
			} else if (leaf.view instanceof MarkdownView) {
				this.updateMarkdownHeaderActions(leaf);
			}
		});
	}

	async createNewMindMap(
		folder?: TFolder | null,
		overrides?: {
			title?: string;
			folderPath?: string;
			direction?: MindMapDirection;
			stylePreset?: MindMapStylePreset;
		}
	): Promise<void> {
		const targetFolderPath =
			overrides?.folderPath !== undefined
				? overrides.folderPath.trim()
				: this.resolveNewMindMapFolder(folder);
		if (targetFolderPath) {
			const normalized = normalizePath(targetFolderPath);
			if (!this.app.vault.getAbstractFileByPath(normalized)) {
				await this.app.vault.createFolder(normalized);
			}
		}

		const { filePath, title } = this.generateUniqueMindMapPath(
			targetFolderPath,
			overrides?.title
		);
		const initialContent = createDefaultMindMapMarkdown(
			title,
			overrides?.direction ?? this.settings.defaultDirection,
			this.settings.markdownStyle,
			overrides?.stylePreset ?? this.settings.defaultStylePreset
		);

		const createdFile = await this.app.vault.create(filePath, initialContent);
		const leaf = this.app.workspace.getLeaf(false);
		await this.session.openMindMap(leaf, createdFile.path, { focus: true });
	}

	public openNewMindMapModal(folder?: TFolder | null): void {
		const defaultFolder = this.resolveNewMindMapFolder(folder);
		new NewMindMapModal(this.app, {
			defaultTitle: "新建脑图",
			defaultFolder,
			defaultDirection: this.settings.defaultDirection,
			defaultStylePreset: this.settings.defaultStylePreset,
			onConfirm: async (result) => {
				await this.createNewMindMap(null, {
					title: result.title,
					folderPath: result.folder,
					direction: result.direction,
					stylePreset: result.stylePreset,
				});
			},
		}).open();
	}

	private resolveNewMindMapFolder(explicitFolder?: TFolder | null): string {
		if (explicitFolder) {
			return explicitFolder.isRoot() ? "" : explicitFolder.path;
		}
		if (this.settings.defaultNewFolder.trim()) {
			return this.settings.defaultNewFolder.trim();
		}
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile?.parent && !activeFile.parent.isRoot()) {
			return activeFile.parent.path;
		}
		return "";
	}

	private generateUniqueMindMapPath(
		folderPath: string,
		baseName = "新建脑图"
	): {
		filePath: string;
		title: string;
	} {
		const allocated = allocateUniqueVaultPath({
			folder: folderPath,
			baseName: baseName.trim() || "新建脑图",
			extension: "md",
			separator: " ",
			exists: (candidate) =>
				Boolean(this.app.vault.getAbstractFileByPath(normalizePath(candidate))),
		});
		return {
			filePath: normalizePath(allocated.filePath),
			title: allocated.title,
		};
	}

	private async convertCurrentNoteToMindMap(): Promise<void> {
		const leaf = this.app.workspace.getMostRecentLeaf();
		const activeFile = this.app.workspace.getActiveFile();
		if (!leaf || !activeFile || activeFile.extension !== "md") {
			new Notice("请先打开一个 Markdown 笔记");
			return;
		}

		const content = await this.app.vault.read(activeFile);
		if (!hasMindMapFrontmatter(content)) {
			const updated = ensureMindMapFrontmatter(
				content,
				this.settings.defaultDirection
			);
			await this.app.vault.modify(activeFile, updated);
		}
		await this.session.openMindMap(leaf, activeFile.path);
	}

	private registerCommandsAndMenus(): void {
		this.addRibbonIcon(MINDMAP_ICON_ID, "新建脑图", () => {
			this.openNewMindMapModal();
		});

		this.addCommand({
			id: "create-new-mind-map",
			name: "新建脑图 (Create new mind map)",
			callback: () => {
				this.openNewMindMapModal();
			},
		});

		this.addCommand({
			id: "toggle-mind-map-view",
			name: "切换脑图视图 / 源码模式 (Toggle Mind Map / Source Mode)",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf || !this.session.canToggleViewMode(leaf)) return false;
				if (!checking) {
					void this.session.toggleViewMode(leaf);
				}
				return true;
			},
		});

		this.addCommand({
			id: "toggle-split-view",
			name: "切换拆分视图（脑图 + 源码） (Toggle Split View)",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf || !this.session.canSplit(leaf)) return false;
				if (!checking) {
					void this.session.toggleSplit(leaf);
				}
				return true;
			},
		});

		this.addCommand({
			id: "split-view-left-right",
			name: "左右拆分视图（脑图 + 源码） (Split View: Left-Right)",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf || !this.session.canSplit(leaf)) return false;
				if (!checking) {
					void this.session.openOrSwitchSplit(leaf, "left-right");
				}
				return true;
			},
		});

		this.addCommand({
			id: "split-view-top-bottom",
			name: "上下拆分视图（脑图 + 源码） (Split View: Top-Bottom)",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf || !this.session.canSplit(leaf)) return false;
				if (!checking) {
					void this.session.openOrSwitchSplit(leaf, "top-bottom");
				}
				return true;
			},
		});

		this.addCommand({
			id: "switch-split-view-layout",
			name: "切换拆分视图布局（左右 / 上下） (Switch Split View Layout)",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf || !this.session.canSplit(leaf)) return false;
				if (!checking) {
					void this.session.flipSplitLayout(leaf);
				}
				return true;
			},
		});

		this.addCommand({
			id: "swap-split-view-positions",
			name: "调换拆分视图位置（脑图 ↔ 源码） (Swap Split View Positions)",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf || !this.session.getSplitState(leaf).isActive) {
					return false;
				}
				if (!checking) {
					void this.session.swapSplitPositions(leaf);
				}
				return true;
			},
		});

		this.addCommand({
			id: "close-split-view",
			name: "关闭拆分视图 (Close Split View)",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf || !this.session.getSplitState(leaf).isActive) {
					return false;
				}
				if (!checking) {
					void this.session.closeSplit(leaf);
				}
				return true;
			},
		});

		this.addCommand({
			id: "convert-note-to-mind-map",
			name: "将当前笔记转为脑图并打开 (Convert current note to Mind Map)",
			callback: () => {
				void this.convertCurrentNoteToMindMap();
			},
		});

		this.addCommand({
			id: "export-mind-map",
			name: "导出当前脑图（选择格式与目录） (Export Mind Map...)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MindMapView);
				if (!view) return false;
				if (!checking) {
					view.openExportModal();
				}
				return true;
			},
		});

		this.addCommand({
			id: "export-mind-map-png",
			name: "导出当前脑图为 PNG 图片 (Export Mind Map as PNG)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MindMapView);
				if (!view) return false;
				if (!checking) {
					view.openExportModal("png");
				}
				return true;
			},
		});

		this.addCommand({
			id: "export-mind-map-svg",
			name: "导出当前脑图为 SVG 图片 (Export Mind Map as SVG)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MindMapView);
				if (!view) return false;
				if (!checking) {
					view.openExportModal("svg");
				}
				return true;
			},
		});

		this.addCommand({
			id: "insert-wikilink-node",
			name: "在选中节点插入双链笔记 (Insert wikilink into selected node)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MindMapView);
				if (!view) return false;
				if (!checking) {
					view.openInsertNoteModal();
				}
				return true;
			},
		});

		this.addCommand({
			id: "insert-image-node",
			name: "在选中节点插入库内图片 (Insert vault image into selected node)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MindMapView);
				if (!view) return false;
				if (!checking) {
					view.openInsertImageModal();
				}
				return true;
			},
		});

		this.addCommand({
			id: "search-mind-map-nodes",
			name: "在当前脑图中搜索节点 (Find nodes in Mind Map)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MindMapView);
				if (!view) return false;
				if (!checking) {
					view.openNodeSearch();
				}
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item
							.setTitle("新建脑图")
							.setIcon(MINDMAP_ICON_ID)
							.onClick(() => {
								this.openNewMindMapModal(file);
							});
					});
				} else if (file instanceof TFile && file.extension === "md") {
					const menuAction = this.session.getFileMenuOpenAction(file.path);
					if (menuAction.action === "open-source") {
						menu.addItem((item) => {
							item
								.setTitle("以 Markdown 源码打开")
								.setIcon("code-2")
								.onClick(() => {
									const leaf =
										menuAction.targetLeaf ?? this.app.workspace.getLeaf(false);
									void this.session.openSourceMode(leaf, file.path, {
										focus: true,
									});
								});
						});
					} else if (menuAction.action === "open-mindmap") {
						menu.addItem((item) => {
							item
								.setTitle("以脑图视图打开")
								.setIcon(MINDMAP_ICON_ID)
								.onClick(() => {
									const leaf =
										menuAction.targetLeaf ?? this.app.workspace.getLeaf(false);
									void this.session.openMindMap(leaf, file.path, {
										focus: true,
									});
								});
						});
					}
				}
			})
		);
	}

	private registerImePeriodFallback(): void {
		this.registerDomEvent(
			window,
			"keydown",
			(evt: KeyboardEvent) => {
				if (!isImePeriodToggleShortcut(evt)) return;

				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf || !this.session.canToggleViewMode(leaf)) return;

				evt.preventDefault();
				if (evt.repeat) return;
				evt.stopPropagation();
				void this.session.toggleViewMode(leaf);
			},
			true
		);
	}

	private updateMarkdownHeaderActions(leaf: WorkspaceLeaf | null): void {
		if (!leaf || !(leaf.view instanceof MarkdownView)) return;
		const view = leaf.view;
		const actionsEl = view.containerEl.querySelector(".view-actions");
		if (!actionsEl) return;

		const existingToggle = actionsEl.querySelector(".mm-switch-to-mindmap-action");
		const existingSplit = actionsEl.querySelector<HTMLElement>(
			".mm-split-view-action"
		);
		const existingSwap = actionsEl.querySelector<HTMLElement>(
			".mm-swap-split-action"
		);
		const shouldShow = this.session.isMarkdownMindMapLeaf(leaf);

		if (!shouldShow) {
			existingToggle?.remove();
			existingSplit?.remove();
			existingSwap?.remove();
			return;
		}

		const splitState = this.session.getSplitState(leaf);
		const splitIcon =
			splitState.isActive && splitState.layout === "top-bottom"
				? SPLIT_TOP_BOTTOM_ICON_ID
				: SPLIT_LEFT_RIGHT_ICON_ID;

		let splitBtn = existingSplit;
		if (!splitBtn) {
			splitBtn = view.addAction(
				splitIcon,
				"拆分视图（脑图 + 源码）",
				(evt) => {
					this.openSplitViewMenu(leaf, evt);
				}
			);
			splitBtn.addClass("mm-split-view-action");
		} else {
			setIcon(splitBtn, splitIcon);
		}
		splitBtn.toggleClass("is-active", splitState.isActive);

		if (splitState.isActive) {
			// Single-pane mode switching is disallowed while Split View is active; offer swap instead
			existingToggle?.remove();
			const swapIcon =
				splitState.layout === "top-bottom"
					? "arrow-up-down"
					: "arrow-left-right";
			const swapTitle =
				splitState.layout === "top-bottom"
					? "调换上下位置（脑图 ↔ 源码）"
					: "调换左右位置（脑图 ↔ 源码）";

			let swapBtn = existingSwap;
			if (!swapBtn) {
				swapBtn = view.addAction(swapIcon, swapTitle, () => {
					void this.session.swapSplitPositions(leaf);
				});
				swapBtn.addClass("mm-swap-split-action");
			} else {
				setIcon(swapBtn, swapIcon);
				swapBtn.setAttribute("aria-label", swapTitle);
				swapBtn.setAttribute("title", swapTitle);
			}
		} else {
			existingSwap?.remove();
			if (!existingToggle) {
				const actionBtn = view.addAction(
					MINDMAP_ICON_ID,
					"切换回脑图视图 (Ctrl+.)",
					() => {
						if (view.file) {
							void this.session.openMindMap(leaf, view.file.path);
						}
					}
				);
				actionBtn.addClass("mm-switch-to-mindmap-action");
			}
		}
	}

	private removeMarkdownHeaderButtons(): void {
		activeDocument
			.querySelectorAll(
				".mm-switch-to-mindmap-action, .mm-split-view-action, .mm-swap-split-action"
			)
			.forEach((el) => el.remove());
	}
}
