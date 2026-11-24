import {
	Menu,
	Notice,
	TextFileView,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
	type TFile,
} from "obsidian";
import MindElixir, {
	DARK_THEME,
	THEME,
	type KeypressOptions,
	type MindElixirData,
	type Theme,
	type Topic,
} from "mind-elixir";
import { exportImageBlob } from "@mind-elixir/export-mindmap";
import type SimpleMindMapPlugin from "../main";
import {
	markdownToMindMap,
	mindMapToMarkdown,
	renderNodeMarkdown,
} from "../parser/markdownParser";
import {
	MINDMAP_ICON_ID,
	MINDMAP_VIEW_TYPE,
	type MindMapDirection,
	codeToDirection,
	directionToCode,
} from "../settings/types";
import { ImageSuggestModal, NoteLinkSuggestModal } from "../modals/VaultSuggestModals";
import { InlineLinkSuggester } from "./InlineLinkSuggester";

export class MindMapView extends TextFileView {
	private plugin: SimpleMindMapPlugin;
	private mind: MindElixir | null = null;
	private mapHostEl: HTMLElement | null = null;
	private toolbarEl: HTMLElement | null = null;
	private existingFrontmatterRaw: string | null = null;
	private currentDirection: MindMapDirection = "side";
	private lastSavedMarkdown = "";
	private pendingData: MindElixirData | null = null;
	private isInternalRefresh = false;
	private linkSuggester: InlineLinkSuggester;

