import { App, Menu, Notice, TFile, prepareFuzzySearch } from "obsidian";
import type MindElixir from "mind-elixir";
import type { Topic } from "mind-elixir";
import { ImageSuggestModal, NoteLinkSuggestModal } from "../modals/VaultSuggestModals";
import {
	cycleSelectionIndex,
	findLinkTrigger,
	formatEmbedLink,
	formatWikiLink,
	getSuggesterFooterText,
	rankLinkCandidates,
	replaceTextRange,
	wrapExternalLink,
	wrapTextSelection,
	type LinkCandidate,
	type LinkTriggerMatch,
} from "./nodeInlineEditorCore";

interface VaultLinkCandidate extends LinkCandidate {
	file: TFile;
}

export interface NodeInlineEditorHost {
	getMind: () => MindElixir | null;
	getSourcePath: () => string;
}

/**
 * Deep module owning the Node Inline Editor session:
 * - Pill overlay alignment & underlying node visibility during editing
 * - Caret/selection offset translation & detached-editor recovery
 * - Obsidian-native right-click text editing menu
 * - Floating [[wikilink]] and ![[embed]] Link Suggestion popup
 * - Canonical wikilink & embed formatting
 */
export class NodeInlineEditor {
	private app: App;
	private host: NodeInlineEditorHost;
	private canvasHostEl: HTMLElement | null = null;
	private activeInputBox: HTMLElement | null = null;
	private popupEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;
	private activeMatch: LinkTriggerMatch | null = null;
	private candidates: VaultLinkCandidate[] = [];
	private selectedIndex = 0;

	private readonly onContextMenuBound: (evt: MouseEvent) => void;
	private readonly onKeyDownBound: (evt: KeyboardEvent) => void;

	constructor(app: App, host: NodeInlineEditorHost) {
		this.app = app;
		this.host = host;
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
		this.closeSuggester();
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
		this.closeSuggester();
		this.activeInputBox = null;
	}

	public commitActiveEdit(): void {
		this.closeSuggester();
		if (this.activeInputBox && this.activeInputBox.isConnected) {
			this.activeInputBox.blur();
			this.activeInputBox = null;
			return;
		}
		const fallbackBox = this.canvasHostEl?.querySelector(
			"#input-box"
		) as HTMLElement | null;
		if (fallbackBox) {
			fallbackBox.blur();
		}
	}

	public formatNoteLink(file: TFile): string {
		const generated = this.app.fileManager.generateMarkdownLink(
			file,
			this.host.getSourcePath()
		);
		return formatWikiLink(generated, file.basename);
	}

	public formatMediaEmbed(file: TFile): string {
		return formatEmbedLink(file.name, file.basename, file.extension);
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

		inputBox.setCssProps({
			left: `${left}px`,
			top: `${top}px`,
			"min-width": `${tpc.offsetWidth}px`,
			"min-height": `${tpc.offsetHeight}px`,
		});
	}

	// --- Right-click text editing menu inside #input-box ---

