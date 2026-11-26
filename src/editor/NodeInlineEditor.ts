import { App, Menu, Notice, TFile, prepareFuzzySearch, setIcon } from "obsidian";
import type MindElixir from "mind-elixir";
import type { Topic } from "mind-elixir";
import { ImageSuggestModal, NoteLinkSuggestModal } from "../modals/VaultSuggestModals";
import {
	NodeInlineEditorSession,
	type InlineFormatKind,
	type LinkCandidate,
	type LinkPopupViewModel,
	type SelectionRange,
} from "./NodeInlineEditorSession";
import {
	IMAGE_SIZE_PRESETS,
	RICH_MARK_DELIMITERS,
	applyImageSizePreset,
	formatImageSizeLabel,
	getImageSizePreset,
	normalizeCommittedTopic,
	normalizeExternalUrlInput,
	parseNodeTopicToRichNodes,
	serializeImageAttachment,
	wrapMarkMarkdown,
	type InlineEditNode,
	type NodeImageAttachment,
	type RichMarkKind,
} from "./nodeRichContent";

export interface NodeInlineEditorHost {
	getMind: () => MindElixir | null;
	getSourcePath: () => string;
	resolveVaultImage: (target: string) => string | null;
	savePastedImage: (blob: Blob) => Promise<TFile>;
	onRelinkNeeded: () => void;
}

interface RichEditSession {
	mind: MindElixir;
	tpc: Topic;
	nodeId: string;
	originalTopic: string;
	rawEditFallback: (el: Topic) => void;
	cardEl: HTMLElement;
	textEl: HTMLElement;
	finished: boolean;
}

interface PendingExternalLinkContext {
	richSession: RichEditSession;
	fullText: string;
	selection: SelectionRange;
	label: string;
}

const ZWSP = "\u200B";

function getFileExtension(pathOrName: string): string {
	const dotIdx = pathOrName.lastIndexOf(".");
	return dotIdx === -1 ? "" : pathOrName.slice(dotIdx + 1).toLowerCase();
}

function createTextWithBreaks(
	doc: Document,
	text: string
): Array<Text | HTMLBRElement> {
	const parts = text.split("\n");
	const nodes: Array<Text | HTMLBRElement> = [];
	for (let i = 0; i < parts.length; i++) {
		if (parts[i]) {
			nodes.push(doc.createTextNode(parts[i]));
		}
		if (i < parts.length - 1) {
			nodes.push(doc.createElement("br"));
		}
	}
	return nodes;
}

function isBlockElement(el: Element): boolean {
	const tag = el.tagName.toUpperCase();
	return tag === "DIV" || tag === "P";
}

function isAtomicChipElement(node: Node | null): node is HTMLElement {
	return (
		node !== null &&
		node.nodeType === Node.ELEMENT_NODE &&
		Boolean((node as HTMLElement).dataset.chipKind)
	);
}

function getElementMarkKind(node: Node | null): RichMarkKind | null {
	if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
	const el = node as HTMLElement;
	const attr = el.dataset.mdMark;
	if (
		attr === "bold" ||
		attr === "italic" ||
		attr === "strikethrough" ||
		attr === "highlight" ||
		attr === "code"
	) {
		return attr;
	}
	switch (el.tagName.toUpperCase()) {
		case "STRONG":
		case "B":
			return "bold";
		case "EM":
		case "I":
			return "italic";
		case "DEL":
		case "S":
		case "STRIKE":
			return "strikethrough";
		case "MARK":
			return "highlight";
		case "CODE":
			return "code";
		default:
			return null;
	}
}

function createMarkElement(doc: Document, mark: RichMarkKind): HTMLElement {
	switch (mark) {
		case "bold": {
			const el = doc.createElement("strong");
			el.dataset.mdMark = "bold";
			return el;
		}
		case "italic": {
			const el = doc.createElement("em");
			el.dataset.mdMark = "italic";
			return el;
		}
		case "strikethrough": {
			const el = doc.createElement("del");
			el.dataset.mdMark = "strikethrough";
			return el;
		}
		case "highlight": {
			const el = doc.createElement("mark");
			el.className = "mm-highlight";
			el.dataset.mdMark = "highlight";
			return el;
		}
		case "code": {
			const el = doc.createElement("code");
			el.className = "mm-inline-code";
			el.dataset.mdMark = "code";
			return el;
		}
	}
}

function isZwspOnlyText(node: Node | null): boolean {
	return (
		node !== null &&
		node.nodeType === Node.TEXT_NODE &&
		(node.textContent ?? "").replace(/\u200B/g, "") === ""
	);
}

function cleanTextLength(text: string): number {
	return text.replace(/\u200B/g, "").replace(/\u00A0/g, " ").length;
}

function mapCleanOffsetToRawIndex(rawText: string, cleanOffset: number): number {
	if (cleanOffset <= 0) {
		let idx = 0;
		while (idx < rawText.length && rawText[idx] === ZWSP) {
			idx++;
		}
		return idx;
	}
	let seen = 0;
	for (let i = 0; i < rawText.length; i++) {
		if (rawText[i] === ZWSP) continue;
		seen++;
		if (seen >= cleanOffset) {
			return i + 1;
		}
	}
	return rawText.length;
}

function serializeChildrenToMarkdown(el: HTMLElement, isRoot: boolean): string {
	const children = Array.from(el.childNodes);
	let out = "";
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		const childIsBlock =
			child.nodeType === Node.ELEMENT_NODE && isBlockElement(child as Element);

		if (childIsBlock && out.length > 0 && !out.endsWith("\n")) {
			out += "\n";
		}

		// Handle Chromium's <div><br></div> empty-line wrapper inside contenteditable
		if (
			childIsBlock &&
			child.childNodes.length === 1 &&
			child.firstChild?.nodeType === Node.ELEMENT_NODE &&
			(child.firstChild as Element).tagName.toUpperCase() === "BR"
		) {
			if (i < children.length - 1) {
				out += "\n";
			}
			continue;
		}

		// Ignore a trailing browser sentinel <br> when followed only by empty/ZWSP text
		if (
			isRoot &&
			child.nodeType === Node.ELEMENT_NODE &&
			(child as Element).tagName.toUpperCase() === "BR" &&
			out.endsWith("\n") &&
			children.slice(i + 1).every((n) => isZwspOnlyText(n))
		) {
			continue;
		}

		out += serializeRichTextNode(child, false);

		if (childIsBlock && i < children.length - 1 && !out.endsWith("\n")) {
			out += "\n";
		}
	}
	return out;
}

function serializeRichTextNode(node: Node, isRoot = false): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return (node.textContent ?? "")
			.replace(/\u200B/g, "")
			.replace(/\u00A0/g, " ");
	}
	if (node.nodeType !== Node.ELEMENT_NODE) {
		return "";
	}

	const el = node as HTMLElement;
	if (el.dataset.chipKind && el.dataset.raw) {
		return el.dataset.raw;
	}
	if (el.tagName.toUpperCase() === "BR") {
		return "\n";
	}

	const mark = isRoot ? null : getElementMarkKind(el);
	const inner = serializeChildrenToMarkdown(el, isRoot);
	if (mark) {
		return wrapMarkMarkdown(mark, inner);
	}
	return inner;
}

function unwrapElement(el: HTMLElement): void {
	const parent = el.parentNode;
	if (!parent) return;
	while (el.firstChild) {
		parent.insertBefore(el.firstChild, el);
	}
	el.remove();
}

function stripNestedMarks(
	root: DocumentFragment | HTMLElement,
	predicate: (mark: RichMarkKind) => boolean
): void {
	const elements = Array.from(root.querySelectorAll("*"));
	for (const node of elements) {
		if (!node.instanceOf(HTMLElement)) continue;
		if (node.dataset.chipKind) continue;
		const kind = getElementMarkKind(node);
		if (kind && predicate(kind)) {
			unwrapElement(node);
		}
	}
}

