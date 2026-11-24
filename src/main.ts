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
import {
	createDefaultMindMapMarkdown,
	ensureMindMapFrontmatter,
	hasMindMapFrontmatter,
} from "./parser/markdownParser";
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
	private forceMarkdownLeaves = new WeakMap<WorkspaceLeaf, string>();
	private unpatchSetViewState: (() => void) | null = null;
	private isSwitchingView = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		addIcon(MINDMAP_ICON_ID, MINDMAP_ICON_SVG);

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

		// On initial layout ready, switch already-open mind map leaves if enabled
		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.autoOpenMindMap) return;
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.view instanceof MarkdownView && leaf.view.file) {
					const file = leaf.view.file;
					if (
						this.isMindMapFile(file) &&
						this.forceMarkdownLeaves.get(leaf) !== file.path
					) {
						void this.switchLeafToMindMap(leaf, file);
					}
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
		const fmValue = cache?.frontmatter?.[MINDMAP_FRONTMATTER_KEY];
		if (fmValue !== undefined) {
			return fmValue !== false && String(fmValue).trim() !== "";
		}
		return false;
	}

	private isMindMapMarkdownView(view: MarkdownView): boolean {
		if (!view.file) return false;
		if (this.isMindMapFile(view.file)) return true;
		return typeof view.data === "string" && hasMindMapFrontmatter(view.data);
	}

	private isMindMapFilePath(filePath: string): boolean {
		const af = this.app.vault.getAbstractFileByPath(filePath);
		if (af instanceof TFile) {
			return this.isMindMapFile(af);
		}
		return false;
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

					if (
						plugin.settings.autoOpenMindMap &&
						viewState.type === "markdown" &&
						stateFile
					) {
						const forcedPath = plugin.forceMarkdownLeaves.get(this);
						if (forcedPath && forcedPath !== stateFile) {
							plugin.forceMarkdownLeaves.delete(this);
						}

						if (
							plugin.forceMarkdownLeaves.get(this) !== stateFile &&
							plugin.isMindMapFilePath(stateFile)
						) {
							const redirected: ViewState = {
								...viewState,
								type: MINDMAP_VIEW_TYPE,
							};
							return next.call(this, redirected, eState);
						}
					} else if (viewState.type === MINDMAP_VIEW_TYPE) {
						plugin.forceMarkdownLeaves.delete(this);
					}

					return next.call(this, viewState, eState);
				};
			},
		});
	}

	async switchLeafToMarkdown(
		leaf: WorkspaceLeaf,
		file: TFile | null
	): Promise<void> {
		if (!file || this.isSwitchingView) return;
		this.isSwitchingView = true;
		try {
			const activeEl = document.activeElement as HTMLElement | null;
			if (activeEl?.id === "input-box") {
				activeEl.blur();
			}
			if (leaf.view instanceof MindMapView) {
				await leaf.view.save();
			}
			this.forceMarkdownLeaves.set(leaf, file.path);
			await leaf.setViewState({
				type: "markdown",
				state: {
					file: file.path,
					mode: "source",
				},
			});
		} finally {
			this.isSwitchingView = false;
		}
	}

	async switchLeafToMindMap(
		leaf: WorkspaceLeaf,
		file: TFile | null
	): Promise<void> {
		if (!file || this.isSwitchingView) return;
		this.isSwitchingView = true;
		try {
			if (leaf.view instanceof MarkdownView) {
				await leaf.view.save();
			}
			this.forceMarkdownLeaves.delete(leaf);
			await leaf.setViewState({
				type: MINDMAP_VIEW_TYPE,
				state: {
					file: file.path,
				},
			});
		} finally {
			this.isSwitchingView = false;
		}
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
		this.forceMarkdownLeaves.delete(leaf);
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
		const baseTitle = "新建脑图";
		let index = 0;
		while (true) {
			const title = index === 0 ? baseTitle : `${baseTitle} ${index}`;
			const fileName = `${title}.md`;
			const candidate = normalizePath(
				folderPath ? `${folderPath}/${fileName}` : fileName
			);
			if (!this.app.vault.getAbstractFileByPath(candidate)) {
				return { filePath: candidate, title };
			}
			index++;
		}
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
		// Left sidebar ribbon button
		this.addRibbonIcon(MINDMAP_ICON_ID, "新建脑图", () => {
			void this.createNewMindMap();
		});

		// Command: New mind map
		this.addCommand({
			id: "create-new-mind-map",
			name: "新建脑图 (Create new mind map)",
			callback: () => {
				void this.createNewMindMap();
			},
		});

		// Command: Toggle Mind Map / Markdown Source Mode
		this.addCommand({
			id: "toggle-mind-map-view",
			name: "切换脑图视图 / 源码模式 (Toggle Mind Map / Source Mode)",
			hotkeys: [{ modifiers: ["Mod"], key: "." }],
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf) return false;

				if (leaf.view instanceof MindMapView && leaf.view.file) {
					if (!checking) {
						void this.switchLeafToMarkdown(leaf, leaf.view.file);
					}
					return true;
				}

				if (
					leaf.view instanceof MarkdownView &&
					leaf.view.file &&
					this.isMindMapMarkdownView(leaf.view)
				) {
					if (!checking) {
						void this.switchLeafToMindMap(leaf, leaf.view.file);
					}
					return true;
				}

				return false;
			},
		});

		// Command: Convert existing Markdown note to Mind Map
		this.addCommand({
			id: "convert-note-to-mind-map",
			name: "将当前笔记转为脑图并打开 (Convert current note to Mind Map)",
			callback: () => {
				void this.convertCurrentNoteToMindMap();
			},
		});

		// Command: Export PNG
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

		// Command: Export SVG
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

		// Command: Insert wikilink into selected node
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

		// Command: Insert image into selected node
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

		// File Explorer & More Options context menus
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
		// In Windows/macOS Chinese IME inside a contenteditable Markdown editor,
		// pressing Ctrl+. may emit evt.key === "Process" or "。" with evt.code === "Period",
		// which Obsidian's built-in hotkey matcher (matching evt.key === ".") misses.
		this.registerDomEvent(
			window,
			"keydown",
			(evt: KeyboardEvent) => {
				const isModOnly =
					(evt.ctrlKey || evt.metaKey) && !evt.altKey && !evt.shiftKey;
				const isPeriod =
					evt.key === "." || evt.key === "。" || evt.code === "Period";
				if (!isModOnly || !isPeriod) return;

				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf) return;

				if (leaf.view instanceof MindMapView && leaf.view.file) {
					if (evt.repeat) {
						evt.preventDefault();
						return;
					}
					evt.preventDefault();
					evt.stopPropagation();
					void this.switchLeafToMarkdown(leaf, leaf.view.file);
					return;
				}

				if (
					leaf.view instanceof MarkdownView &&
					leaf.view.file &&
					this.isMindMapMarkdownView(leaf.view)
				) {
					if (evt.repeat) {
						evt.preventDefault();
						return;
					}
					evt.preventDefault();
					evt.stopPropagation();
					void this.switchLeafToMindMap(leaf, leaf.view.file);
				}
			},
			true
		);
	}

	private registerMarkdownHeaderToggle(): void {
		const updateHeaderButton = (leaf: WorkspaceLeaf | null) => {
			if (!leaf || !(leaf.view instanceof MarkdownView)) return;
			const view = leaf.view;
			const file = view.file;
			const actionsEl = view.containerEl.querySelector(".view-actions");
			if (!actionsEl) return;

			const existing = actionsEl.querySelector(".mm-switch-to-mindmap-action");
			const shouldShow = file ? this.isMindMapFile(file) : false;

			if (!shouldShow) {
				existing?.remove();
				return;
			}

			if (!existing && file) {
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
