import {
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	TFolder,
	WorkspaceLeaf,
	addIcon,
	normalizePath,
	type ViewState,
} from "obsidian";
import { around } from "monkey-around";
import { allocateUniqueVaultPath } from "./export/exporterCore";
import {
	createDefaultMindMapMarkdown,
	ensureMindMapFrontmatter,
	hasMindMapFrontmatter,
	isMindMapFrontmatterValue,
} from "./parser/markdownParser";
import {
	ViewModeRouter,
	isImePeriodToggleShortcut,
	type LeafSnapshot,
	type ViewStateTarget,
} from "./routing/ViewModeRouter";
import { MindMapSettingTab } from "./settings/SettingsTab";
import {
	DEFAULT_HOTKEYS,
	DEFAULT_SETTINGS,
	MINDMAP_FRONTMATTER_KEY,
	MINDMAP_ICON_ID,
	MINDMAP_ICON_SVG,
	MINDMAP_VIEW_TYPE,
	type MindMapSettings,
} from "./settings/types";
import { MindMapView } from "./views/MindMapView";

export default class SimpleMindMapPlugin extends Plugin {
	settings: MindMapSettings = DEFAULT_SETTINGS;
	private router!: ViewModeRouter<WorkspaceLeaf>;
	private unpatchSetViewState: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		addIcon(MINDMAP_ICON_ID, MINDMAP_ICON_SVG);

		this.router = this.createViewModeRouter();

		this.registerView(
			MINDMAP_VIEW_TYPE,
			(leaf) => new MindMapView(leaf, this)
		);

		this.registerHoverLinkSource(MINDMAP_VIEW_TYPE, {
			display: "Simple Obsidian Mind Map",
			defaultMod: false,
		});

		this.installViewStateInterceptor();
		this.registerCommandsAndMenus();
		this.registerImePeriodFallback();
		this.registerMarkdownHeaderToggle();

		this.addSettingTab(new MindMapSettingTab(this.app, this));

