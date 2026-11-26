import {
	normalizeExternalUrlInput,
	type RichMarkKind,
} from "../parser/inlineNodeContent";

const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"avif",
]);

export function isImageExtension(extension: string): boolean {
	return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

function isEmbeddableExtension(extension: string): boolean {
	const lower = extension.toLowerCase();
	return lower === "md" || IMAGE_EXTENSIONS.has(lower);
}

export interface VaultFileMeta {
	path: string;
	basename: string;
	name: string;
	extension: string;
	folderPath: string;
	mtime: number;
}

export interface LinkCandidate<TFileRef = VaultFileMeta> extends VaultFileMeta {
	file: TFileRef;
}

export interface SelectionRange {
	start: number;
	end: number;
}

export interface InputBoxSnapshot {
	connected: boolean;
	text: string;
	selection: SelectionRange;
}

export interface LinkPopupViewModel<TFileRef = VaultFileMeta> {
	isOpen: boolean;
	isEmbed: boolean;
	footerText: string;
	candidates: LinkCandidate<TFileRef>[];
	selectedIndex: number;
}

export type InlineFormatKind =
	| "bold"
	| "italic"
	| "strikethrough"
	| "highlight"
	| "code"
	| "external-link";

export interface SuggesterKeyEvent {
	key: string;
	isComposing?: boolean;
}

export type SuggesterKeyAction = "handled" | "ignored";

export interface SelectedNodeSnapshot<TNodeRef> {
	node: TNodeRef;
	topic: string;
}

export interface PendingExternalLinkState {
	fullText: string;
	selection: SelectionRange;
	label: string;
}

export type FormatToolbarVisibility = "hidden" | "format-bar" | "url-bar";

export function resolveRichShortcutMark(evt: {
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	key: string;
}): RichMarkKind | null {
	if (!(evt.ctrlKey || evt.metaKey) || evt.altKey) return null;
	const lower = evt.key.toLowerCase();
	if (lower === "b" && !evt.shiftKey) return "bold";
	if (lower === "i" && !evt.shiftKey) return "italic";
	if (lower === "e" && !evt.shiftKey) return "code";
	if (lower === "x" && evt.shiftKey) return "strikethrough";
	if (lower === "h" && evt.shiftKey) return "highlight";
	return null;
}

export function insertImageEmbedIntoText(
	text: string,
	selection: SelectionRange,
	fileName: string
): TextEditResult {
	const safeStart = Math.max(0, Math.min(selection.start, text.length));
	const safeEnd = Math.max(safeStart, Math.min(selection.end, text.length));
	const before = text.slice(0, safeStart);
	const needsLeadingBreak = before.length > 0 && !before.endsWith("\n");
	const insertion = `${needsLeadingBreak ? "\n" : ""}![[${fileName}]]`;
	return replaceTextRange(text, safeStart, safeEnd, insertion);
}

export function decideTextBlurAction(params: {
	relatedInsideCard: boolean;
	relatedInsidePopup: boolean;
	relatedInsideToolbar: boolean;
	hasPendingExternalLink: boolean;
}): "keep-editing" | "commit" {
	if (
		params.relatedInsideCard ||
		params.relatedInsidePopup ||
		params.relatedInsideToolbar ||
		params.hasPendingExternalLink
	) {
		return "keep-editing";
	}
	return "commit";
}

export function decideUrlBarBlurAction(params: {
	relatedInsideToolbar: boolean;
	relatedInsideCard: boolean;
}): "keep-url-bar" | "cancel-to-editor" | "cancel-and-commit" {
	if (params.relatedInsideToolbar) return "keep-url-bar";
	if (params.relatedInsideCard) return "cancel-to-editor";
	return "cancel-and-commit";
}

export interface NodeInlineEditorAdapter<TFileRef, TNodeRef> {
	listVaultCandidates(): LinkCandidate<TFileRef>[];
	createFuzzyScorer(query: string): (text: string) => { score: number } | null;
	generateMarkdownLink(file: TFileRef): string;
	getFileMeta(file: TFileRef): Pick<VaultFileMeta, "name" | "basename" | "extension">;

	readInputBox(): InputBoxSnapshot | null;
	writeInputBox(
		text: string,
		selection: SelectionRange,
		keepEditing: boolean
	): void;
	blurInputBox(): void;
	renderSuggester(state: LinkPopupViewModel<TFileRef>): void;

	getSelectedNode(): SelectedNodeSnapshot<TNodeRef> | null;
	reshapeNodeTopic(node: TNodeRef, topic: string): Promise<void>;
	reopenNodeEditor(
		node: TNodeRef,
		text: string,
		selection: SelectionRange
	): Promise<void>;
}

interface LinkTriggerMatch {
	isEmbed: boolean;
	start: number;
	end: number;
	query: string;
}

interface TextEditResult {
	text: string;
	caretStart: number;
	caretEnd: number;
}

const FORMAT_SPECS: Record<
	Exclude<InlineFormatKind, "external-link">,
	{ prefix: string; suffix: string; placeholder: string }
> = {
	bold: { prefix: "**", suffix: "**", placeholder: "加粗文本" },
	italic: { prefix: "*", suffix: "*", placeholder: "斜体文本" },
	strikethrough: { prefix: "~~", suffix: "~~", placeholder: "删除文本" },
	highlight: { prefix: "==", suffix: "==", placeholder: "高亮文本" },
	code: { prefix: "`", suffix: "`", placeholder: "code" },
};

function findLinkTrigger(text: string, caret: number): LinkTriggerMatch | null {
	const safeCaret = Math.max(0, Math.min(caret, text.length));
	const before = text.slice(0, safeCaret);
	const regexMatch = before.match(/(!?)\[\[([^[\]\n|]*)$/);
	if (!regexMatch || regexMatch.index === undefined) {
		return null;
	}

	const isEmbed = regexMatch[1] === "!";
	const query = regexMatch[2] ?? "";
	const start = regexMatch.index;
	const after = text.slice(safeCaret);
	const closingLen = after.startsWith("]]") ? 2 : 0;

	return {
		isEmbed,
		start,
		end: safeCaret + closingLen,
		query,
	};
}

function rankLinkCandidates<TFileRef>(
	files: readonly LinkCandidate<TFileRef>[],
	query: string,
	isEmbed: boolean,
	createScorer: (query: string) => (text: string) => { score: number } | null,
	limit = 15
): LinkCandidate<TFileRef>[] {
	const pool = isEmbed
		? files.filter((file) => isEmbeddableExtension(file.extension))
		: files.filter((file) => file.extension.toLowerCase() === "md");

	const trimmed = query.trim();
	if (!trimmed) {
		return [...pool].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
	}

	const scoreText = createScorer(trimmed);
	const scored: Array<{ file: LinkCandidate<TFileRef>; score: number }> = [];

	for (const file of pool) {
		const nameRes = scoreText(file.basename);
		const pathRes = scoreText(file.path);
		const best =
			nameRes && pathRes
				? Math.max(nameRes.score + 5, pathRes.score)
				: nameRes
					? nameRes.score + 5
					: pathRes
						? pathRes.score
						: null;
		if (best !== null) {
			scored.push({ file, score: best });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((entry) => entry.file);
}

function formatWikiLink(generatedLink: string, basename: string): string {
	const trimmed = generatedLink.trim();
	if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
		return trimmed;
	}
	return `[[${basename}]]`;
}

function formatEmbedLink(
	fileName: string,
	basename: string,
	extension: string
): string {
	if (extension.toLowerCase() === "md") {
		return `![[${basename}]]`;
	}
	return `![[${fileName}]]`;
}

function replaceTextRange(
	text: string,
	start: number,
	end: number,
	replacement: string,
	caretStartOffset = replacement.length,
	caretEndOffset = replacement.length
): TextEditResult {
	const safeStart = Math.max(0, Math.min(start, text.length));
	const safeEnd = Math.max(safeStart, Math.min(end, text.length));
	const nextText = text.slice(0, safeStart) + replacement + text.slice(safeEnd);
	return {
		text: nextText,
		caretStart: safeStart + caretStartOffset,
		caretEnd: safeStart + caretEndOffset,
	};
}

function wrapTextSelection(
	text: string,
	start: number,
	end: number,
	prefix: string,
	suffix: string,
	placeholder: string
): TextEditResult {
	const safeStart = Math.max(0, Math.min(start, text.length));
	const safeEnd = Math.max(safeStart, Math.min(end, text.length));
	const selected = text.slice(safeStart, safeEnd);
	const inner = selected || placeholder;
	const wrapped = `${prefix}${inner}${suffix}`;
	return replaceTextRange(
		text,
		safeStart,
		safeEnd,
		wrapped,
		prefix.length,
		prefix.length + inner.length
	);
}

function wrapExternalLink(
	text: string,
	start: number,
	end: number,
	defaultLabel = "链接"
): TextEditResult {
	const safeStart = Math.max(0, Math.min(start, text.length));
	const safeEnd = Math.max(safeStart, Math.min(end, text.length));
	const selected = text.slice(safeStart, safeEnd);
	const label = selected || defaultLabel;
	const mdLink = `[${label}](https://)`;
	return replaceTextRange(
		text,
		safeStart,
		safeEnd,
		mdLink,
		label.length + 3,
		mdLink.length - 1
	);
}

function getSuggesterFooterText(isEmbed: boolean): string {
	return isEmbed
		? "↑↓ 选择附件/笔记  ·  Enter 插入嵌入  ·  Esc 关闭"
		: "↑↓ 选择笔记  ·  Enter 插入双链  ·  Esc 关闭";
}

function cycleSelectionIndex(
	current: number,
	length: number,
	delta: number
): number {
	if (length <= 0) return 0;
	return ((current + delta) % length + length) % length;
}

/**
 * Deep Node Inline Editor session module owning:
 * - Link Suggestion state machine (trigger detection, per-session vault caching,
 *   deduplicated refreshes, query-change index reset, IME-safe keyboard commit)
 * - Inline text formatting, range replacement, and detached-editor recovery
 * - Canonical wikilink & embed insertion for both active inline edits and selected Nodes
 */
export class NodeInlineEditorSession<TFileRef, TNodeRef> {
	private adapter: NodeInlineEditorAdapter<TFileRef, TNodeRef>;
	private cachedVaultCandidates: LinkCandidate<TFileRef>[] | null = null;
	private activeMatch: LinkTriggerMatch | null = null;
	private candidates: LinkCandidate<TFileRef>[] = [];
	private selectedIndex = 0;
	private lastTriggerKey: string | null = null;
	private lastQueryKey: string | null = null;
	private pendingExternalLink: PendingExternalLinkState | null = null;

	constructor(adapter: NodeInlineEditorAdapter<TFileRef, TNodeRef>) {
		this.adapter = adapter;
	}

	public isSuggesterOpen(): boolean {
		return this.activeMatch !== null && this.candidates.length > 0;
	}

	public hasPendingExternalLink(): boolean {
		return this.pendingExternalLink !== null;
	}

	public getPendingExternalLink(): PendingExternalLinkState | null {
		return this.pendingExternalLink;
	}

	public resolveFormatToolbarVisibility(params: {
		isRichEditing: boolean;
		isPointerSelecting: boolean;
		hasNonEmptySelection: boolean;
	}): FormatToolbarVisibility {
		if (!params.isRichEditing) return "hidden";
		if (params.isPointerSelecting) return "hidden";
		if (this.pendingExternalLink) return "url-bar";
		if (this.isSuggesterOpen()) return "hidden";
		return params.hasNonEmptySelection ? "format-bar" : "hidden";
	}

	public beginExternalLink(
		fullText: string,
		selection: SelectionRange,
		defaultLabel = "链接"
	): PendingExternalLinkState {
		const safeStart = Math.max(0, Math.min(selection.start, fullText.length));
		const safeEnd = Math.max(safeStart, Math.min(selection.end, fullText.length));
		const label = fullText.slice(safeStart, safeEnd).trim() || defaultLabel;
		this.pendingExternalLink = {
			fullText,
			selection: { start: safeStart, end: safeEnd },
			label,
		};
		return this.pendingExternalLink;
	}

	public confirmExternalLink(
		rawUrl: string
	): { ok: true; text: string; selection: SelectionRange } | { ok: false } {
		const pending = this.pendingExternalLink;
		if (!pending) return { ok: false };

		const normalized = normalizeExternalUrlInput(rawUrl);
		if (!normalized) return { ok: false };

		this.pendingExternalLink = null;
		const mdLink = `[${pending.label}](${normalized})`;
		const edited = replaceTextRange(
			pending.fullText,
			pending.selection.start,
			pending.selection.end,
			mdLink
		);
		return {
			ok: true,
			text: edited.text,
			selection: { start: edited.caretStart, end: edited.caretEnd },
		};
	}

	public cancelExternalLink(): PendingExternalLinkState | null {
		const pending = this.pendingExternalLink;
		this.pendingExternalLink = null;
		return pending;
	}

	public refreshSuggester(): void {
		const snapshot = this.adapter.readInputBox();
		if (!snapshot || !snapshot.connected) {
			this.closeSuggester();
			return;
		}

		const match = findLinkTrigger(snapshot.text, snapshot.selection.start);
		if (!match) {
			this.closeSuggester();
			return;
		}

		const triggerKey = `${match.isEmbed}:${match.start}:${match.end}:${match.query}`;
		if (triggerKey === this.lastTriggerKey && this.isSuggesterOpen()) {
			return;
		}

		if (this.cachedVaultCandidates === null) {
			this.cachedVaultCandidates = this.adapter.listVaultCandidates();
		}

		const ranked = rankLinkCandidates(
			this.cachedVaultCandidates,
			match.query,
			match.isEmbed,
			(query) => this.adapter.createFuzzyScorer(query)
		);

		this.lastTriggerKey = triggerKey;
		if (ranked.length === 0) {
			this.hidePopupKeepingCache();
			return;
		}

		const queryKey = `${match.isEmbed}:${match.query}`;
		if (queryKey !== this.lastQueryKey) {
			this.selectedIndex = 0;
			this.lastQueryKey = queryKey;
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, ranked.length - 1);
		}

		this.activeMatch = match;
		this.candidates = ranked;
		this.emitPopupState();
	}

	public handleSuggesterKeyDown(evt: SuggesterKeyEvent): SuggesterKeyAction {
		if (!this.isSuggesterOpen()) return "ignored";

		if (evt.key === "ArrowDown") {
			this.selectedIndex = cycleSelectionIndex(
				this.selectedIndex,
				this.candidates.length,
				1
			);
			this.emitPopupState();
			return "handled";
		}

		if (evt.key === "ArrowUp") {
			this.selectedIndex = cycleSelectionIndex(
				this.selectedIndex,
				this.candidates.length,
				-1
			);
			this.emitPopupState();
			return "handled";
		}

		if (evt.key === "Enter" || evt.key === "Tab") {
			if (evt.isComposing) return "ignored";
			this.chooseSuggesterIndex(this.selectedIndex);
			return "handled";
		}

		if (evt.key === "Escape") {
			this.closeSuggester();
			return "handled";
		}

		return "ignored";
	}

	public hoverSuggesterIndex(index: number): void {
		if (!this.isSuggesterOpen()) return;
		if (index < 0 || index >= this.candidates.length) return;
		if (index === this.selectedIndex) return;
		this.selectedIndex = index;
		this.emitPopupState();
	}

	public chooseSuggesterIndex(index: number): void {
		const candidate = this.candidates[index];
		const match = this.activeMatch;
		const snapshot = this.adapter.readInputBox();
		if (!candidate || !match || !snapshot || !snapshot.connected) {
			this.closeSuggester();
			return;
		}

		const linkText = this.formatLink(candidate.file, match.isEmbed);
		const edited = replaceTextRange(
			snapshot.text,
			match.start,
			match.end,
			linkText
		);
		this.adapter.writeInputBox(
			edited.text,
			{ start: edited.caretStart, end: edited.caretEnd },
			true
		);
		this.closeSuggester();
	}

	public closeSuggester(): void {
		const wasOpen = this.activeMatch !== null || this.candidates.length > 0;
		this.cachedVaultCandidates = null;
		this.activeMatch = null;
		this.candidates = [];
		this.selectedIndex = 0;
		this.lastTriggerKey = null;
		this.lastQueryKey = null;
		if (wasOpen) {
			this.emitPopupState();
		}
	}

	public onInputBlur(): void {
		this.pendingExternalLink = null;
		this.closeSuggester();
	}

	public commitActiveEdit(): void {
		this.pendingExternalLink = null;
		this.closeSuggester();
		this.adapter.blurInputBox();
	}

	public async applyInlineFormat(
		editingNode: TNodeRef | null,
		fullText: string,
		selection: SelectionRange,
		kind: InlineFormatKind
	): Promise<void> {
		const edited =
			kind === "external-link"
				? wrapExternalLink(fullText, selection.start, selection.end)
				: wrapTextSelection(
						fullText,
						selection.start,
						selection.end,
						FORMAT_SPECS[kind].prefix,
						FORMAT_SPECS[kind].suffix,
						FORMAT_SPECS[kind].placeholder
					);
		await this.commitEditedText(
			editingNode,
			edited.text,
			{ start: edited.caretStart, end: edited.caretEnd },
			true
		);
	}

	public async replaceSelectionText(
		editingNode: TNodeRef | null,
		fullText: string,
		selection: SelectionRange,
		replacement: string,
		keepEditing = true
	): Promise<void> {
		const edited = replaceTextRange(
			fullText,
			selection.start,
			selection.end,
			replacement
		);
		await this.commitEditedText(
			editingNode,
			edited.text,
			{ start: edited.caretStart, end: edited.caretEnd },
			keepEditing
		);
	}

	public async insertFileIntoSelection(
		editingNode: TNodeRef | null,
		fullText: string,
		selection: SelectionRange,
		file: TFileRef,
		isEmbed: boolean
	): Promise<void> {
		const linkText = this.formatLink(file, isEmbed);
		const edited = replaceTextRange(
			fullText,
			selection.start,
			selection.end,
			linkText
		);
		await this.commitEditedText(
			editingNode,
			edited.text,
			{ start: edited.caretStart, end: edited.caretEnd },
			false
		);
	}

	public async restoreSelection(
		editingNode: TNodeRef | null,
		fullText: string,
		selection: SelectionRange
	): Promise<void> {
		await this.commitEditedText(editingNode, fullText, selection, true);
	}

	public async appendFileToSelectedNode(
		file: TFileRef,
		isEmbed: boolean
	): Promise<boolean> {
		const selected = this.adapter.getSelectedNode();
		if (!selected) return false;

		const linkText = this.formatLink(file, isEmbed);
		const separator = isEmbed ? "\n" : " ";
		const nextTopic = selected.topic
			? `${selected.topic}${separator}${linkText}`
			: linkText;
		await this.adapter.reshapeNodeTopic(selected.node, nextTopic);
		return true;
	}

	private formatLink(file: TFileRef, isEmbed: boolean): string {
		const meta = this.adapter.getFileMeta(file);
		if (isEmbed) {
			return formatEmbedLink(meta.name, meta.basename, meta.extension);
		}
		const generated = this.adapter.generateMarkdownLink(file);
		return formatWikiLink(generated, meta.basename);
	}

	private async commitEditedText(
		editingNode: TNodeRef | null,
		nextText: string,
		selection: SelectionRange,
		keepEditing: boolean
	): Promise<void> {
		const current = this.adapter.readInputBox();
		if (current?.connected) {
			this.adapter.writeInputBox(nextText, selection, keepEditing);
			return;
		}

		if (!editingNode) return;
		if (nextText.trim() !== "") {
			await this.adapter.reshapeNodeTopic(editingNode, nextText);
		}
		if (keepEditing) {
			await this.adapter.reopenNodeEditor(editingNode, nextText, selection);
		}
	}

	private hidePopupKeepingCache(): void {
		const wasOpen = this.activeMatch !== null || this.candidates.length > 0;
		this.activeMatch = null;
		this.candidates = [];
		this.selectedIndex = 0;
		this.lastQueryKey = null;
		if (wasOpen) {
			this.emitPopupState();
		}
	}

	private emitPopupState(): void {
		const isOpen = this.isSuggesterOpen();
		const isEmbed = this.activeMatch?.isEmbed ?? false;
		this.adapter.renderSuggester({
			isOpen,
			isEmbed,
			footerText: getSuggesterFooterText(isEmbed),
			candidates: this.candidates,
			selectedIndex: this.selectedIndex,
		});
	}
}