function hasMeaningfulContent(node: Node): boolean {
	if (node.nodeType === Node.TEXT_NODE) {
		return cleanTextLength(node.textContent ?? "") > 0;
	}
	if (node.nodeType === Node.ELEMENT_NODE) {
		const el = node as HTMLElement;
		if (el.dataset.chipKind || el.tagName.toUpperCase() === "BR") return true;
	}
	for (const child of Array.from(node.childNodes)) {
		if (hasMeaningfulContent(child)) return true;
	}
	return false;
}

function findEnclosingMarkElement(
	node: Node | null,
	boundary: HTMLElement,
	mark: RichMarkKind
): HTMLElement | null {
	let cur: Node | null = node;
	while (cur && cur !== boundary) {
		if (getElementMarkKind(cur) === mark) {
			return cur as HTMLElement;
		}
		cur = cur.parentNode;
	}
	return null;
}

function normalizeMarkSiblings(container: HTMLElement): void {
	const children = Array.from(container.childNodes);
	for (const child of children) {
		if (child.nodeType !== Node.ELEMENT_NODE) continue;
		const el = child as HTMLElement;
		if (el.dataset.chipKind) continue;
		normalizeMarkSiblings(el);

		const mark = getElementMarkKind(el);
		if (!mark) continue;

		// Remove completely empty mark wrappers (keep if containing ZWSP while editing)
		if (el.childNodes.length === 0) {
			el.remove();
			continue;
		}

		const prev = el.previousSibling;
		if (prev && getElementMarkKind(prev) === mark) {
			const prevEl = prev as HTMLElement;
			while (el.firstChild) {
				prevEl.appendChild(el.firstChild);
			}
			el.remove();
		}
	}
}

/**
 * Obsidian/DOM adapter for the Node Inline Editor:
 * - Phase 1 + Phase 2 WYSIWYG Rich Editor: renders inline formatting (bold, italic,
 *   strikethrough, highlight, code) plus inline images, wikilinks, external links,
 *   and tags in exact document order with zero raw Markdown symbols
 * - Floating selection format toolbar + keyboard shortcuts (Ctrl/Cmd+B/I/E/Shift+H/X)
 * - Preserves raw Markdown fallback via context menu ("编辑原始 Markdown 源码")
 */
export class NodeInlineEditor {
	private app: App;
	private host: NodeInlineEditorHost;
	private session: NodeInlineEditorSession<TFile, Topic>;
	private canvasHostEl: HTMLElement | null = null;
	private activeInputBox: HTMLElement | null = null;
	private activeRichSession: RichEditSession | null = null;
	private popupEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;
	private lastRenderedCandidates: LinkCandidate<TFile>[] | null = null;
	private formatToolbarEl: HTMLElement | null = null;
	private formatToolbarButtons = new Map<RichMarkKind, HTMLButtonElement>();
	private formatBarRowEl: HTMLElement | null = null;
	private urlBarRowEl: HTMLElement | null = null;
	private urlInputEl: HTMLInputElement | null = null;
	private pendingExternalLink: PendingExternalLinkContext | null = null;
	private isPointerSelecting = false;

	private readonly onContextMenuBound: (evt: MouseEvent) => void;
	private readonly onKeyDownBound: (evt: KeyboardEvent) => void;
	private readonly onSelectionChangeBound: () => void;
	private readonly onWindowPointerUpBound: () => void;

	constructor(app: App, host: NodeInlineEditorHost) {
		this.app = app;
		this.host = host;
		this.session = this.createSession();
		this.onContextMenuBound = (evt) => this.handleContextMenu(evt);
		this.onKeyDownBound = (evt) => this.handleSuggesterKeyDown(evt);
		this.onSelectionChangeBound = () => this.updateFloatingFormatToolbar();
		this.onWindowPointerUpBound = () => {
			if (!this.isPointerSelecting) return;
			this.isPointerSelecting = false;
			this.updateFloatingFormatToolbar();
		};
	}

	public attach(canvasHostEl: HTMLElement): void {
		this.detach();
		this.canvasHostEl = canvasHostEl;
		canvasHostEl.addEventListener("contextmenu", this.onContextMenuBound, true);
		canvasHostEl.addEventListener("keydown", this.onKeyDownBound, true);
		activeDocument.addEventListener("selectionchange", this.onSelectionChangeBound);
		activeDocument.addEventListener("pointerup", this.onWindowPointerUpBound, true);
		activeDocument.addEventListener(
			"pointercancel",
			this.onWindowPointerUpBound,
			true
		);
	}

	public detach(): void {
		this.commitActiveEdit();
		this.destroyFormatToolbarDom();
		this.session.closeSuggester();
		this.isPointerSelecting = false;
		activeDocument.removeEventListener(
			"selectionchange",
			this.onSelectionChangeBound
		);
		activeDocument.removeEventListener(
			"pointerup",
			this.onWindowPointerUpBound,
			true
		);
		activeDocument.removeEventListener(
			"pointercancel",
			this.onWindowPointerUpBound,
			true
		);
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
		this.destroyFormatToolbarDom();
		if (this.activeRichSession) {
			this.cleanupRichSessionDom(this.activeRichSession);
			this.activeRichSession = null;
		}
		this.session.closeSuggester();
		this.activeInputBox = null;
	}

	public commitActiveEdit(): void {
		if (this.activeRichSession) {
			this.commitRichSession(this.activeRichSession);
			return;
		}
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
		if (this.activeRichSession && !this.activeRichSession.finished) {
			this.insertImageAtCaretInRichSession(this.activeRichSession, file.name);
			return true;
		}
		return this.session.appendFileToSelectedNode(file, true);
	}

	/**
	 * Opens the WYSIWYG rich inline editor (inline marks + atomic image,
	 * wikilink, external link, and tag widgets) in place of MindElixir's #input-box.
	 */
	public openRichEditor(
		mind: MindElixir,
		tpc: Topic,
		rawEditFallback: (el: Topic) => void
	): void {
		if (!tpc || tpc.nodeObj.dangerouslySetInnerHTML) return;

		if (this.activeRichSession) {
			this.commitRichSession(this.activeRichSession);
		}

		const originalTopic = tpc.nodeObj.topic ?? "";
		const richNodes = parseNodeTopicToRichNodes(originalTopic);
		const hasRichWidget = richNodes.some((n) => n.kind !== "text");
		const doc = tpc.ownerDocument;
		const isRoot = Boolean(tpc.closest(".me-root"));

		const cardEl = doc.createElement("div");
		cardEl.id = "input-box";
		cardEl.className = `mm-rich-editor${isRoot ? " is-root" : ""}`;

		const textEl = doc.createElement("div");
		textEl.className = "mm-rich-editor-text";
		textEl.contentEditable = "true";
		textEl.spellcheck = false;
		textEl.setAttribute("data-placeholder", "输入节点内容...");

		cardEl.appendChild(textEl);

		this.applyNodeVisualStyleToEditor(mind, tpc, cardEl);
		mind.nodes.appendChild(cardEl);

		tpc.addClass("mm-editing-node");

		const richSession: RichEditSession = {
			mind,
			tpc,
			nodeId: tpc.nodeObj.id,
			originalTopic,
			rawEditFallback,
			cardEl,
			textEl,
			finished: false,
		};

		this.activeRichSession = richSession;
		this.activeInputBox = textEl;

		this.renderRichNodesIntoTextEl(textEl, richNodes);

		mind.bus.fire("operation", {
			name: "beginEdit",
			target: tpc.nodeObj,
		});

		this.bindRichEditorEvents(richSession);

		textEl.focus();
		if (!hasRichWidget && originalTopic === "新节点") {
			this.selectAllInElement(textEl);
		} else {
			this.placeCaretAtEnd(textEl);
		}
	}