		// On initial layout ready, switch already-open Mind Map Notes if enabled
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves((leaf) => {
				const filePath = this.router.shouldAutoOpenOnLayoutReady(leaf);
				if (filePath) {
					void this.router.switchToMindMap(leaf, filePath);
				}
			});
		});
	}

	onunload(): void {
		if (this.unpatchSetViewState) {
			this.unpatchSetViewState();
			this.unpatchSetViewState = null;
		}
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

	async switchLeafToMarkdown(
		leaf: WorkspaceLeaf,
		file: TFile | null
	): Promise<void> {
		if (!file) return;
		await this.router.switchToSourceMode(leaf, file.path);
	}

	async switchLeafToMindMap(
		leaf: WorkspaceLeaf,
		file: TFile | null
	): Promise<void> {
		if (!file) return;
		await this.router.switchToMindMap(leaf, file.path);
	}

	private createViewModeRouter(): ViewModeRouter<WorkspaceLeaf> {
		return new ViewModeRouter<WorkspaceLeaf>({
			isAutoOpenEnabled: () => this.settings.autoOpenMindMap,
			isMindMapPath: (filePath) => {
				const af = this.app.vault.getAbstractFileByPath(filePath);
				return af instanceof TFile ? this.isMindMapFile(af) : false;
			},
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
				return { kind: "other", filePath: null };
			},
			prepareForSwitch: async (leaf, currentKind) => {
				if (currentKind === "mindmap" && leaf.view instanceof MindMapView) {
					leaf.view.commitActiveEdit();
					await leaf.view.save();
				} else if (
					currentKind === "markdown" &&
					leaf.view instanceof MarkdownView
				) {
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
						state: {
							file: target.filePath,
						},
					});
				}
			},
		});
	}

	private installViewStateInterceptor(): void {
		const plugin = this;
		this.unpatchSetViewState = around(WorkspaceLeaf.prototype, {
			setViewState(next) {
				return function (
					this: WorkspaceLeaf,
					viewState: ViewState,
					eState?: unknown
				) {
					const stateFile =
						typeof viewState?.state?.file === "string"
							? viewState.state.file
							: null;
					const resolvedType = plugin.router.resolveIncomingViewType(
						this,
						viewState.type,
						stateFile
					);
					if (resolvedType !== viewState.type) {
						return next.call(
							this,
							{ ...viewState, type: resolvedType },
							eState
						);
					}
					return next.call(this, viewState, eState);
				};
			},
		});
	}

	async createNewMindMap(folder?: TFolder | null): Promise<void> {
		const targetFolderPath = this.resolveNewMindMapFolder(folder);
		if (targetFolderPath) {
			const normalized = normalizePath(targetFolderPath);
			if (!this.app.vault.getAbstractFileByPath(normalized)) {
				await this.app.vault.createFolder(normalized);
			}
		}

		const { filePath, title } = this.generateUniqueMindMapPath(targetFolderPath);
		const initialContent = createDefaultMindMapMarkdown(
			title,
			this.settings.defaultDirection,
			this.settings.markdownStyle
		);

		const createdFile = await this.app.vault.create(filePath, initialContent);
		const leaf = this.app.workspace.getLeaf(false);
		this.router.clearOverride(leaf);
		await leaf.setViewState({
			type: MINDMAP_VIEW_TYPE,
			active: true,
			state: {
				file: createdFile.path,
			},
		});
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
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

	private generateUniqueMindMapPath(folderPath: string): {
		filePath: string;
		title: string;
	} {
		const allocated = allocateUniqueVaultPath({
			folder: folderPath,
			baseName: "新建脑图",
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
		await this.switchLeafToMindMap(leaf, activeFile);
	}

	private registerCommandsAndMenus(): void {
		this.addRibbonIcon(MINDMAP_ICON_ID, "新建脑图", () => {
			void this.createNewMindMap();
		});

		this.addCommand({
			id: "create-new-mind-map",
			name: "新建脑图 (Create new mind map)",
			callback: () => {
				void this.createNewMindMap();
			},
		});

		this.addCommand({
			id: "toggle-mind-map-view",
			name: "切换脑图视图 / 源码模式 (Toggle Mind Map / Source Mode)",
			hotkeys: [{ modifiers: ["Mod"], key: "." }],
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf || !this.router.canToggleLeaf(leaf)) return false;
				if (!checking) {
					void this.router.toggleLeaf(leaf);
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
			id: "export-mind-map-png",
			name: "导出当前脑图为 PNG 图片 (Export Mind Map as PNG)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MindMapView);
				if (!view) return false;
				if (!checking) {
					void view.exportAsPng();
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
					void view.exportAsSvg();
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

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item
							.setTitle("新建脑图")
							.setIcon(MINDMAP_ICON_ID)
							.onClick(() => {
								void this.createNewMindMap(file);
							});
					});
				} else if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) => {
						item
							.setTitle("以脑图视图打开")
							.setIcon(MINDMAP_ICON_ID)
							.onClick(() => {
								const leaf = this.app.workspace.getLeaf(false);
								void this.switchLeafToMindMap(leaf, file);
							});
					});
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
				if (!leaf || !this.router.canToggleLeaf(leaf)) return;

				evt.preventDefault();
				if (evt.repeat) return;
				evt.stopPropagation();
				void this.router.toggleLeaf(leaf);
			},
			true
		);
	}

	private registerMarkdownHeaderToggle(): void {
		const updateHeaderButton = (leaf: WorkspaceLeaf | null) => {
			if (!leaf || !(leaf.view instanceof MarkdownView)) return;
			const view = leaf.view;
			const actionsEl = view.containerEl.querySelector(".view-actions");
			if (!actionsEl) return;

			const existing = actionsEl.querySelector(".mm-switch-to-mindmap-action");
			const shouldShow = this.router.isMarkdownMindMapLeaf(leaf);

			if (!shouldShow) {
				existing?.remove();
				return;
			}

			if (!existing) {
				const actionBtn = view.addAction(
					MINDMAP_ICON_ID,
					"切换回脑图视图 (Ctrl+.)",
					() => {
						void this.switchLeafToMindMap(leaf, view.file);
					}
				);
				actionBtn.addClass("mm-switch-to-mindmap-action");
			}
		};

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				updateHeaderButton(leaf);
			})
		);

		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				updateHeaderButton(this.app.workspace.getMostRecentLeaf());
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.app.workspace.iterateAllLeaves((leaf) => {
					if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
						updateHeaderButton(leaf);
					}
				});
			})
		);
	}

	private removeMarkdownHeaderButtons(): void {
		document
			.querySelectorAll(".mm-switch-to-mindmap-action")
			.forEach((el) => el.remove());
	}
}