	private handleContextMenu(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		const inputBox = target?.closest("#input-box") as HTMLElement | null;
		if (!inputBox) return;

		evt.preventDefault();
		evt.stopPropagation();

		const mind = this.host.getMind();
		const editingNode = mind?.currentNode ?? null;
		const fullText = inputBox.textContent ?? "";
		const { start, end } = this.getSelectionOffsets(inputBox);
		const selectedText = fullText.slice(start, end);
		const hasSelection = end > start;

		const commitEditResult = async (
			result: { text: string; caretStart: number; caretEnd: number },
			keepEditing = true
		) => {
			await this.applyInputBoxText(
				inputBox,
				editingNode,
				result.text,
				result.caretStart,
				result.caretEnd,
				keepEditing
			);
		};

		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("新增双链 [[笔记]]")
				.setIcon("link")
				.onClick(() => {
					new NoteLinkSuggestModal(this.app, (file) => {
						const linkText = this.formatNoteLink(file);
						void commitEditResult(
							replaceTextRange(fullText, start, end, linkText),
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
					void commitEditResult(wrapExternalLink(fullText, start, end));
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("插入库内图片 ![[图片]]")
				.setIcon("image-plus")
				.onClick(() => {
					new ImageSuggestModal(this.app, (file) => {
						const embedText = this.formatMediaEmbed(file);
						void commitEditResult(
							replaceTextRange(fullText, start, end, embedText),
							false
						);
					}).open();
				})
		);

		menu.addSeparator();

		const formatItems: Array<{
			title: string;
			icon: string;
			prefix: string;
			suffix: string;
			placeholder: string;
		}> = [
			{ title: "加粗", icon: "bold", prefix: "**", suffix: "**", placeholder: "加粗文本" },
			{ title: "斜体", icon: "italic", prefix: "*", suffix: "*", placeholder: "斜体文本" },
			{ title: "删除线", icon: "strikethrough", prefix: "~~", suffix: "~~", placeholder: "删除文本" },
			{ title: "高亮", icon: "highlighter", prefix: "==", suffix: "==", placeholder: "高亮文本" },
			{ title: "行内代码", icon: "code", prefix: "`", suffix: "`", placeholder: "code" },
		];

		for (const fmt of formatItems) {
			menu.addItem((item) =>
				item
					.setTitle(fmt.title)
					.setIcon(fmt.icon)
					.onClick(() => {
						void commitEditResult(
							wrapTextSelection(
								fullText,
								start,
								end,
								fmt.prefix,
								fmt.suffix,
								fmt.placeholder
							)
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
					await commitEditResult(replaceTextRange(fullText, start, end, ""));
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
							await commitEditResult(
								replaceTextRange(fullText, start, end, clipText)
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

	// --- Inline [[wikilink]] / ![[embed]] Link Suggestion popup ---

	private isSuggesterOpen(): boolean {
		return this.popupEl !== null && this.candidates.length > 0;
	}

	private bindSuggesterToInput(inputBox: HTMLElement): void {
		const refresh = () => this.updateSuggesterFromInput(inputBox);
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
				this.closeSuggester();
				if (this.activeInputBox === inputBox) {
					this.activeInputBox = null;
				}
			},
			{ once: true }
		);

		refresh();
	}

	private handleSuggesterKeyDown(evt: KeyboardEvent): void {
		if (!this.isSuggesterOpen()) return;

		if (evt.key === "ArrowDown") {
			evt.preventDefault();
			evt.stopPropagation();
			this.selectedIndex = cycleSelectionIndex(
				this.selectedIndex,
				this.candidates.length,
				1
			);
			this.renderSuggesterSelection();
			return;
		}

		if (evt.key === "ArrowUp") {
			evt.preventDefault();
			evt.stopPropagation();
			this.selectedIndex = cycleSelectionIndex(
				this.selectedIndex,
				this.candidates.length,
				-1
			);
			this.renderSuggesterSelection();
			return;
		}

		if (evt.key === "Enter" || evt.key === "Tab") {
			if (evt.isComposing) return;
			evt.preventDefault();
			evt.stopPropagation();
			const chosen = this.candidates[this.selectedIndex];
			if (chosen) {
				this.commitSuggesterChoice(chosen.file);
			}
			return;
		}

		if (evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			this.closeSuggester();
		}
	}

	private updateSuggesterFromInput(inputBox: HTMLElement): void {
		if (!inputBox.isConnected) {
			this.closeSuggester();
			return;
		}

		const text = inputBox.textContent ?? "";
		const { start: caret } = this.getSelectionOffsets(inputBox);
		const match = findLinkTrigger(text, caret);
		if (!match) {
			this.closeSuggester();
			return;
		}

		const allFiles: VaultLinkCandidate[] = this.app.vault.getFiles().map((file) => ({
			file,
			path: file.path,
			basename: file.basename,
			name: file.name,
			extension: file.extension,
			folderPath: file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "",
			mtime: file.stat.mtime,
		}));

		const ranked = rankLinkCandidates(
			allFiles,
			match.query,
			match.isEmbed,
			(q) => prepareFuzzySearch(q)
		);
		if (ranked.length === 0) {
			this.closeSuggester();
			return;
		}

		this.activeMatch = match;
		this.candidates = ranked;
		this.selectedIndex = Math.min(this.selectedIndex, ranked.length - 1);
		this.renderSuggesterPopup(inputBox, match.isEmbed);
	}

	private renderSuggesterPopup(inputBox: HTMLElement, isEmbed: boolean): void {
		if (!this.popupEl) {
			this.popupEl = activeDocument.body.createDiv({ cls: "mm-link-suggester" });
			this.popupEl.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
			});
			this.listEl = this.popupEl.createDiv({ cls: "mm-link-suggester-list" });
			this.footerEl = this.popupEl.createDiv({ cls: "mm-link-suggester-footer" });
		}

		if (this.footerEl) {
			this.footerEl.setText(getSuggesterFooterText(isEmbed));
		}

		if (!this.listEl) return;
		this.listEl.empty();

		this.candidates.forEach((candidate, index) => {
			const row = this.listEl!.createDiv({
				cls: `mm-link-suggester-item${index === this.selectedIndex ? " is-selected" : ""}`,
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
				this.selectedIndex = index;
				this.renderSuggesterSelection();
			});
			row.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.commitSuggesterChoice(candidate.file);
			});
		});

		this.positionSuggesterPopup(inputBox);
	}

	private renderSuggesterSelection(): void {
		if (!this.listEl) return;
		const rows = Array.from(this.listEl.children) as HTMLElement[];
		rows.forEach((row, idx) => {
			row.toggleClass("is-selected", idx === this.selectedIndex);
			if (idx === this.selectedIndex) {
				row.scrollIntoView({ block: "nearest" });
			}
		});
	}

	private positionSuggesterPopup(inputBox: HTMLElement): void {
		if (!this.popupEl) return;
		const rect = inputBox.getBoundingClientRect();
		const popupWidth = 320;
		const estimatedHeight = Math.min(340, this.candidates.length * 46 + 40);

		let left = rect.left;
		if (left + popupWidth > window.innerWidth - 12) {
			left = Math.max(12, window.innerWidth - popupWidth - 12);
		}

		let top = rect.bottom + 6;
		if (top + estimatedHeight > window.innerHeight - 12) {
			top = Math.max(12, rect.top - estimatedHeight - 6);
		}

		this.popupEl.style.left = `${left}px`;
		this.popupEl.style.top = `${top}px`;
		this.popupEl.style.width = `${popupWidth}px`;
	}

	private commitSuggesterChoice(file: TFile): void {
		const inputBox = this.activeInputBox;
		const match = this.activeMatch;
		if (!inputBox || !inputBox.isConnected || !match) {
			this.closeSuggester();
			return;
		}

		const linkText = match.isEmbed
			? this.formatMediaEmbed(file)
			: this.formatNoteLink(file);
		const fullText = inputBox.textContent ?? "";
		const edited = replaceTextRange(fullText, match.start, match.end, linkText);

		inputBox.textContent = edited.text;
		inputBox.focus();
		this.setSelectionOffsets(inputBox, edited.caretStart, edited.caretEnd);
		this.closeSuggester();
	}

	private closeSuggester(): void {
		if (this.popupEl) {
			this.popupEl.remove();
			this.popupEl = null;
			this.listEl = null;
			this.footerEl = null;
		}
		this.activeMatch = null;
		this.candidates = [];
		this.selectedIndex = 0;
	}

	// --- Caret / selection DOM helpers & detached-editor recovery ---

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

		const mind = this.host.getMind();
		if (!mind || !editingNode) return;
		if (nextText.trim() !== "") {
			await mind.reshapeNode(editingNode, { topic: nextText });
		}
		if (keepEditing) {
			await mind.beginEdit(editingNode);
			const reopened = this.canvasHostEl?.querySelector(
				"#input-box"
			) as HTMLElement | null;
			if (reopened) {
				reopened.textContent = nextText;
				reopened.focus();
				this.setSelectionOffsets(reopened, caretStart, caretEnd);
			}
		}
	}
}