	/**
	 * Fallback alignment & suggester binding when MindElixir's native plaintext
	 * #input-box is opened (e.g. via "编辑原始 Markdown 源码").
	 */
	public onBeginNodeEdit(mind: MindElixir, nodeId: string): void {
		if (this.activeRichSession && this.activeRichSession.nodeId === nodeId) {
			return;
		}

		const inputBox = mind.nodes.querySelector<HTMLElement>("#input-box");
		if (!inputBox || inputBox.classList.contains("mm-rich-editor")) return;

		this.activeInputBox = inputBox;

		let tpc: HTMLElement | null = null;
		try {
			tpc = mind.findEle(nodeId);
		} catch {
			tpc = mind.currentNode;
		}

		if (tpc) {
			this.alignInputBoxOverNode(mind, tpc, inputBox, false);
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

	private applyNodeVisualStyleToEditor(
		mind: MindElixir,
		tpc: HTMLElement,
		cardEl: HTMLElement
	): void {
		this.alignInputBoxOverNode(mind, tpc, cardEl, false);
		const computed = getComputedStyle(tpc);
		const props: Record<string, string> = {
			color: computed.color,
			"font-size": computed.fontSize,
			"font-weight": computed.fontWeight,
			padding: computed.padding,
			"border-radius": computed.borderRadius,
		};
		if (computed.backgroundColor && computed.backgroundColor !== "rgba(0, 0, 0, 0)") {
			props["background-color"] = computed.backgroundColor;
		}
		if (computed.border && !computed.border.startsWith("0px")) {
			props.border = computed.border;
		}
		cardEl.setCssProps(props);
	}

	private renderRichNodesIntoTextEl(
		textEl: HTMLElement,
		nodes: readonly InlineEditNode[]
	): void {
		textEl.empty();
		this.appendRichNodes(textEl, nodes);
		this.ensureCaretAnchors(textEl);
	}

	private appendRichNodes(
		container: HTMLElement,
		nodes: readonly InlineEditNode[]
	): void {
		const doc = container.ownerDocument;
		for (const node of nodes) {
			if (node.kind === "text") {
				for (const domNode of createTextWithBreaks(doc, node.text)) {
					container.appendChild(domNode);
				}
				continue;
			}
			if (node.kind === "mark") {
				const markEl = createMarkElement(doc, node.mark);
				this.appendRichNodes(markEl, node.children);
				container.appendChild(markEl);
				continue;
			}
			if (node.kind === "image") {
				container.appendChild(this.createImageWidgetElement(doc, node));
				continue;
			}
			container.appendChild(this.createInlineChipElement(doc, node));
		}
	}

	/**
	 * Ensures Chromium always has a real Text node anchor before a leading atomic
	 * widget, between adjacent atomic widgets, and after a trailing atomic widget
	 * or inline code span so the blinking cursor can land anywhere cleanly.
	 */
	private ensureCaretAnchors(container: HTMLElement): void {
		const doc = container.ownerDocument;
		const children = Array.from(container.childNodes);
		if (children.length === 0) return;

		if (isAtomicChipElement(children[0])) {
			container.insertBefore(doc.createTextNode(ZWSP), children[0]);
		}

		for (let i = 0; i < children.length - 1; i++) {
			if (
				isAtomicChipElement(children[i]) &&
				isAtomicChipElement(children[i + 1])
			) {
				container.insertBefore(doc.createTextNode(ZWSP), children[i + 1]);
			}
		}

		const last = container.lastChild;
		if (
			isAtomicChipElement(last) ||
			getElementMarkKind(last) === "code" ||
			(last?.nodeType === Node.ELEMENT_NODE &&
				(last as Element).tagName.toUpperCase() === "BR")
		) {
			container.appendChild(doc.createTextNode(ZWSP));
		}
	}

	private createInlineChipElement(
		doc: Document,
		node: Extract<InlineEditNode, { kind: "wikilink" | "extlink" | "tag" }>
	): HTMLElement {
		const chip = doc.createElement("span");
		chip.className = `mm-edit-chip mm-edit-chip-${node.kind}`;
		chip.contentEditable = "false";
		chip.dataset.chipKind = node.kind;
		chip.dataset.raw = node.raw;

		if (node.kind === "wikilink") {
			chip.dataset.target = node.target;
			chip.title = node.raw;
		} else if (node.kind === "extlink") {
			chip.dataset.url = node.url;
			chip.title = node.url;
		} else {
			chip.title = node.raw;
		}

		const labelEl = doc.createElement("span");
		labelEl.className = "mm-edit-chip-label";
		labelEl.textContent = node.kind === "tag" ? `#${node.tag}` : node.label;
		chip.appendChild(labelEl);

		const removeBtn = doc.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "mm-edit-chip-remove";
		removeBtn.tabIndex = -1;
		removeBtn.setAttribute("aria-label", "移除");
		removeBtn.textContent = "×";
		removeBtn.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		removeBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.removeChipAndRestoreFocus(chip);
		});
		chip.appendChild(removeBtn);

		return chip;
	}

