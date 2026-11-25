import { App, Menu, Notice, TFile, prepareFuzzySearch } from "obsidian";
import type MindElixir from "mind-elixir";
import type { Topic } from "mind-elixir";
import { ImageSuggestModal, NoteLinkSuggestModal } from "../modals/VaultSuggestModals";
import {
	NodeInlineEditorSession,
	type InlineFormatKind,
	type LinkCandidate,
	type LinkPopupViewModel,
} from "./NodeInlineEditorSession";

export interface NodeInlineEditorHost {
	getMind: () => MindElixir | null;
	getSourcePath: () => string;
}

/**
 * Obsidian/DOM adapter for the Node Inline Editor:
 * - Aligns MindElixir's #input-box overlay over the edited Node
 * - Translates DOM Selection offsets and renders the floating Link Suggestion popup
 * - Wires right-click context menu & vault picker modals into NodeInlineEditorSession
 */
export class NodeInlineEditor {
	private app: App;
	private host: NodeInlineEditorHost;
	private session: NodeInlineEditorSession<TFile, Topic>;
	private canvasHostEl: HTMLElement | null = null;
	private activeInputBox: HTMLElement | null = null;
	private popupEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;
	private lastRenderedCandidates: LinkCandidate<TFile>[] | null = null;

	private readonly onContextMenuBound: (evt: MouseEvent) => void;
	private readonly onKeyDownBound: (evt: KeyboardEvent) => void;

	constructor(app: App, host: NodeInlineEditorHost) {
		this.app = app;
		this.host = host;
		this.session = this.createSession();
		this.onContextMenuBound = (evt) => this.handleContextMenu(evt);
		this.onKeyDownBound = (evt) => this.handleSuggesterKeyDown(evt);
	}

	public attach(canvasHostEl: HTMLElement): void {
		this.detach();
		this.canvasHostEl = canvasHostEl;
		canvasHostEl.addEventListener("contextmenu", this.onContextMenuBound, true);
		canvasHostEl.addEventListener("keydown", this.onKeyDownBound, true);
	}

	public detach(): void {
		this.session.closeSuggester();
		if (this.canvasHostEl) {
			this.canvasHostEl.removeEventListener(
				"contextmenu",
				this.onContextMenuBound,
				true
			);
			this.canvasHostEl.removeEventListener("keydown", this.onKeyDownBound, true);
			this.canvasHostEl = null;
		}
		this.activeInputBox = null;
	}

	public destroy(): void {
		this.session.closeSuggester();
		this.activeInputBox = null;
	}

	public commitActiveEdit(): void {
		this.session.commitActiveEdit();
		this.activeInputBox = null;
	}

	public openInsertNoteModal(): void {
		const mind = this.host.getMind();
		if (!mind) return;
		if (!mind.currentNode) {
			new Notice("请先在脑图中选中一个节点");
			return;
		}
		new NoteLinkSuggestModal(this.app, (file) => {
			void this.session.appendFileToSelectedNode(file, false);
		}).open();
	}

	public openInsertImageModal(): void {
		const mind = this.host.getMind();
		if (!mind) return;
		if (!mind.currentNode) {
			new Notice("请先在脑图中选中一个节点");
			return;
		}
		new ImageSuggestModal(this.app, (file) => {
			void this.session.appendFileToSelectedNode(file, true);
		}).open();
	}

	public async appendImageEmbedToSelectedNode(file: TFile): Promise<boolean> {
		return this.session.appendFileToSelectedNode(file, true);
	}

	public onBeginNodeEdit(mind: MindElixir, nodeId: string): void {
		const inputBox = mind.nodes.querySelector<HTMLElement>("#input-box");
		if (!inputBox) return;

		this.activeInputBox = inputBox;

		let tpc: HTMLElement | null = null;
		try {
			tpc = mind.findEle(nodeId);
		} catch {
			tpc = mind.currentNode;
		}

		if (tpc) {
			this.alignInputBoxOverNode(mind, tpc, inputBox);
			const targetTpc = tpc;
			targetTpc.addClass("mm-editing-node");
			inputBox.addEventListener(
				"blur",
				() => {
					targetTpc.removeClass("mm-editing-node");
				},
				{ once: true }
			);
		}

		this.bindSuggesterToInput(inputBox);
	}