	constructor(leaf: WorkspaceLeaf, plugin: SimpleMindMapPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.currentDirection = plugin.settings.defaultDirection;
		this.linkSuggester = new InlineLinkSuggester(this.app, {
			getSourcePath: () => this.file?.path ?? "",
			getSelectionOffsets: (el) => this.getSelectionOffsets(el),
			setSelectionOffsets: (el, start, end) =>
				this.setSelectionOffsets(el, start, end),
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

		this.addAction("code-2", "切换到 Markdown 源码模式 (Ctrl+.)", () => {
			void this.plugin.switchLeafToMarkdown(this.leaf, this.file);
		});
		this.addAction("image", "导出为 PNG 图片", () => {
			void this.exportAsPng();
		});
		this.addAction("file-code", "导出为 SVG 图片", () => {
			void this.exportAsSvg();
		});

		this.toolbarEl = this.contentEl.createDiv({ cls: "mm-floating-toolbar" });
		this.buildToolbar(this.toolbarEl);

		this.mapHostEl = this.contentEl.createDiv({ cls: "mm-canvas-host" });
		this.registerDomEvent(this.mapHostEl, "click", (evt) => this.handleCanvasClick(evt), true);
		this.registerDomEvent(this.mapHostEl, "mouseover", (evt) => this.handleCanvasHover(evt));
		this.registerDomEvent(
			this.mapHostEl,
			"contextmenu",
			(evt) => this.handleCanvasContextMenu(evt),
			true
		);
		this.registerDomEvent(
			this.mapHostEl,
			"keydown",
			(evt) => {
				this.linkSuggester.handleKeyDown(evt);
			},
			true
		);

		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				this.applyCurrentTheme();
			})
		);
	}

	async onClose(): Promise<void> {
		this.destroyMindMap();
	}

	getViewData(): string {
		if (!this.mind) {
			return this.data ?? "";
		}
		const data = this.mind.getData();
		const markdown = mindMapToMarkdown(data, {
			existingFrontmatterRaw: this.existingFrontmatterRaw,
			style: this.plugin.settings.markdownStyle,
			direction: this.currentDirection,
		});
		this.lastSavedMarkdown = markdown;
		return markdown;
	}

	setViewData(data: string, clear: boolean): void {
		this.data = data;

		// Skip redundant re-renders triggered by our own save cycle
		if (!clear && this.mind && data === this.lastSavedMarkdown) {
			return;
		}

		const fallbackTitle = this.file?.basename ?? "中心主题";
		const parsed = markdownToMindMap(data, fallbackTitle);
		this.existingFrontmatterRaw = parsed.frontmatter.raw;
		this.currentDirection =
			parsed.frontmatter.properties["mindmap-direction"]
				? parsed.direction
				: this.plugin.settings.defaultDirection;
		parsed.data.direction = directionToCode(this.currentDirection);

		this.lastSavedMarkdown = data;
		this.pendingData = parsed.data;

		if (clear || !this.mind) {
			void this.mountMindMap(parsed.data);
		} else {
			this.isInternalRefresh = true;
			try {
				this.mind.direction = directionToCode(this.currentDirection);
				this.mind.refresh(parsed.data);
				this.mind.clearHistory?.();
			} finally {
				this.isInternalRefresh = false;
			}
			this.updateDirectionButtons();
		}
	}

	clear(): void {
		this.lastSavedMarkdown = "";
		this.existingFrontmatterRaw = null;
		this.pendingData = null;
		this.destroyMindMap();
	}

	public refreshFromSettings(): void {
		if (!this.mind) return;
		this.applyCurrentTheme();
		this.mind.changeCompact(this.plugin.settings.compactMode);
		// Re-mount if hotkeys changed so keypress bindings update cleanly
		const currentData = this.mind.getData();
		void this.mountMindMap(currentData);
	}

	public openInsertNoteModal(): void {
		if (!this.mind) return;
		const selected = this.mind.currentNode;
		if (!selected) {
			new Notice("请先在脑图中选中一个节点");
			return;
		}
		new NoteLinkSuggestModal(this.app, (file) => {
			const linkText = this.app.fileManager.generateMarkdownLink(
				file,
				this.file?.path ?? ""
			);
			const currentTopic = selected.nodeObj.topic;
			const nextTopic = currentTopic ? `${currentTopic} ${linkText}` : linkText;
			void this.mind?.reshapeNode(selected, { topic: nextTopic });
		}).open();
	}

	public openInsertImageModal(): void {
		if (!this.mind) return;
		const selected = this.mind.currentNode;
		if (!selected) {
			new Notice("请先在脑图中选中一个节点");
			return;
		}
		new ImageSuggestModal(this.app, (file) => {
			const embedText = `![[${file.name}]]`;
			const currentTopic = selected.nodeObj.topic;
			const nextTopic = currentTopic ? `${currentTopic}\n${embedText}` : embedText;
			void this.mind?.reshapeNode(selected, { topic: nextTopic });
		}).open();
	}

	private destroyMindMap(): void {
		this.linkSuggester.close();
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

	private async mountMindMap(data: MindElixirData): Promise<void> {
		if (!this.mapHostEl) return;
		this.destroyMindMap();

		const mountEl = this.mapHostEl.createDiv({ cls: "mm-mind-elixir-root" });
		const theme = this.buildObsidianTheme();

		const mind = new MindElixir({
			el: mountEl,
			direction: directionToCode(this.currentDirection),
			editable: true,
			contextMenu: true,
			toolBar: false,
			allowUndo: true,
			compact: this.plugin.settings.compactMode,
			newTopicName: "新节点",
			theme,
			keypress: this.buildKeypressOptions(() => this.mind),
			markdown: (raw) =>
				renderNodeMarkdown(raw, (target) => this.resolveVaultImageUrl(target)),
			imageProxy: (url) => this.resolveVaultImageUrl(url) ?? url,
			pasteHandler: (evt) => {
				void this.handlePasteEvent(evt);
			},
		});

		this.mind = mind;
		await mind.init(data);
		this.updateDirectionButtons();

		// Wait one frame for layout metrics before centering
		window.requestAnimationFrame(() => {
			if (this.mind === mind) {
				mind.toCenter();
			}
		});

		mind.bus.addListener("operation", (op) => {
			if (this.isInternalRefresh) return;
			if (op.name === "beginEdit") {
				queueMicrotask(() => this.syncInputBoxWithNode(mind, op.target.id));
				return;
			}
			this.scheduleSave();
		});

		mind.bus.addListener("changeDirection", (dir) => {
			if (this.isInternalRefresh) return;
			this.currentDirection = codeToDirection(dir);
			this.updateDirectionButtons();
			this.scheduleSave();
		});
	}

	private syncInputBoxWithNode(mind: MindElixir, nodeId: string): void {
		const inputBox = mind.nodes.querySelector("#input-box") as HTMLElement | null;
		if (!inputBox) return;

		let tpc: HTMLElement | null = null;
		try {
			tpc = mind.findEle(nodeId);
		} catch {
			tpc = mind.currentNode;
		}
		if (!tpc) return;

		// Align #input-box exactly over the node pill and hide the underlying pill
		// while editing so deleting text never leaves a ghost pill sticking out.
		let left = 0;
		let top = 0;
		let cur: HTMLElement | null = tpc;
		while (cur && cur !== mind.nodes) {
			left += cur.offsetLeft;
			top += cur.offsetTop;
			cur = cur.offsetParent as HTMLElement | null;
		}

		inputBox.style.left = `${left}px`;
		inputBox.style.top = `${top}px`;
		inputBox.style.right = "auto";
		inputBox.style.margin = "0";
		inputBox.style.boxSizing = "border-box";
		inputBox.style.minWidth = `${tpc.offsetWidth}px`;
		inputBox.style.minHeight = `${tpc.offsetHeight}px`;

		const targetTpc = tpc;
		targetTpc.addClass("mm-editing-node");
		inputBox.addEventListener(
			"blur",
			() => {
				targetTpc.removeClass("mm-editing-node");
			},
			{ once: true }
		);
		this.linkSuggester.attachToInput(inputBox);
	}

	private scheduleSave(): void {
		if (!this.file) return;
		this.requestSave();
	}

	private buildKeypressOptions(
		getMind: () => MindElixir | null
	): KeypressOptions {
		const hk = this.plugin.settings.hotkeys;
		const options: KeypressOptions = {};

		const bindKey = (
			key: string | undefined,
			handler: (e: KeyboardEvent, mind: MindElixir) => void
		) => {
			const trimmed = key?.trim();
			if (!trimmed) return;
			const actualKey = trimmed === "Space" ? " " : trimmed;
			options[actualKey] = (e: KeyboardEvent) => {
				const mind = getMind();
				if (!mind) return;
				handler(e, mind);
			};
		};

		// Override defaults if user remapped them
		bindKey(hk.addChild, (_e, mind) => {
			void mind.addChild();
		});
		bindKey(hk.addSibling, (e, mind) => {
			if (e.shiftKey) {
				void mind.insertSibling("before");
			} else if (e.ctrlKey || e.metaKey) {
				void mind.insertParent();
			} else {
				void mind.insertSibling("after");
			}
		});
		bindKey(hk.editNode, (_e, mind) => {
			if (mind.currentSummary) {
				mind.editSummary(mind.currentSummary);
			} else if (mind.currentArrow) {
				mind.editArrowLabel(mind.currentArrow);
			} else {
				void mind.beginEdit();
			}
		});
		bindKey(hk.deleteNode, (_e, mind) => {
			if (mind.currentNodes.length > 0) {
				void mind.removeNodes(mind.currentNodes);
			} else if (mind.currentArrow) {
				mind.removeArrow();
			} else if (mind.currentSummary) {
				mind.removeSummary(mind.currentSummary.summaryObj.id);
			}
		});
		bindKey(hk.centerMap, (_e, mind) => {
			mind.toCenter();
		});
		bindKey(hk.toggleCollapse, (_e, mind) => {
			if (mind.currentNode && mind.currentNode.nodeObj.children?.length) {
				mind.expandNode(mind.currentNode);
			}
		});

		return options;
	}

	private isDarkThemeActive(): boolean {
		const mode = this.plugin.settings.themeMode;
		if (mode === "dark") return true;
		if (mode === "light") return false;
		return document.body.classList.contains("theme-dark");
	}

	private buildObsidianTheme(): Theme {
		const isDark = this.isDarkThemeActive();
		const base = isDark ? DARK_THEME : THEME;
		const styles = getComputedStyle(document.body);
		const readVar = (name: string, fallback: string) =>
			styles.getPropertyValue(name).trim() || fallback;

		const bgPrimary = readVar("--background-primary", isDark ? "#1e1e1e" : "#ffffff");
		const bgSecondary = readVar("--background-secondary", isDark ? "#262626" : "#f5f5f5");
		const textNormal = readVar("--text-normal", isDark ? "#dcddde" : "#222222");
		const textMuted = readVar("--text-muted", isDark ? "#999999" : "#666666");
		const accent = readVar("--interactive-accent", isDark ? "#7c6af7" : "#4c6ef5");
		const border = readVar("--background-modifier-border", isDark ? "#3a3a3a" : "#e0e0e0");

		return {
			...base,
			name: isDark ? "ObsidianDark" : "ObsidianLight",
			type: isDark ? "dark" : "light",
			cssVar: {
				...base.cssVar,
				"--bgcolor": bgPrimary,
				"--color": textNormal,
				"--main-color": textNormal,
				"--main-bgcolor": bgSecondary,
				"--main-bgcolor-transparent": bgSecondary,
				"--root-bgcolor": accent,
				"--root-color": "#ffffff",
				"--selected": accent,
				"--accent-color": accent,
				"--panel-bgcolor": bgSecondary,
				"--panel-color": textNormal,
				"--panel-border-color": border,
				"--root-border-color": border,
				"--node-gap-x": "30px",
				"--node-gap-y": "12px",
				"--main-gap-x": "60px",
				"--main-gap-y": "36px",
				"--topic-padding": "4px 8px",
			},
		};
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
		if (directFile && "extension" in directFile) {
			return this.app.vault.getResourcePath(directFile as TFile);
		}

		return null;
	}

	private handleCanvasClick(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		if (!target) return;

		const wikiLink = target.closest("a.mm-wikilink") as HTMLAnchorElement | null;
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

		const extLink = target.closest("a.mm-extlink") as HTMLAnchorElement | null;
		if (extLink) {
			evt.stopPropagation();
		}
	}

	private handleCanvasHover(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		if (!target) return;

		const wikiLink = target.closest("a.mm-wikilink") as HTMLAnchorElement | null;
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

	private handleCanvasContextMenu(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		const inputBox = target?.closest("#input-box") as HTMLElement | null;
		if (!inputBox) return;

		// Stop mind-elixir from swallowing right-click inside the node text editor
		evt.preventDefault();
		evt.stopPropagation();

		const editingNode = this.mind?.currentNode ?? null;
		const fullText = inputBox.textContent ?? "";
		const { start, end } = this.getSelectionOffsets(inputBox);
		const selectedText = fullText.slice(start, end);
		const hasSelection = end > start;

		const replaceRange = async (
			replacement: string,
			caretStartOffset: number,
			caretEndOffset: number,
			keepEditing = true
		) => {
			const nextText =
				fullText.slice(0, start) + replacement + fullText.slice(end);
			await this.applyInputBoxText(
				inputBox,
				editingNode,
				nextText,
				start + caretStartOffset,
				start + caretEndOffset,
				keepEditing
			);
		};

		const wrapSelection = async (prefix: string, suffix: string, placeholder: string) => {
			const inner = selectedText || placeholder;
			const wrapped = `${prefix}${inner}${suffix}`;
			await replaceRange(
				wrapped,
				prefix.length,
				prefix.length + inner.length
			);
		};

		const menu = new Menu();

		// Links & embeds
		menu.addItem((item) =>
			item
				.setTitle("新增双链 [[笔记]]")
				.setIcon("link")
				.onClick(() => {
					new NoteLinkSuggestModal(this.app, (file) => {
						const linkText = this.app.fileManager.generateMarkdownLink(
							file,
							this.file?.path ?? ""
						);
						void replaceRange(linkText, linkText.length, linkText.length, false);
					}).open();
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("新增外部链接")
				.setIcon("external-link")
				.onClick(() => {
					const label = selectedText || "链接";
					const mdLink = `[${label}](https://)`;
					void replaceRange(
						mdLink,
						label.length + 3,
						mdLink.length - 1
					);
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("插入库内图片 ![[图片]]")
				.setIcon("image-plus")
				.onClick(() => {
					new ImageSuggestModal(this.app, (file) => {
						const embedText = `![[${file.name}]]`;
						void replaceRange(embedText, embedText.length, embedText.length, false);
					}).open();
				})
		);

		menu.addSeparator();

		// Inline Markdown formatting
		menu.addItem((item) =>
			item
				.setTitle("加粗")
				.setIcon("bold")
				.onClick(() => {
					void wrapSelection("**", "**", "加粗文本");
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("斜体")
				.setIcon("italic")
				.onClick(() => {
					void wrapSelection("*", "*", "斜体文本");
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("删除线")
				.setIcon("strikethrough")
				.onClick(() => {
					void wrapSelection("~~", "~~", "删除文本");
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("高亮")
				.setIcon("highlighter")
				.onClick(() => {
					void wrapSelection("==", "==", "高亮文本");
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("行内代码")
				.setIcon("code")
				.onClick(() => {
					void wrapSelection("`", "`", "code");
				})
		);

		menu.addSeparator();

		// Standard clipboard & selection actions
		menu.addItem((item) =>
			item
				.setTitle("剪切")
				.setIcon("scissors")
				.setDisabled(!hasSelection)
				.onClick(async () => {
					if (!hasSelection) return;
					await navigator.clipboard.writeText(selectedText);
					await replaceRange("", 0, 0);
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("复制")
				.setIcon("copy")
				.setDisabled(!hasSelection)
				.onClick(async () => {
					if (!hasSelection) return;
					await navigator.clipboard.writeText(selectedText);
					await this.applyInputBoxText(
						inputBox,
						editingNode,
						fullText,
						start,
						end,
						true
					);
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("粘贴")
				.setIcon("clipboard-paste")
				.onClick(async () => {
					try {
						const clipText = await navigator.clipboard.readText();
						if (clipText) {
							await replaceRange(clipText, clipText.length, clipText.length);
						}
					} catch {
						new Notice("无法读取剪贴板，请尝试使用 Ctrl+V 粘贴");
					}
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("全选")
				.setIcon("text-select")
				.onClick(async () => {
					await this.applyInputBoxText(
						inputBox,
						editingNode,
						fullText,
						0,
						fullText.length,
						true
					);
				})
		);

		menu.showAtMouseEvent(evt);
	}

	private getSelectionOffsets(el: HTMLElement): { start: number; end: number } {
		const textLen = (el.textContent ?? "").length;
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			return { start: textLen, end: textLen };
		}
		const range = sel.getRangeAt(0);
		if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
			return { start: textLen, end: textLen };
		}
		const preRange = range.cloneRange();
		preRange.selectNodeContents(el);
		preRange.setEnd(range.startContainer, range.startOffset);
		const start = preRange.toString().length;
		const end = start + range.toString().length;
		return { start, end };
	}

	private setSelectionOffsets(el: HTMLElement, start: number, end: number): void {
		const sel = window.getSelection();
		if (!sel) return;

		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let currentNode = walker.nextNode();
		let offset = 0;
		let startNode: Node = el;
		let startPos = 0;
		let endNode: Node = el;
		let endPos = 0;
		let foundStart = false;
		let foundEnd = false;

		while (currentNode) {
			const len = currentNode.textContent?.length ?? 0;
			if (!foundStart && start <= offset + len) {
				startNode = currentNode;
				startPos = Math.max(0, start - offset);
				foundStart = true;
			}
			if (!foundEnd && end <= offset + len) {
				endNode = currentNode;
				endPos = Math.max(0, end - offset);
				foundEnd = true;
				break;
			}
			offset += len;
			currentNode = walker.nextNode();
		}

		if (!foundStart) {
			startNode = el;
			startPos = el.childNodes.length;
		}
		if (!foundEnd) {
			endNode = el;
			endPos = el.childNodes.length;
		}

		const range = document.createRange();
		range.setStart(startNode, startPos);
		range.setEnd(endNode, endPos);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	private async applyInputBoxText(
		inputBox: HTMLElement,
		editingNode: Topic | null,
		nextText: string,
		caretStart: number,
		caretEnd: number,
		keepEditing: boolean
	): Promise<void> {
		if (inputBox.isConnected) {
			inputBox.textContent = nextText;
			if (keepEditing) {
				inputBox.focus();
				this.setSelectionOffsets(inputBox, caretStart, caretEnd);
			} else {
				inputBox.blur();
			}
			return;
		}

		if (!this.mind || !editingNode) return;
		if (nextText.trim() !== "") {
			await this.mind.reshapeNode(editingNode, { topic: nextText });
		}
		if (keepEditing) {
			await this.mind.beginEdit(editingNode);
			const reopened = this.mapHostEl?.querySelector("#input-box") as HTMLElement | null;
			if (reopened) {
				reopened.textContent = nextText;
				reopened.focus();
				this.setSelectionOffsets(reopened, caretStart, caretEnd);
			}
		}
	}

	private async handlePasteEvent(evt: ClipboardEvent): Promise<void> {
		if (!this.mind || !this.mind.currentNode || !evt.clipboardData) return;

		const items = Array.from(evt.clipboardData.items);
		const imageItem = items.find((item) => item.type.startsWith("image/"));
		if (!imageItem) return;

		evt.preventDefault();
		const blob = imageItem.getAsFile();
		if (!blob) return;

		const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
		const fileName = `mindmap-img-${Date.now()}.${ext}`;
		const targetPath = await this.app.fileManager.getAvailablePathForAttachment(
			fileName,
			this.file?.path ?? ""
		);
		const arrayBuffer = await blob.arrayBuffer();
		const createdFile = await this.app.vault.createBinary(targetPath, arrayBuffer);

		const selected = this.mind.currentNode;
		const embedText = `![[${createdFile.name}]]`;
		const nextTopic = selected.nodeObj.topic
			? `${selected.nodeObj.topic}\n${embedText}`
			: embedText;
		await this.mind.reshapeNode(selected, { topic: nextTopic });
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

		// Export & Source switch
		addBtn("download", "导出为 PNG 图片", () => {
			void this.exportAsPng();
		});
		addBtn("code-2", "切换到 Markdown 源码模式 (Ctrl+.)", () => {
			void this.plugin.switchLeafToMarkdown(this.leaf, this.file);
		});
	}

	private setLayoutDirection(dir: MindMapDirection): void {
		if (!this.mind) return;
		this.currentDirection = dir;
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
		const activeBtn = this.toolbarEl.querySelector(`.mm-dir-${this.currentDirection}`);
		activeBtn?.addClass("is-active");
	}

	private async resolveExportPath(extension: "png" | "svg"): Promise<string> {
		const baseName = this.file?.basename || "mind-map";
		const configuredFolder = this.plugin.settings.exportFolder.trim();
		const targetFolder = configuredFolder || this.file?.parent?.path || "";

		if (targetFolder) {
			const normalizedFolder = normalizePath(targetFolder);
			if (!this.app.vault.getAbstractFileByPath(normalizedFolder)) {
				await this.app.vault.createFolder(normalizedFolder);
			}
		}

		let counter = 0;
		while (true) {
			const suffix = counter === 0 ? "" : `-${counter}`;
			const fileName = `${baseName}${suffix}.${extension}`;
			const candidate = normalizePath(
				targetFolder ? `${targetFolder}/${fileName}` : fileName
			);
			if (!this.app.vault.getAbstractFileByPath(candidate)) {
				return candidate;
			}
			counter++;
		}
	}

	public async exportAsPng(): Promise<void> {
		if (!this.mind) return;
		try {
			new Notice("正在生成 PNG 图片...");
			const blob = await exportImageBlob(
				this.mind as unknown as Parameters<typeof exportImageBlob>[0],
				"png",
				{
					scale: this.plugin.settings.exportScale || 2,
					watermarkEnabled: false,
				}
			);
			const arrayBuffer = await blob.arrayBuffer();
			const outPath = await this.resolveExportPath("png");
			await this.app.vault.createBinary(outPath, arrayBuffer);
			new Notice(`已导出 PNG 到库内：${outPath}`);
		} catch (err) {
			console.error("[SimpleMindMap] PNG export failed:", err);
			new Notice(`导出 PNG 失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	public async exportAsSvg(): Promise<void> {
		if (!this.mind) return;
		try {
			new Notice("正在生成 SVG 图片...");
			const svgContent = await this.buildStandaloneSvg(this.mind);
			const outPath = await this.resolveExportPath("svg");
			await this.app.vault.create(outPath, svgContent);
			new Notice(`已导出 SVG 到库内：${outPath}`);
		} catch (err) {
			console.error("[SimpleMindMap] SVG export failed:", err);
			new Notice(`导出 SVG 失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async buildStandaloneSvg(mind: MindElixir): Promise<string> {
		const nodesEl = mind.nodes;
		const width = Math.max(nodesEl.scrollWidth, nodesEl.offsetWidth, 400) + 80;
		const height = Math.max(nodesEl.scrollHeight, nodesEl.offsetHeight, 300) + 80;

		const clone = nodesEl.cloneNode(true) as HTMLElement;
		clone.style.position = "relative";
		clone.style.transform = "none";
		clone.style.padding = "40px";

		// Inline images as data URLs so exported SVG is self-contained
		const imgs = Array.from(clone.querySelectorAll("img"));
		await Promise.all(
			imgs.map(async (img) => {
				try {
					const dataUrl = await this.imageSrcToDataUrl(img.src);
					if (dataUrl) img.src = dataUrl;
				} catch {
					// Keep original src if conversion fails
				}
			})
		);

		const cssVars = Object.entries(mind.theme.cssVar)
			.filter(([, v]) => Boolean(v))
			.map(([k, v]) => `${k}: ${v};`)
			.join("\n");

		const bgColor = mind.theme.cssVar["--bgcolor"] || "#ffffff";
		const collectedCss = this.collectMindElixirStyles();
		const serializedHtml = new XMLSerializer().serializeToString(clone);

		return [
			`<?xml version="1.0" encoding="UTF-8"?>`,
			`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
			`<rect width="100%" height="100%" fill="${bgColor}" />`,
			`<foreignObject width="100%" height="100%">`,
			`<div xmlns="http://www.w3.org/1999/xhtml" class="map-container" style="${cssVars} width:${width}px; height:${height}px; background:${bgColor}; overflow:visible;">`,
			`<style><![CDATA[${collectedCss}]]></style>`,
			serializedHtml,
			`</div>`,
			`</foreignObject>`,
			`</svg>`,
		].join("\n");
	}

	private collectMindElixirStyles(): string {
		const rules: string[] = [];
		for (const sheet of Array.from(document.styleSheets)) {
			try {
				for (const rule of Array.from(sheet.cssRules)) {
					const text = rule.cssText;
					if (
						text.includes("me-") ||
						text.includes("map-container") ||
						text.includes("mm-")
					) {
						rules.push(text);
					}
				}
			} catch {
				// Ignore cross-origin sheets
			}
		}
		return rules.join("\n");
	}

	private imageSrcToDataUrl(src: string): Promise<string | null> {
		if (!src || src.startsWith("data:")) return Promise.resolve(src);
		return new Promise((resolve) => {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => {
				try {
					const canvas = document.createElement("canvas");
					canvas.width = img.naturalWidth || img.width;
					canvas.height = img.naturalHeight || img.height;
					const ctx = canvas.getContext("2d");
					if (!ctx) return resolve(null);
					ctx.drawImage(img, 0, 0);
					resolve(canvas.toDataURL("image/png"));
				} catch {
					resolve(null);
				}
			};
			img.onerror = () => resolve(null);
			img.src = src;
		});
	}
}
