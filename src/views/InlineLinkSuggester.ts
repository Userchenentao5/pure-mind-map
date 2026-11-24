import { App, TFile, prepareFuzzySearch } from "obsidian";

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

interface TriggerMatch {
	isEmbed: boolean;
	start: number;
	end: number;
	query: string;
}

export interface InlineLinkSuggesterHost {
	getSourcePath: () => string;
	getSelectionOffsets: (el: HTMLElement) => { start: number; end: number };
	setSelectionOffsets: (el: HTMLElement, start: number, end: number) => void;
}

export class InlineLinkSuggester {
	private app: App;
	private host: InlineLinkSuggesterHost;
	private popupEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private activeInput: HTMLElement | null = null;
	private activeMatch: TriggerMatch | null = null;
	private items: TFile[] = [];
	private selectedIndex = 0;

	constructor(app: App, host: InlineLinkSuggesterHost) {
		this.app = app;
		this.host = host;
	}

	public isOpen(): boolean {
		return this.popupEl !== null && this.items.length > 0;
	}

	public attachToInput(inputBox: HTMLElement): void {
		this.activeInput = inputBox;

		const refresh = () => this.updateFromInput(inputBox);
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
				this.close();
				if (this.activeInput === inputBox) {
					this.activeInput = null;
				}
			},
			{ once: true }
		);

		refresh();
	}

	/**
	 * Capture-phase keydown handler so ArrowUp/ArrowDown/Enter/Tab/Escape
	 * operate on the popup BEFORE mind-elixir's #input-box listener closes the editor.
	 */
	public handleKeyDown(evt: KeyboardEvent): boolean {
		if (!this.isOpen()) return false;

		if (evt.key === "ArrowDown") {
			evt.preventDefault();
			evt.stopPropagation();
			this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
			this.renderSelection();
			return true;
		}

		if (evt.key === "ArrowUp") {
			evt.preventDefault();
			evt.stopPropagation();
			this.selectedIndex =
				(this.selectedIndex - 1 + this.items.length) % this.items.length;
			this.renderSelection();
			return true;
		}

		if (evt.key === "Enter" || evt.key === "Tab") {
			if (evt.isComposing) return false;
			evt.preventDefault();
			evt.stopPropagation();
			const chosen = this.items[this.selectedIndex];
			if (chosen) {
				this.commitSelection(chosen);
			}
			return true;
		}

		if (evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			this.close();
			return true;
		}

		return false;
	}

	public close(): void {
		if (this.popupEl) {
			this.popupEl.remove();
			this.popupEl = null;
			this.listEl = null;
		}
		this.activeMatch = null;
		this.items = [];
		this.selectedIndex = 0;
	}

	private updateFromInput(inputBox: HTMLElement): void {
		if (!inputBox.isConnected) {
			this.close();
			return;
		}

		const text = inputBox.textContent ?? "";
		const { start: caret } = this.host.getSelectionOffsets(inputBox);
		const match = this.findTriggerMatch(text, caret);
		if (!match) {
			this.close();
			return;
		}

		const candidates = this.searchFiles(match.query, match.isEmbed);
		if (candidates.length === 0) {
			this.close();
			return;
		}

		this.activeMatch = match;
		this.items = candidates;
		this.selectedIndex = Math.min(this.selectedIndex, candidates.length - 1);
		this.renderPopup(inputBox, match.isEmbed);
	}

	private findTriggerMatch(text: string, caret: number): TriggerMatch | null {
		const before = text.slice(0, caret);
		const regexMatch = before.match(/(!?)\[\[([^\[\]\n|]*)$/);
		if (!regexMatch || regexMatch.index === undefined) {
			return null;
		}

		const isEmbed = regexMatch[1] === "!";
		const query = regexMatch[2] ?? "";
		const start = regexMatch.index;
		const after = text.slice(caret);
		const closingLen = after.startsWith("]]") ? 2 : 0;

		return {
			isEmbed,
			start,
			end: caret + closingLen,
			query,
		};
	}

	private searchFiles(query: string, isEmbed: boolean): TFile[] {
		const pool = isEmbed
			? this.app.vault
					.getFiles()
					.filter(
						(f) =>
							f.extension === "md" ||
							IMAGE_EXTENSIONS.has(f.extension.toLowerCase())
					)
			: this.app.vault.getMarkdownFiles();

		const trimmed = query.trim();
		if (!trimmed) {
			return [...pool]
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, 15);
		}

		const fuzzy = prepareFuzzySearch(trimmed);
		const scored: Array<{ file: TFile; score: number }> = [];

		for (const file of pool) {
			const nameRes = fuzzy(file.basename);
			const pathRes = fuzzy(file.path);
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
		return scored.slice(0, 15).map((entry) => entry.file);
	}

	private renderPopup(inputBox: HTMLElement, isEmbed: boolean): void {
		if (!this.popupEl) {
			this.popupEl = document.body.createDiv({ cls: "mm-link-suggester" });
			// Prevent mouse interaction from blurring #input-box
			this.popupEl.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
			});
			this.listEl = this.popupEl.createDiv({ cls: "mm-link-suggester-list" });
			const footer = this.popupEl.createDiv({ cls: "mm-link-suggester-footer" });
			footer.setText(
				isEmbed
					? "↑↓ 选择附件/笔记  ·  Enter 插入嵌入  ·  Esc 关闭"
					: "↑↓ 选择笔记  ·  Enter 插入双链  ·  Esc 关闭"
			);
		}

		if (!this.listEl) return;
		this.listEl.empty();

		this.items.forEach((file, index) => {
			const row = this.listEl!.createDiv({
				cls: `mm-link-suggester-item${index === this.selectedIndex ? " is-selected" : ""}`,
			});
			const titleEl = row.createDiv({ cls: "mm-link-suggester-title" });
			titleEl.setText(file.extension === "md" ? file.basename : file.name);

			const folderPath = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
			if (folderPath) {
				const pathEl = row.createDiv({ cls: "mm-link-suggester-path" });
				pathEl.setText(folderPath);
			}

			row.addEventListener("mouseenter", () => {
				this.selectedIndex = index;
				this.renderSelection();
			});
			row.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.commitSelection(file);
			});
		});

		this.positionPopup(inputBox);
	}

	private renderSelection(): void {
		if (!this.listEl) return;
		const rows = Array.from(this.listEl.children) as HTMLElement[];
		rows.forEach((row, idx) => {
			row.toggleClass("is-selected", idx === this.selectedIndex);
			if (idx === this.selectedIndex) {
				row.scrollIntoView({ block: "nearest" });
			}
		});
	}

	private positionPopup(inputBox: HTMLElement): void {
		if (!this.popupEl) return;
		const rect = inputBox.getBoundingClientRect();
		const popupWidth = 320;
		const estimatedHeight = Math.min(340, this.items.length * 46 + 40);

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

	private commitSelection(file: TFile): void {
		const inputBox = this.activeInput;
		const match = this.activeMatch;
		if (!inputBox || !inputBox.isConnected || !match) {
			this.close();
			return;
		}

		const sourcePath = this.host.getSourcePath();
		let linkText: string;
		if (match.isEmbed) {
			linkText =
				file.extension === "md"
					? `![[${file.basename}]]`
					: `![[${file.name}]]`;
		} else {
			linkText = this.app.fileManager.generateMarkdownLink(file, sourcePath);
			// Ensure standard wikilink format if user has markdown links disabled/enabled
			if (!linkText.startsWith("[[")) {
				linkText = `[[${file.basename}]]`;
			}
		}

		const fullText = inputBox.textContent ?? "";
		const nextText =
			fullText.slice(0, match.start) + linkText + fullText.slice(match.end);
		const nextCaret = match.start + linkText.length;

		inputBox.textContent = nextText;
		inputBox.focus();
		this.host.setSelectionOffsets(inputBox, nextCaret, nextCaret);
		this.close();
	}
}