	private createSession(): NodeInlineEditorSession<TFile, Topic> {
		return new NodeInlineEditorSession<TFile, Topic>({
			listVaultCandidates: () =>
				this.app.vault.getFiles().map((file) => ({
					file,
					path: file.path,
					basename: file.basename,
					name: file.name,
					extension: file.extension,
					folderPath:
						file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "",
					mtime: file.stat.mtime,
				})),
			createFuzzyScorer: (query) => prepareFuzzySearch(query),
			generateMarkdownLink: (file) =>
				this.app.fileManager.generateMarkdownLink(
					file,
					this.host.getSourcePath()
				),
			getFileMeta: (file) => ({
				name: file.name,
				basename: file.basename,
				extension: file.extension,
			}),
			readInputBox: () => {
				const inputBox = this.activeInputBox;
				if (!inputBox) return null;
				return {
					connected: inputBox.isConnected,
					text: inputBox.textContent ?? "",
					selection: this.getSelectionOffsets(inputBox),
				};
			},
			writeInputBox: (text, selection, keepEditing) => {
				const inputBox = this.activeInputBox;
				if (!inputBox || !inputBox.isConnected) return;
				inputBox.textContent = text;
				if (keepEditing) {
					inputBox.focus();
					this.setSelectionOffsets(inputBox, selection.start, selection.end);
				} else {
					inputBox.blur();
				}
			},
			blurInputBox: () => {
				if (this.activeInputBox && this.activeInputBox.isConnected) {
					this.activeInputBox.blur();
					return;
				}
				const fallbackBox =
					this.canvasHostEl?.querySelector<HTMLElement>("#input-box");
				fallbackBox?.blur();
			},
			renderSuggester: (state) => {
				this.renderSuggesterState(state);
			},
			getSelectedNode: () => {
				const selected = this.host.getMind()?.currentNode ?? null;
				if (!selected) return null;
				return {
					node: selected,
					topic: selected.nodeObj.topic,
				};
			},
			reshapeNodeTopic: async (node, topic) => {
				const mind = this.host.getMind();
				if (!mind) return;
				await mind.reshapeNode(node, { topic });
			},
			reopenNodeEditor: async (node, text, selection) => {
				const mind = this.host.getMind();
				if (!mind) return;
				await mind.beginEdit(node);
				const reopened =
					this.canvasHostEl?.querySelector<HTMLElement>("#input-box");
				if (reopened) {
					this.activeInputBox = reopened;
					reopened.textContent = text;
					reopened.focus();
					this.setSelectionOffsets(reopened, selection.start, selection.end);
				}
			},
		});
	}

	private alignInputBoxOverNode(
		mind: MindElixir,
		tpc: HTMLElement,
		inputBox: HTMLElement
	): void {
		let left = 0;
		let top = 0;
		let cur: HTMLElement | null = tpc;
		while (cur && cur !== mind.nodes) {
			left += cur.offsetLeft;
			top += cur.offsetTop;
			cur = cur.offsetParent as HTMLElement | null;
		}

		// Clear MindElixir's inline positioning/margin so CSS rules and custom properties take effect cleanly
		inputBox.style.removeProperty("left");
		inputBox.style.removeProperty("top");
		inputBox.style.removeProperty("right");
		inputBox.style.removeProperty("margin");
		inputBox.style.removeProperty("min-width");
		inputBox.style.removeProperty("min-height");

		inputBox.setCssProps({
			"--mm-input-left": `${left}px`,
			"--mm-input-top": `${top}px`,
			"--mm-input-min-width": `${tpc.offsetWidth}px`,
			"--mm-input-min-height": `${tpc.offsetHeight}px`,
		});
	}