	private createImageWidgetElement(
		doc: Document,
		seg: Extract<InlineEditNode, { kind: "image" }>
	): HTMLElement {
		let currentImage: NodeImageAttachment = {
			kind: seg.imageKind,
			target: seg.target,
			alt: seg.alt,
			size: seg.size,
		};

		const wrapper = doc.createElement("span");
		wrapper.className = "mm-edit-image-chip";
		wrapper.contentEditable = "false";
		wrapper.dataset.chipKind = "image";
		wrapper.dataset.raw = seg.raw;

		const resolvedUrl = this.resolveAttachmentUrl(currentImage);
		let imgEl: HTMLImageElement | null = null;

		if (resolvedUrl) {
			const preset = getImageSizePreset(currentImage.size);
			imgEl = doc.createElement("img");
			imgEl.className = `mm-rich-media-img${preset !== "auto" ? ` is-size-${preset}` : ""}`;
			imgEl.src = resolvedUrl;
			imgEl.alt = currentImage.alt || currentImage.target;
			imgEl.draggable = false;
			wrapper.appendChild(imgEl);
		} else {
			const broken = doc.createElement("span");
			broken.className = "mm-rich-media-broken";
			broken.textContent = `🖼️ ${currentImage.alt || currentImage.target}`;
			wrapper.appendChild(broken);
		}

		const actions = doc.createElement("span");
		actions.className = "mm-rich-media-actions";

		const sizeButtons: Array<{
			preset: (typeof IMAGE_SIZE_PRESETS)[number];
			btn: HTMLButtonElement;
		}> = [];
		if (currentImage.kind === "obsidian") {
			const initialPreset = getImageSizePreset(currentImage.size);
			for (const preset of IMAGE_SIZE_PRESETS) {
				const sizeBtn = doc.createElement("button");
				sizeBtn.type = "button";
				sizeBtn.tabIndex = -1;
				sizeBtn.className = `mm-rich-media-btn${preset === initialPreset ? " is-active" : ""}`;
				sizeBtn.textContent = formatImageSizeLabel(preset);
				sizeBtn.title = preset === "auto" ? "自动尺寸" : `宽度设为 ${preset}px`;
				sizeBtn.addEventListener("mousedown", (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
				});
				sizeBtn.addEventListener("click", (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
					currentImage = applyImageSizePreset(currentImage, preset);
					wrapper.dataset.raw = serializeImageAttachment(currentImage);
					if (imgEl) {
						imgEl.className = `mm-rich-media-img${preset !== "auto" ? ` is-size-${preset}` : ""}`;
					}
					for (const item of sizeButtons) {
						item.btn.toggleClass("is-active", item.preset === preset);
					}
					this.placeCaretAfterNode(wrapper);
				});
				sizeButtons.push({ preset, btn: sizeBtn });
				actions.appendChild(sizeBtn);
			}
		}

		const delBtn = doc.createElement("button");
		delBtn.type = "button";
		delBtn.tabIndex = -1;
		delBtn.className = "mm-rich-media-btn mm-rich-media-delete";
		delBtn.setAttribute("aria-label", "删除图片");
		delBtn.title = "删除图片";
		setIcon(delBtn, "x");
		delBtn.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		delBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.removeChipAndRestoreFocus(wrapper);
		});
		actions.appendChild(delBtn);

		wrapper.appendChild(actions);

		wrapper.addEventListener("mousedown", (evt) => {
			const target = evt.target as HTMLElement | null;
			if (target?.closest(".mm-rich-media-actions")) return;
			evt.preventDefault();
			evt.stopPropagation();
			const rect = wrapper.getBoundingClientRect();
			const clickOnLeftEdge =
				evt.clientX < rect.left + Math.min(24, rect.width * 0.25);
			if (clickOnLeftEdge) {
				this.placeCaretBeforeNode(wrapper);
			} else {
				this.placeCaretAfterNode(wrapper);
			}
		});

		return wrapper;
	}

	private removeChipAndRestoreFocus(chip: HTMLElement): void {
		const parent = chip.parentElement;
		const textEl = this.activeRichSession?.textEl ?? parent;
		if (!parent || !textEl) {
			chip.remove();
			return;
		}
		const children = Array.from(parent.childNodes);
		const idx = children.indexOf(chip);
		chip.remove();
		normalizeMarkSiblings(textEl);
		this.ensureCaretAnchors(textEl);
		textEl.focus();

		const sel = window.getSelection();
		if (sel && parent.isConnected) {
			const nextChildren = Array.from(parent.childNodes);
			const clampedIdx = Math.max(0, Math.min(idx, nextChildren.length));
			const range = textEl.ownerDocument.createRange();
			range.setStart(parent, clampedIdx);
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
		}
		this.session.refreshSuggester();
		this.updateFloatingFormatToolbar();
	}

	private placeCaretBeforeNode(target: HTMLElement): void {
		const parent = target.parentElement;
		const textEl = this.activeRichSession?.textEl ?? parent;
		if (!parent || !textEl) return;
		this.ensureCaretAnchors(parent);
		textEl.focus();

		const prev = target.previousSibling;
		const sel = window.getSelection();
		if (!sel) return;
		const range = textEl.ownerDocument.createRange();
		if (prev && prev.nodeType === Node.TEXT_NODE) {
			range.setStart(prev, (prev.textContent ?? "").length);
		} else {
			const idx = Array.from(parent.childNodes).indexOf(target);
			range.setStart(parent, Math.max(0, idx));
		}
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
		this.session.refreshSuggester();
		this.updateFloatingFormatToolbar();
	}

	private placeCaretAfterNode(target: HTMLElement): void {
		const parent = target.parentElement;
		const textEl = this.activeRichSession?.textEl ?? parent;
		if (!parent || !textEl) return;
		this.ensureCaretAnchors(parent);
		textEl.focus();

		const next = target.nextSibling;
		const sel = window.getSelection();
		if (!sel) return;
		const range = textEl.ownerDocument.createRange();
		if (next && next.nodeType === Node.TEXT_NODE) {
			const len = (next.textContent ?? "").length;
			const pos = isZwspOnlyText(next) ? len : 0;
			range.setStart(next, pos);
		} else {
			const idx = Array.from(parent.childNodes).indexOf(target);
			range.setStart(parent, Math.max(0, idx + 1));
		}
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
		this.session.refreshSuggester();
		this.updateFloatingFormatToolbar();
	}

	private resolveAttachmentUrl(image: NodeImageAttachment): string | null {
		if (image.kind === "markdown") {
			const trimmed = image.target.trim();
			if (/^(https?:\/\/|data:image\/|app:\/\/|capacitor:\/\/)/i.test(trimmed)) {
				return trimmed;
			}
		}
		return this.host.resolveVaultImage(image.target);
	}

	private insertImageAtCaretInRichSession(
		richSession: RichEditSession,
		fileName: string
	): void {
		const { textEl } = richSession;
		const snap = this.readRichTextSnapshot(textEl);
		const before = snap.text.slice(0, snap.selection.start);
		const after = snap.text.slice(snap.selection.end);
		const needsLeadingBreak = before.length > 0 && !before.endsWith("\n");
		const insertion = `${needsLeadingBreak ? "\n" : ""}![[${fileName}]]`;
		const nextText = `${before}${insertion}${after}`;
		const nextCaret = before.length + insertion.length;
		this.writeRichTextSnapshot(
			richSession,
			nextText,
			{ start: nextCaret, end: nextCaret },
			true
		);
	}

	/**
	 * Toggles an inline WYSIWYG mark (bold/italic/strikethrough/highlight/code)
	 * directly on the live DOM Selection with zero raw Markdown symbols and zero flicker.
	 */
	private toggleMarkOnSelection(
		richSession: RichEditSession,
		mark: RichMarkKind
	): void {
		const { textEl } = richSession;
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;

		const range = sel.getRangeAt(0);
		if (
			!textEl.contains(range.startContainer) ||
			!textEl.contains(range.endContainer)
		) {
			return;
		}

		const doc = textEl.ownerDocument;
		const enclosingMark = findEnclosingMarkElement(
			range.commonAncestorContainer,
			textEl,
			mark
		);

		// 1. Collapsed caret toggle (enter or exit mark for subsequent typing)
		if (range.collapsed) {
			if (enclosingMark) {
				this.exitMarkAtCollapsedCaret(textEl, enclosingMark, range);
			} else {
				const markEl = createMarkElement(doc, mark);
				const zwspNode = doc.createTextNode(ZWSP);
				markEl.appendChild(zwspNode);
				range.insertNode(markEl);
				const nextRange = doc.createRange();
				nextRange.setStart(zwspNode, 1);
				nextRange.collapse(true);
				sel.removeAllRanges();
				sel.addRange(nextRange);
			}
			this.ensureCaretAnchors(textEl);
			this.updateFloatingFormatToolbar();
			return;
		}

		// 2. Non-empty selection already enclosed by this mark -> unwrap (splitting if partial)
		if (enclosingMark) {
			this.unwrapMarkForSelection(textEl, enclosingMark, range, mark);
			normalizeMarkSiblings(textEl);
			this.ensureCaretAnchors(textEl);
			this.updateFloatingFormatToolbar();
			return;
		}

		// 3. Non-empty selection not enclosed by this mark -> wrap cleanly
		const extracted = range.extractContents();
		if (!hasMeaningfulContent(extracted)) {
			range.insertNode(extracted);
			return;
		}

		if (mark === "code") {
			stripNestedMarks(extracted, () => true);
		} else {
			stripNestedMarks(extracted, (k) => k === mark);
		}

		const markEl = createMarkElement(doc, mark);
		markEl.appendChild(extracted);
		range.insertNode(markEl);

		normalizeMarkSiblings(textEl);
		this.ensureCaretAnchors(textEl);

		const nextRange = doc.createRange();
		if (markEl.isConnected) {
			nextRange.selectNodeContents(markEl);
		} else {
			nextRange.selectNodeContents(textEl);
			nextRange.collapse(false);
		}
		sel.removeAllRanges();
		sel.addRange(nextRange);
		this.updateFloatingFormatToolbar();
	}

	private exitMarkAtCollapsedCaret(
		textEl: HTMLElement,
		markEl: HTMLElement,
		range: Range
	): void {
		const doc = textEl.ownerDocument;
		const sel = window.getSelection();
		if (!sel || !markEl.parentNode) return;

		const afterRange = doc.createRange();
		afterRange.setStart(range.endContainer, range.endOffset);
		afterRange.setEnd(markEl, markEl.childNodes.length);
		const afterFrag = afterRange.extractContents();

		const caretAnchor = doc.createTextNode(ZWSP);
		const parent = markEl.parentNode;

		if (hasMeaningfulContent(afterFrag)) {
			const markKind = getElementMarkKind(markEl);
			const rightMark = markKind
				? createMarkElement(doc, markKind)
				: (markEl.cloneNode(false) as HTMLElement);
			rightMark.appendChild(afterFrag);
			parent.insertBefore(rightMark, markEl.nextSibling);
			parent.insertBefore(caretAnchor, rightMark);
		} else {
			parent.insertBefore(caretAnchor, markEl.nextSibling);
		}

		if (!hasMeaningfulContent(markEl)) {
			markEl.remove();
		}

		const nextRange = doc.createRange();
		nextRange.setStart(caretAnchor, 1);
		nextRange.collapse(true);
		sel.removeAllRanges();
		sel.addRange(nextRange);
	}

	private unwrapMarkForSelection(
		textEl: HTMLElement,
		markEl: HTMLElement,
		range: Range,
		mark: RichMarkKind
	): void {
		const doc = textEl.ownerDocument;
		const sel = window.getSelection();
		if (!sel || !markEl.parentNode) return;

		const beforeRange = doc.createRange();
		beforeRange.setStart(markEl, 0);
		beforeRange.setEnd(range.startContainer, range.startOffset);

		const afterRange = doc.createRange();
		afterRange.setStart(range.endContainer, range.endOffset);
		afterRange.setEnd(markEl, markEl.childNodes.length);

		const afterFrag = afterRange.extractContents();
		const selectedFrag = range.extractContents();
		const beforeFrag = beforeRange.extractContents();

		const parent = markEl.parentNode;
		const insertBeforeRef = markEl.nextSibling;
		markEl.remove();

		if (hasMeaningfulContent(beforeFrag)) {
			const leftEl = createMarkElement(doc, mark);
			leftEl.appendChild(beforeFrag);
			parent.insertBefore(leftEl, insertBeforeRef);
		}

		const selectedNodes = Array.from(selectedFrag.childNodes);
		for (const node of selectedNodes) {
			parent.insertBefore(node, insertBeforeRef);
		}

		if (hasMeaningfulContent(afterFrag)) {
			const rightEl = createMarkElement(doc, mark);
			rightEl.appendChild(afterFrag);
			parent.insertBefore(rightEl, insertBeforeRef);
		}

		if (selectedNodes.length > 0) {
			const nextRange = doc.createRange();
			nextRange.setStartBefore(selectedNodes[0]);
			nextRange.setEndAfter(selectedNodes[selectedNodes.length - 1]);
			sel.removeAllRanges();
			sel.addRange(nextRange);
		} else {
			textEl.focus();
		}
	}

	private getActiveMarksForSelection(textEl: HTMLElement): Set<RichMarkKind> {
		const active = new Set<RichMarkKind>();
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return active;
		const range = sel.getRangeAt(0);
		if (!textEl.contains(range.commonAncestorContainer)) return active;

		let cur: Node | null = range.commonAncestorContainer;
		while (cur && cur !== textEl) {
			const kind = getElementMarkKind(cur);
			if (kind) active.add(kind);
			cur = cur.parentNode;
		}
		return active;
	}

	private updateFloatingFormatToolbar(): void {
		const richSession = this.activeRichSession;
		if (!richSession || richSession.finished) {
			this.destroyFormatToolbarDom();
			return;
		}

		// Keep toolbar hidden while actively dragging a text selection
		if (this.isPointerSelecting) {
			this.hideFormatToolbar();
			return;
		}

		// Keep toolbar open while user is typing a URL in the inline external-link bar
		if (this.pendingExternalLink) {
			return;
		}

		if (this.session.isSuggesterOpen()) {
			this.hideFormatToolbar();
			return;
		}

		const { textEl } = richSession;
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
			this.hideFormatToolbar();
			return;
		}

		const range = sel.getRangeAt(0);
		if (
			!textEl.contains(range.startContainer) ||
			!textEl.contains(range.endContainer)
		) {
			this.hideFormatToolbar();
			return;
		}

		const selectedText = range.toString().replace(/\u200B/g, "");
		if (!selectedText.trim()) {
			this.hideFormatToolbar();
			return;
		}

		this.ensureFormatToolbarDom();
		if (!this.formatToolbarEl) return;

		this.formatToolbarEl.removeClass("mm-is-hidden");
		this.formatBarRowEl?.removeClass("mm-is-hidden");
		this.urlBarRowEl?.addClass("mm-is-hidden");

		const activeMarks = this.getActiveMarksForSelection(textEl);
		for (const [mark, btn] of this.formatToolbarButtons.entries()) {
			btn.toggleClass("is-active", activeMarks.has(mark));
		}

		this.positionFormatToolbar(range);
	}

	private ensureFormatToolbarDom(): void {
		if (this.formatToolbarEl) return;

		const toolbar = activeDocument.body.createDiv({
			cls: "mm-format-toolbar mm-is-hidden",
		});
		toolbar.addEventListener("mousedown", (evt) => {
			if (evt.target !== this.urlInputEl) {
				evt.preventDefault();
			}
			evt.stopPropagation();
		});

		const barRow = toolbar.createDiv({ cls: "mm-format-toolbar-row" });
		const markSpecs: Array<{
			mark: RichMarkKind;
			icon: string;
			title: string;
		}> = [
			{ mark: "bold", icon: "bold", title: "加粗 (Ctrl+B)" },
			{ mark: "italic", icon: "italic", title: "斜体 (Ctrl+I)" },
			{ mark: "strikethrough", icon: "strikethrough", title: "删除线 (Ctrl+Shift+X)" },
			{ mark: "highlight", icon: "highlighter", title: "高亮 (Ctrl+Shift+H)" },
			{ mark: "code", icon: "code", title: "行内代码 (Ctrl+E)" },
		];

		this.formatToolbarButtons.clear();
		for (const spec of markSpecs) {
			const btn = barRow.createEl("button", {
				cls: "mm-format-btn",
				attr: { type: "button", title: spec.title, "aria-label": spec.title },
			});
			setIcon(btn, spec.icon);
			btn.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				if (this.activeRichSession && !this.activeRichSession.finished) {
					this.toggleMarkOnSelection(this.activeRichSession, spec.mark);
				}
			});
			this.formatToolbarButtons.set(spec.mark, btn);
		}

		barRow.createDiv({ cls: "mm-format-divider" });

		const wikiBtn = barRow.createEl("button", {
			cls: "mm-format-btn",
			attr: { type: "button", title: "转为双链 [[笔记]]", "aria-label": "转为双链" },
		});
		setIcon(wikiBtn, "link");
		wikiBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const richSession = this.activeRichSession;
			if (!richSession || richSession.finished) return;
			const snap = this.readRichTextSnapshot(richSession.textEl);
			this.hideFormatToolbar();
			new NoteLinkSuggestModal(this.app, (file) => {
				void this.session.insertFileIntoSelection(
					richSession.tpc,
					snap.text,
					snap.selection,
					file,
					false
				);
			}).open();
		});

		const extBtn = barRow.createEl("button", {
			cls: "mm-format-btn",
			attr: { type: "button", title: "添加外部链接", "aria-label": "添加外部链接" },
		});
		setIcon(extBtn, "external-link");
		extBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.openInlineExternalLinkBar();
		});

		const imgBtn = barRow.createEl("button", {
			cls: "mm-format-btn",
			attr: { type: "button", title: "插入库内图片", "aria-label": "插入库内图片" },
		});
		setIcon(imgBtn, "image-plus");
		imgBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const richSession = this.activeRichSession;
			if (!richSession || richSession.finished) return;
			const snap = this.readRichTextSnapshot(richSession.textEl);
			this.hideFormatToolbar();
			new ImageSuggestModal(this.app, (file) => {
				void this.session.insertFileIntoSelection(
					richSession.tpc,
					snap.text,
					snap.selection,
					file,
					true
				);
			}).open();
		});

		// Inline external-link URL bar (avoids showing raw [label](https://) syntax)
		const urlRow = toolbar.createDiv({
			cls: "mm-format-url-row mm-is-hidden",
		});
		const urlInput = urlRow.createEl("input", {
			cls: "mm-format-url-input",
			attr: {
				type: "text",
				placeholder: "粘贴或输入链接地址 (https://...)",
			},
		});
		const confirmBtn = urlRow.createEl("button", {
			cls: "mm-format-btn mm-format-url-confirm",
			attr: { type: "button", title: "确认添加链接", "aria-label": "确认" },
		});
		setIcon(confirmBtn, "check");
		const cancelBtn = urlRow.createEl("button", {
			cls: "mm-format-btn",
			attr: { type: "button", title: "取消", "aria-label": "取消" },
		});
		setIcon(cancelBtn, "x");

		urlInput.addEventListener("keydown", (evt) => {
			evt.stopPropagation();
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.confirmInlineExternalLink();
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				this.cancelInlineExternalLink(true);
			}
		});
		urlInput.addEventListener("blur", (evt) => {
			const related = evt.relatedTarget as Node | null;
			if (related && this.formatToolbarEl?.contains(related)) {
				return;
			}
			const pending = this.pendingExternalLink;
			if (!pending) return;
			this.cancelInlineExternalLink(false);
			if (
				!related ||
				!pending.richSession.cardEl.contains(related)
			) {
				this.commitRichSession(pending.richSession);
			}
		});
		confirmBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.confirmInlineExternalLink();
		});
		cancelBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.cancelInlineExternalLink(true);
		});

		this.formatToolbarEl = toolbar;
		this.formatBarRowEl = barRow;
		this.urlBarRowEl = urlRow;
		this.urlInputEl = urlInput;
	}

	private openInlineExternalLinkBar(): void {
		const richSession = this.activeRichSession;
		if (!richSession || richSession.finished) return;

		const snap = this.readRichTextSnapshot(richSession.textEl);
		const label =
			snap.text.slice(snap.selection.start, snap.selection.end).trim() || "链接";

		this.pendingExternalLink = {
			richSession,
			fullText: snap.text,
			selection: snap.selection,
			label,
		};

		this.ensureFormatToolbarDom();
		this.formatToolbarEl?.removeClass("mm-is-hidden");
		this.formatBarRowEl?.addClass("mm-is-hidden");
		this.urlBarRowEl?.removeClass("mm-is-hidden");

		if (this.urlInputEl) {
			this.urlInputEl.value = "";
			this.urlInputEl.focus();
		}
	}

	private confirmInlineExternalLink(): void {
		const pending = this.pendingExternalLink;
		const rawUrl = this.urlInputEl?.value ?? "";
		if (!pending) return;

		const normalized = normalizeExternalUrlInput(rawUrl);
		if (!normalized) {
			new Notice("请输入有效的链接地址（如 https://example.com）");
			this.urlInputEl?.focus();
			return;
		}

		this.pendingExternalLink = null;
		this.hideFormatToolbar();

		const { richSession, fullText, selection, label } = pending;
		if (richSession.finished) return;

		const mdLink = `[${label}](${normalized})`;
		const nextText =
			fullText.slice(0, selection.start) +
			mdLink +
			fullText.slice(selection.end);
		const nextCaret = selection.start + mdLink.length;

		this.writeRichTextSnapshot(
			richSession,
			nextText,
			{ start: nextCaret, end: nextCaret },
			true
		);
	}

	private cancelInlineExternalLink(restoreFocus: boolean): void {
		const pending = this.pendingExternalLink;
		this.pendingExternalLink = null;
		this.hideFormatToolbar();
		if (restoreFocus && pending && !pending.richSession.finished) {
			pending.richSession.textEl.focus();
			this.setSelectionInRichText(
				pending.richSession.textEl,
				pending.selection.start,
				pending.selection.end
			);
		}
	}

	private positionFormatToolbar(range: Range): void {
		if (!this.formatToolbarEl) return;
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			this.hideFormatToolbar();
			return;
		}

		const barWidth = this.formatToolbarEl.offsetWidth || 260;
		const barHeight = this.formatToolbarEl.offsetHeight || 34;

		let left = rect.left + rect.width / 2 - barWidth / 2;
		left = Math.max(12, Math.min(left, window.innerWidth - barWidth - 12));

		let top = rect.top - barHeight - 8;
		if (top < 12) {
			top = Math.min(window.innerHeight - barHeight - 12, rect.bottom + 8);
		}

		this.formatToolbarEl.setCssProps({
			"--mm-format-left": `${Math.round(left)}px`,
			"--mm-format-top": `${Math.round(top)}px`,
		});
	}

	private hideFormatToolbar(): void {
		this.formatToolbarEl?.addClass("mm-is-hidden");
	}

	private destroyFormatToolbarDom(): void {
		this.pendingExternalLink = null;
		if (this.formatToolbarEl) {
			this.formatToolbarEl.remove();
			this.formatToolbarEl = null;
			this.formatBarRowEl = null;
			this.urlBarRowEl = null;
			this.urlInputEl = null;
			this.formatToolbarButtons.clear();
		}
	}

	private findAdjacentChipForDeletion(
		textEl: HTMLElement,
		direction: "backward" | "forward"
	): HTMLElement | null {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
		const range = sel.getRangeAt(0);
		if (!textEl.contains(range.startContainer)) return null;

		const container = range.startContainer;
		const offset = range.startOffset;

		if (container.nodeType === Node.ELEMENT_NODE) {
			const children = Array.from(container.childNodes);
			let idx = direction === "backward" ? offset - 1 : offset;
			while (idx >= 0 && idx < children.length && isZwspOnlyText(children[idx])) {
				idx += direction === "backward" ? -1 : 1;
			}
			const candidate = children[idx] ?? null;
			return isAtomicChipElement(candidate) ? candidate : null;
		}

		if (container.nodeType === Node.TEXT_NODE && container.parentNode) {
			const raw = container.textContent ?? "";
			if (direction === "backward") {
				const beforeClean = raw.slice(0, offset).replace(/\u200B/g, "");
				if (beforeClean.length > 0) return null;
				let prev: Node | null = container.previousSibling;
				while (prev && isZwspOnlyText(prev)) {
					prev = prev.previousSibling;
				}
				return isAtomicChipElement(prev) ? prev : null;
			} else {
				const afterClean = raw.slice(offset).replace(/\u200B/g, "");
				if (afterClean.length > 0) return null;
				let next: Node | null = container.nextSibling;
				while (next && isZwspOnlyText(next)) {
					next = next.nextSibling;
				}
				return isAtomicChipElement(next) ? next : null;
			}
		}

		return null;
	}

	private bindRichEditorEvents(richSession: RichEditSession): void {
		const { cardEl, textEl } = richSession;

		// Isolate pointer & mouse events so MindElixir's PanHelper / BoxSelect
		// never steals pointer capture or starts marquee selection while selecting text
		cardEl.addEventListener("pointerdown", (evt) => {
			evt.stopPropagation();
			if (evt.button === 0) {
				this.isPointerSelecting = true;
				this.hideFormatToolbar();
			}
		});
		cardEl.addEventListener("pointermove", (evt) => {
			evt.stopPropagation();
		});
		cardEl.addEventListener("pointerup", (evt) => {
			evt.stopPropagation();
			if (this.isPointerSelecting) {
				this.isPointerSelecting = false;
				this.updateFloatingFormatToolbar();
			}
		});
		cardEl.addEventListener("pointercancel", (evt) => {
			evt.stopPropagation();
			this.isPointerSelecting = false;
		});
		cardEl.addEventListener("mousedown", (evt) => {
			evt.stopPropagation();
		});
		cardEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (evt.target === cardEl) {
				const sel = window.getSelection();
				if (!sel || sel.isCollapsed) {
					this.placeCaretAtEnd(textEl);
				}
			}
		});
		cardEl.addEventListener("dblclick", (evt) => {
			evt.stopPropagation();
		});

		const refreshSuggester = () => this.session.refreshSuggester();
		textEl.addEventListener("input", () => {
			this.ensureCaretAnchors(textEl);
			refreshSuggester();
			this.updateFloatingFormatToolbar();
		});
		textEl.addEventListener("click", () => {
			refreshSuggester();
			this.updateFloatingFormatToolbar();
		});
		textEl.addEventListener("mouseup", () => {
			this.updateFloatingFormatToolbar();
		});
		textEl.addEventListener("keyup", (evt) => {
			this.updateFloatingFormatToolbar();
			if (
				evt.key === "ArrowUp" ||
				evt.key === "ArrowDown" ||
				evt.key === "Enter" ||
				evt.key === "Tab" ||
				evt.key === "Escape"
			) {
				return;
			}
			refreshSuggester();
		});

		textEl.addEventListener("keydown", (evt) => {
			evt.stopPropagation();

			if (evt.isComposing || evt.key === "Process") {
				return;
			}

			if (this.session.isSuggesterOpen()) {
				const action = this.session.handleSuggesterKeyDown({
					key: evt.key,
					isComposing: evt.isComposing,
				});
				if (action === "handled") {
					evt.preventDefault();
					return;
				}
			}

			// WYSIWYG inline formatting shortcuts
			if ((evt.ctrlKey || evt.metaKey) && !evt.altKey) {
				const lowerKey = evt.key.toLowerCase();
				if (lowerKey === "b" && !evt.shiftKey) {
					evt.preventDefault();
					this.toggleMarkOnSelection(richSession, "bold");
					return;
				}
				if (lowerKey === "i" && !evt.shiftKey) {
					evt.preventDefault();
					this.toggleMarkOnSelection(richSession, "italic");
					return;
				}
				if (lowerKey === "e" && !evt.shiftKey) {
					evt.preventDefault();
					this.toggleMarkOnSelection(richSession, "code");
					return;
				}
				if (lowerKey === "x" && evt.shiftKey) {
					evt.preventDefault();
					this.toggleMarkOnSelection(richSession, "strikethrough");
					return;
				}
				if (lowerKey === "h" && evt.shiftKey) {
					evt.preventDefault();
					this.toggleMarkOnSelection(richSession, "highlight");
					return;
				}
			}

			if (evt.key === "Backspace" || evt.key === "Delete") {
				const adjacentChip = this.findAdjacentChipForDeletion(
					textEl,
					evt.key === "Backspace" ? "backward" : "forward"
				);
				if (adjacentChip) {
					evt.preventDefault();
					this.removeChipAndRestoreFocus(adjacentChip);
					return;
				}
			}

			if (evt.key === "Enter" && evt.shiftKey) {
				evt.preventDefault();
				const snap = this.readRichTextSnapshot(textEl);
				const nextText =
					snap.text.slice(0, snap.selection.start) +
					"\n" +
					snap.text.slice(snap.selection.end);
				const nextCaret = snap.selection.start + 1;
				this.writeRichTextSnapshot(
					richSession,
					nextText,
					{ start: nextCaret, end: nextCaret },
					true
				);
				return;
			}

			if (evt.key === "Enter" || evt.key === "Tab") {
				evt.preventDefault();
				this.commitRichSession(richSession);
				return;
			}

			if (evt.key === "Escape") {
				evt.preventDefault();
				this.cancelRichSession(richSession);
			}
		});

		textEl.addEventListener("paste", (evt) => {
			evt.stopPropagation();
			const clipboardData = evt.clipboardData;
			if (!clipboardData) return;

			const imageItem = Array.from(clipboardData.items).find((item) =>
				item.type.startsWith("image/")
			);
			if (imageItem) {
				evt.preventDefault();
				const blob = imageItem.getAsFile();
				if (!blob) return;
				void this.host.savePastedImage(blob).then((createdFile) => {
					if (this.activeRichSession === richSession && !richSession.finished) {
						this.insertImageAtCaretInRichSession(richSession, createdFile.name);
						new Notice(`已粘贴图片到节点：${createdFile.name}`);
					}
				});
				return;
			}

			const plainText = clipboardData.getData("text/plain");
			evt.preventDefault();
			if (!plainText) return;

			const current = this.readRichTextSnapshot(textEl);
			const nextText =
				current.text.slice(0, current.selection.start) +
				plainText +
				current.text.slice(current.selection.end);
			const nextCaret = current.selection.start + plainText.length;
			this.writeRichTextSnapshot(
				richSession,
				nextText,
				{ start: nextCaret, end: nextCaret },
				true
			);
			this.session.refreshSuggester();
		});

		textEl.addEventListener("blur", (evt) => {
			const related = evt.relatedTarget as Node | null;
			if (
				related &&
				(cardEl.contains(related) ||
					this.popupEl?.contains(related) ||
					this.formatToolbarEl?.contains(related))
			) {
				return;
			}
			if (this.pendingExternalLink) {
				return;
			}
			this.commitRichSession(richSession);
		});
	}

	private commitRichSession(richSession: RichEditSession): void {
		if (richSession.finished) return;
		richSession.finished = true;

		this.pendingExternalLink = null;
		this.isPointerSelecting = false;
		this.hideFormatToolbar();

		const rawSerialized = serializeRichTextNode(richSession.textEl, true);
		const nextTopic = normalizeCommittedTopic(rawSerialized);

		this.cleanupRichSessionDom(richSession);
		if (this.activeRichSession === richSession) {
			this.activeRichSession = null;
		}
		if (this.activeInputBox === richSession.textEl) {
			this.activeInputBox = null;
		}
		this.session.onInputBlur();

		const { mind, tpc, originalTopic } = richSession;
		if (nextTopic !== "" && nextTopic !== originalTopic) {
			void Promise.resolve(mind.reshapeNode(tpc, { topic: nextTopic })).then(
				() => {
					this.host.onRelinkNeeded();
				}
			);
		}

		mind.container?.focus();
	}

	private cancelRichSession(richSession: RichEditSession): void {
		if (richSession.finished) return;
		richSession.finished = true;

		this.pendingExternalLink = null;
		this.isPointerSelecting = false;
		this.hideFormatToolbar();

		this.cleanupRichSessionDom(richSession);
		if (this.activeRichSession === richSession) {
			this.activeRichSession = null;
		}
		if (this.activeInputBox === richSession.textEl) {
			this.activeInputBox = null;
		}
		this.session.onInputBlur();
		richSession.mind.container?.focus();
	}

	private cleanupRichSessionDom(richSession: RichEditSession): void {
		richSession.cardEl.remove();
		richSession.tpc.removeClass("mm-editing-node");
	}

	private switchRichSessionToRawSource(richSession: RichEditSession): void {
		const { tpc, rawEditFallback } = richSession;
		this.commitRichSession(richSession);
		rawEditFallback(tpc);
	}

	private readRichTextSnapshot(textEl: HTMLElement): {
		text: string;
		selection: SelectionRange;
	} {
		const text = serializeRichTextNode(textEl, true);
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			return { text, selection: { start: text.length, end: text.length } };
		}
		const range = sel.getRangeAt(0);
		if (
			!textEl.contains(range.startContainer) ||
			!textEl.contains(range.endContainer)
		) {
			return { text, selection: { start: text.length, end: text.length } };
		}

		const start = this.computeOffsetInRichText(
			textEl,
			range.startContainer,
			range.startOffset
		);
		const end = this.computeOffsetInRichText(
			textEl,
			range.endContainer,
			range.endOffset
		);
		return {
			text,
			selection: {
				start: Math.min(start, end),
				end: Math.max(start, end),
			},
		};
	}

	private computeOffsetInRichText(
		textEl: HTMLElement,
		targetNode: Node,
		targetOffset: number
	): number {
		let total = 0;
		let found = false;

		const walk = (node: Node, isRoot: boolean): void => {
			if (found) return;

			const mark =
				!isRoot && node.nodeType === Node.ELEMENT_NODE
					? getElementMarkKind(node)
					: null;
			const markDelimLen = mark ? RICH_MARK_DELIMITERS[mark].length : 0;

			if (node === targetNode) {
				if (node.nodeType === Node.TEXT_NODE) {
					const rawSlice = (node.textContent ?? "").slice(0, targetOffset);
					total += cleanTextLength(rawSlice);
					found = true;
					return;
				}
				if (mark) {
					total += markDelimLen;
				}
				const children = Array.from(node.childNodes);
				const limit = Math.min(targetOffset, children.length);
				for (let i = 0; i < limit; i++) {
					total += serializeRichTextNode(children[i], false).length;
				}
				found = true;
				return;
			}

			if (node.nodeType === Node.TEXT_NODE) {
				total += serializeRichTextNode(node, false).length;
				return;
			}

			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const el = node as HTMLElement;
			if (el.dataset.chipKind && el.dataset.raw) {
				total += el.dataset.raw.length;
				return;
			}
			if (el.tagName.toUpperCase() === "BR") {
				total += 1;
				return;
			}

			if (mark) {
				total += markDelimLen;
			}

			const children = Array.from(el.childNodes);
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (
					!isRoot &&
					child.nodeType === Node.ELEMENT_NODE &&
					isBlockElement(child as Element) &&
					i > 0
				) {
					total += 1;
				}
				walk(child, false);
				if (found) return;
			}

			if (mark) {
				total += markDelimLen;
			}
		};

		walk(textEl, true);
		return total;
	}

	private writeRichTextSnapshot(
		richSession: RichEditSession,
		nextMarkdown: string,
		selection: SelectionRange,
		keepEditing: boolean
	): void {
		const { textEl } = richSession;
		const richNodes = parseNodeTopicToRichNodes(nextMarkdown);
		this.renderRichNodesIntoTextEl(textEl, richNodes);

		if (keepEditing) {
			textEl.focus();
			const serialized = serializeRichTextNode(textEl, true);
			const start = Math.max(0, Math.min(selection.start, serialized.length));
			const end = Math.max(start, Math.min(selection.end, serialized.length));
			this.setSelectionInRichText(textEl, start, end);
			this.updateFloatingFormatToolbar();
		} else {
			this.commitRichSession(richSession);
		}
	}

	private setSelectionInRichText(
		textEl: HTMLElement,
		start: number,
		end: number
	): void {
		const sel = window.getSelection();
		if (!sel) return;

		const resolveInContainer = (
			container: HTMLElement,
			targetOffset: number,
			accRef: { acc: number }
		): { node: Node; offset: number } | null => {
			const children = Array.from(container.childNodes);
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (child.nodeType === Node.TEXT_NODE) {
					const rawText = child.textContent ?? "";
					const len = cleanTextLength(rawText);
					if (targetOffset <= accRef.acc + len) {
						return {
							node: child,
							offset: mapCleanOffsetToRawIndex(
								rawText,
								targetOffset - accRef.acc
							),
						};
					}
					accRef.acc += len;
				} else if (child.nodeType === Node.ELEMENT_NODE) {
					const el = child as HTMLElement;
					const mark = getElementMarkKind(el);
					if (mark) {
						const delimLen = RICH_MARK_DELIMITERS[mark].length;
						const serializedLen = serializeRichTextNode(el, false).length;
						if (targetOffset <= accRef.acc) {
							return { node: container, offset: i };
						}
						if (targetOffset < accRef.acc + serializedLen) {
							accRef.acc += delimLen;
							const innerHit = resolveInContainer(el, targetOffset, accRef);
							if (innerHit) return innerHit;
							return { node: el, offset: el.childNodes.length };
						}
						accRef.acc += serializedLen;
						continue;
					}

					const len =
						el.dataset.chipKind && el.dataset.raw
							? el.dataset.raw.length
							: el.tagName.toUpperCase() === "BR"
								? 1
								: serializeRichTextNode(el, false).length;
					if (targetOffset <= accRef.acc) {
						return { node: container, offset: i };
					}
					if (targetOffset <= accRef.acc + len) {
						const next = children[i + 1];
						if (next && next.nodeType === Node.TEXT_NODE) {
							const nextRaw = next.textContent ?? "";
							return {
								node: next,
								offset: isZwspOnlyText(next) ? nextRaw.length : 0,
							};
						}
						return { node: container, offset: i + 1 };
					}
					accRef.acc += len;
				}
			}
			return null;
		};

		const resolvePos = (targetOffset: number): { node: Node; offset: number } => {
			const hit = resolveInContainer(textEl, targetOffset, { acc: 0 });
			if (hit) return hit;
			const last = textEl.lastChild;
			if (last && last.nodeType === Node.TEXT_NODE) {
				return { node: last, offset: (last.textContent ?? "").length };
			}
			return { node: textEl, offset: textEl.childNodes.length };
		};

		const startPos = resolvePos(start);
		const endPos = resolvePos(end);
		const range = textEl.ownerDocument.createRange();
		range.setStart(startPos.node, startPos.offset);
		range.setEnd(endPos.node, endPos.offset);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	private selectAllInElement(el: HTMLElement): void {
		const sel = window.getSelection();
		if (!sel) return;
		const range = el.ownerDocument.createRange();
		range.selectNodeContents(el);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	private placeCaretAtEnd(el: HTMLElement): void {
		this.ensureCaretAnchors(el);
		el.focus();
		const sel = window.getSelection();
		if (!sel) return;
		const range = el.ownerDocument.createRange();
		const last = el.lastChild;
		if (last && last.nodeType === Node.TEXT_NODE) {
			range.setStart(last, (last.textContent ?? "").length);
		} else {
			range.selectNodeContents(el);
			range.collapse(false);
		}
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
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
				if (this.activeRichSession && !this.activeRichSession.finished) {
					const { textEl } = this.activeRichSession;
					if (!textEl.isConnected) {
						return {
							connected: false,
							text: "",
							selection: { start: 0, end: 0 },
						};
					}
					const snap = this.readRichTextSnapshot(textEl);
					return {
						connected: true,
						text: snap.text,
						selection: snap.selection,
					};
				}

				const inputBox = this.activeInputBox;
				if (!inputBox) return null;
				return {
					connected: inputBox.isConnected,
					text: inputBox.textContent ?? "",
					selection: this.getSelectionOffsets(inputBox),
				};
			},
			writeInputBox: (text, selection, keepEditing) => {
				if (this.activeRichSession && !this.activeRichSession.finished) {
					if (!this.activeRichSession.textEl.isConnected) return;
					this.writeRichTextSnapshot(
						this.activeRichSession,
						text,
						selection,
						keepEditing
					);
					return;
				}

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
				if (this.activeRichSession && !this.activeRichSession.finished) {
					this.commitRichSession(this.activeRichSession);
					return;
				}
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
				this.host.onRelinkNeeded();
			},
			reopenNodeEditor: async (node, text, selection) => {
				const mind = this.host.getMind();
				if (!mind) return;
				await mind.beginEdit(node);
				if (this.activeRichSession && !this.activeRichSession.finished) {
					this.writeRichTextSnapshot(
						this.activeRichSession,
						text,
						selection,
						true
					);
					return;
				}
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
		inputBox: HTMLElement,
		lockMinHeight = false
	): void {
		let left = 0;
		let top = 0;
		let cur: HTMLElement | null = tpc;
		while (cur && cur !== mind.nodes) {
			left += cur.offsetLeft;
			top += cur.offsetTop;
			cur = cur.offsetParent as HTMLElement | null;
		}

		inputBox.style.removeProperty("left");
		inputBox.style.removeProperty("top");
		inputBox.style.removeProperty("right");
		inputBox.style.removeProperty("margin");
		inputBox.style.removeProperty("min-width");
		inputBox.style.removeProperty("min-height");

		inputBox.setCssProps({
			"--mm-input-left": `${left}px`,
			"--mm-input-top": `${top}px`,
			"--mm-input-min-width": `${Math.max(120, tpc.offsetWidth)}px`,
			"--mm-input-min-height": lockMinHeight ? `${tpc.offsetHeight}px` : "auto",
		});
	}

	private handleContextMenu(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		const inputBox = target?.closest<HTMLElement>("#input-box") ?? null;
		if (!inputBox) return;

		evt.preventDefault();
		evt.stopPropagation();

		const richSession =
			this.activeRichSession && !this.activeRichSession.finished
				? this.activeRichSession
				: null;

		const editingNode = richSession?.tpc ?? this.host.getMind()?.currentNode ?? null;
		let fullText: string;
		let selection: SelectionRange;

		if (richSession) {
			this.activeInputBox = richSession.textEl;
			const snap = this.readRichTextSnapshot(richSession.textEl);
			fullText = snap.text;
			selection = snap.selection;
		} else {
			this.activeInputBox = inputBox;
			fullText = inputBox.textContent ?? "";
			selection = this.getSelectionOffsets(inputBox);
		}

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

		if (richSession) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("编辑原始 Markdown 源码")
					.setIcon("code-2")
					.onClick(() => {
						this.switchRichSessionToRawSource(richSession);
					})
			);
		}

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
		if (this.activeRichSession && !this.activeRichSession.finished) {
			return;
		}
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

		this.hideFormatToolbar();

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
				getFileExtension(candidate.name) === "md"
					? candidate.basename
					: candidate.name
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

	private getSelectionOffsets(el: HTMLElement): SelectionRange {
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