	private handleContextMenu(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		const inputBox = target?.closest<HTMLElement>("#input-box") ?? null;
		if (!inputBox) return;

		evt.preventDefault();
		evt.stopPropagation();

		this.activeInputBox = inputBox;
		const editingNode = this.host.getMind()?.currentNode ?? null;
		const fullText = inputBox.textContent ?? "";
		const selection = this.getSelectionOffsets(inputBox);
		const selectedText = fullText.slice(selection.start, selection.end);
		const hasSelection = selection.end > selection.start;

		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("新增双链 [[笔记]]")
				.setIcon("link")
				.onClick(() => {
					new NoteLinkSuggestModal(this.app, (file) => {
						void this.session.insertFileIntoSelection(
							editingNode,
							fullText,
							selection,
							file,
							false
						);
					}).open();
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("新增外部链接")
				.setIcon("external-link")
				.onClick(() => {
					void this.session.applyInlineFormat(
						editingNode,
						fullText,
						selection,
						"external-link"
					);
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("插入库内图片 ![[图片]]")
				.setIcon("image-plus")
				.onClick(() => {
					new ImageSuggestModal(this.app, (file) => {
						void this.session.insertFileIntoSelection(
							editingNode,
							fullText,
							selection,
							file,
							true
						);
					}).open();
				})
		);

		menu.addSeparator();

		const formatItems: Array<{
			title: string;
			icon: string;
			kind: InlineFormatKind;
		}> = [
			{ title: "加粗", icon: "bold", kind: "bold" },
			{ title: "斜体", icon: "italic", kind: "italic" },
			{ title: "删除线", icon: "strikethrough", kind: "strikethrough" },
			{ title: "高亮", icon: "highlighter", kind: "highlight" },
			{ title: "行内代码", icon: "code", kind: "code" },
		];

		for (const fmt of formatItems) {
			menu.addItem((item) =>
				item
					.setTitle(fmt.title)
					.setIcon(fmt.icon)
					.onClick(() => {
						void this.session.applyInlineFormat(
							editingNode,
							fullText,
							selection,
							fmt.kind
						);
					})
			);
		}

		menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle("剪切")
				.setIcon("scissors")
				.setDisabled(!hasSelection)
				.onClick(async () => {
					if (!hasSelection) return;
					await navigator.clipboard.writeText(selectedText);
					await this.session.replaceSelectionText(
						editingNode,
						fullText,
						selection,
						""
					);
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
					await this.session.restoreSelection(editingNode, fullText, selection);
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
							await this.session.replaceSelectionText(
								editingNode,
								fullText,
								selection,
								clipText
							);
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
					await this.session.restoreSelection(editingNode, fullText, {
						start: 0,
						end: fullText.length,
					});
				})
		);

		menu.showAtMouseEvent(evt);
	}

	private bindSuggesterToInput(inputBox: HTMLElement): void {
		const refresh = () => this.session.refreshSuggester();
		inputBox.addEventListener("input", refresh);
		inputBox.addEventListener("keyup", (evt) => {
			if (
				evt.key === "ArrowUp" ||
				evt.key === "ArrowDown" ||
				evt.key === "Enter" ||
				evt.key === "Tab" ||
				evt.key === "Escape"
			) {
				return;
			}
			refresh();
		});
		inputBox.addEventListener("click", refresh);
		inputBox.addEventListener(
			"blur",
			() => {
				this.session.onInputBlur();
				if (this.activeInputBox === inputBox) {
					this.activeInputBox = null;
				}
			},
			{ once: true }
		);

		refresh();
	}

	private handleSuggesterKeyDown(evt: KeyboardEvent): void {
		const action = this.session.handleSuggesterKeyDown({
			key: evt.key,
			isComposing: evt.isComposing,
		});
		if (action === "handled") {
			evt.preventDefault();
			evt.stopPropagation();
		}
	}

	private renderSuggesterState(state: LinkPopupViewModel<TFile>): void {
		if (!state.isOpen || !this.activeInputBox || !this.activeInputBox.isConnected) {
			this.destroyPopupDom();
			return;
		}

		if (!this.popupEl) {
			this.popupEl = activeDocument.body.createDiv({ cls: "mm-link-suggester" });
			this.popupEl.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
			});
			this.listEl = this.popupEl.createDiv({ cls: "mm-link-suggester-list" });
			this.footerEl = this.popupEl.createDiv({ cls: "mm-link-suggester-footer" });
		}

		if (this.footerEl) {
			this.footerEl.setText(state.footerText);
		}

		const listEl = this.listEl;
		if (!listEl) return;

		if (this.lastRenderedCandidates === state.candidates) {
			this.updatePopupSelection(state.selectedIndex);
			return;
		}

		this.lastRenderedCandidates = state.candidates;
		listEl.empty();

		state.candidates.forEach((candidate, index) => {
			const row = listEl.createDiv({
				cls: `mm-link-suggester-item${index === state.selectedIndex ? " is-selected" : ""}`,
			});
			const titleEl = row.createDiv({ cls: "mm-link-suggester-title" });
			titleEl.setText(
				candidate.extension === "md" ? candidate.basename : candidate.name
			);

			if (candidate.folderPath) {
				const pathEl = row.createDiv({ cls: "mm-link-suggester-path" });
				pathEl.setText(candidate.folderPath);
			}

			row.addEventListener("mouseenter", () => {
				this.session.hoverSuggesterIndex(index);
			});
			row.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.session.chooseSuggesterIndex(index);
			});
		});

		this.positionSuggesterPopup(this.activeInputBox, state.candidates.length);
	}

	private updatePopupSelection(selectedIndex: number): void {
		if (!this.listEl) return;
		const rows = Array.from(this.listEl.children) as HTMLElement[];
		rows.forEach((row, idx) => {
			row.toggleClass("is-selected", idx === selectedIndex);
			if (idx === selectedIndex) {
				row.scrollIntoView({ block: "nearest" });
			}
		});
	}

	private positionSuggesterPopup(
		inputBox: HTMLElement,
		candidateCount: number
	): void {
		if (!this.popupEl) return;
		const rect = inputBox.getBoundingClientRect();
		const popupWidth = 320;
		const estimatedHeight = Math.min(340, candidateCount * 46 + 40);

		let left = rect.left;
		if (left + popupWidth > window.innerWidth - 12) {
			left = Math.max(12, window.innerWidth - popupWidth - 12);
		}

		let top = rect.bottom + 6;
		if (top + estimatedHeight > window.innerHeight - 12) {
			top = Math.max(12, rect.top - estimatedHeight - 6);
		}

		this.popupEl.setCssProps({
			"--mm-suggester-left": `${left}px`,
			"--mm-suggester-top": `${top}px`,
			"--mm-suggester-width": `${popupWidth}px`,
		});
	}

	private destroyPopupDom(): void {
		if (this.popupEl) {
			this.popupEl.remove();
			this.popupEl = null;
			this.listEl = null;
			this.footerEl = null;
		}
		this.lastRenderedCandidates = null;
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

		const walker = activeDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
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

		const range = activeDocument.createRange();
		range.setStart(startNode, startPos);
		range.setEnd(endNode, endPos);
		sel.removeAllRanges();
		sel.addRange(range);
	}
}
