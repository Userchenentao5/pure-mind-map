import type { App, Editor } from "obsidian";

export interface NoteMarkdownEditorOptions {
	app: App;
	containerEl: HTMLElement;
	placeholder: string;
	onChange: (value: string) => void;
	onBlur: () => void;
	onEscape: () => void;
}

interface InternalEditorInstance {
	get?: () => string;
	set?: (value: string, clear?: boolean) => void;
	destroy?: () => void;
	onUpdate?: (update: unknown, changed: boolean) => void;
	editor?: Editor;
	cm?: {
		state?: { doc?: { toString: () => string; length: number } };
		focus?: () => void;
		dispatch?: (spec: { selection: { anchor: number } }) => void;
		contentDOM?: HTMLElement;
	};
}

type ScrollableEditorCtor = new (
	app: App,
	containerEl: HTMLElement,
	owner: Record<string, unknown>
) => InternalEditorInstance;

interface DummyMarkdownEmbed {
	load?: () => void;
	unload?: () => void;
	editable?: boolean;
	showEditor?: () => void;
	editMode?: unknown;
}

interface InternalAppShape {
	embedRegistry?: {
		embedByExtension?: {
			md?: (
				ctx: { app: App; containerEl: HTMLElement },
				file: null,
				subpath: string
			) => DummyMarkdownEmbed;
		};
	};
	workspace?: {
		activeEditor?: unknown;
	};
}

let cachedScrollableEditorCtor: ScrollableEditorCtor | null | undefined;

function resolveScrollableMarkdownEditorCtor(
	app: App
): ScrollableEditorCtor | null {
	if (cachedScrollableEditorCtor !== undefined) {
		return cachedScrollableEditorCtor;
	}

	try {
		const internalApp = app as unknown as InternalAppShape;
		const mdCreator = internalApp.embedRegistry?.embedByExtension?.md;
		if (typeof mdCreator !== "function") {
			cachedScrollableEditorCtor = null;
			return null;
		}

		const dummyEl = createDiv();
		const dummyEmbed = mdCreator({ app, containerEl: dummyEl }, null, "");
		try {
			dummyEmbed.load?.();
			dummyEmbed.editable = true;
			dummyEmbed.showEditor?.();
			const editMode = dummyEmbed.editMode;
			if (!editMode || typeof editMode !== "object") {
				cachedScrollableEditorCtor = null;
				return null;
			}
			const embedProto = Object.getPrototypeOf(editMode) as object | null;
			const scrollableProto = embedProto
				? (Object.getPrototypeOf(embedProto) as { constructor?: unknown } | null)
				: null;
			const ctor = scrollableProto?.constructor;
			if (typeof ctor === "function") {
				cachedScrollableEditorCtor = ctor as ScrollableEditorCtor;
				return cachedScrollableEditorCtor;
			}
		} finally {
			dummyEmbed.unload?.();
		}
	} catch {
		// Fall back gracefully to standard textarea editor
	}

	cachedScrollableEditorCtor = null;
	return null;
}

/**
 * Wraps Obsidian's native Live Preview Markdown editor (CodeMirror 6) when available,
 * and falls back seamlessly to an enhanced Markdown textarea if Obsidian's internal
 * embed constructor is unavailable.
 */
export class NoteMarkdownEditor {
	private options: NoteMarkdownEditorOptions;
	private hostEl: HTMLElement;
	private nativeEditor: InternalEditorInstance | null = null;
	private nativeOwner: Record<string, unknown> | null = null;
	private previousActiveEditor: unknown = undefined;
	private fallbackTextarea: HTMLTextAreaElement | null = null;
	private isProgrammaticUpdate = false;
	private nativeMode = false;

	constructor(options: NoteMarkdownEditorOptions) {
		this.options = options;
		this.hostEl = options.containerEl.createDiv({
			cls: "mm-note-editor-host",
		});
		this.mount();
	}

	public isNativeLivePreview(): boolean {
		return this.nativeMode;
	}

	public getValue(): string {
		if (this.nativeEditor) {
			if (typeof this.nativeEditor.get === "function") {
				return this.nativeEditor.get();
			}
			if (this.nativeEditor.editor) {
				return this.nativeEditor.editor.getValue();
			}
			const cmDoc = this.nativeEditor.cm?.state?.doc;
			if (cmDoc) {
				return cmDoc.toString();
			}
		}
		return this.fallbackTextarea?.value ?? "";
	}

	public setValue(value: string, clearHistory = true): void {
		this.isProgrammaticUpdate = true;
		try {
			if (this.nativeEditor) {
				if (typeof this.nativeEditor.set === "function") {
					this.nativeEditor.set(value, clearHistory);
				} else if (this.nativeEditor.editor) {
					this.nativeEditor.editor.setValue(value);
				}
				return;
			}
			if (this.fallbackTextarea) {
				this.fallbackTextarea.value = value;
			}
		} finally {
			this.isProgrammaticUpdate = false;
		}
	}

	public focusEnd(): void {
		if (this.nativeEditor) {
			const cm = this.nativeEditor.cm;
			if (cm?.focus) {
				cm.focus();
				const len = cm.state?.doc?.length ?? 0;
				cm.dispatch?.({ selection: { anchor: len } });
				return;
			}
			if (this.nativeEditor.editor) {
				this.nativeEditor.editor.focus();
				const lastLine = this.nativeEditor.editor.lastLine();
				const lastCh = this.nativeEditor.editor.getLine(lastLine)?.length ?? 0;
				this.nativeEditor.editor.setCursor({ line: lastLine, ch: lastCh });
				return;
			}
		}
		if (this.fallbackTextarea) {
			this.fallbackTextarea.focus();
			const end = this.fallbackTextarea.value.length;
			this.fallbackTextarea.setSelectionRange(end, end);
		}
	}

	public isFocused(): boolean {
		const active = activeDocument.activeElement;
		return Boolean(active && this.hostEl.contains(active));
	}

	public setVisible(visible: boolean): void {
		this.hostEl.toggleClass("mm-is-hidden", !visible);
	}

	public destroy(): void {
		this.restoreWorkspaceActiveEditor();
		if (this.nativeEditor) {
			try {
				this.nativeEditor.destroy?.();
			} catch {
				// Ignore cleanup errors on detached editor
			}
			this.nativeEditor = null;
			this.nativeOwner = null;
		}
		this.fallbackTextarea = null;
		this.hostEl.remove();
	}

	private mount(): void {
		if (this.tryMountNativeEditor()) {
			return;
		}
		this.mountFallbackTextarea();
	}

	private tryMountNativeEditor(): boolean {
		const EditorCtor = resolveScrollableMarkdownEditorCtor(this.options.app);
		if (!EditorCtor) return false;

		const editorWrap = this.hostEl.createDiv({
			cls: "mm-note-native-editor markdown-source-view mod-cm6 is-live-preview",
		});

		try {
			// Intentionally keep `file: null` on the synthetic editor owner so neither
			// Obsidian core nor third-party `editor-change` listeners ever mistake this
			// node-note buffer for the backing Mind Map Markdown file.
			const owner: Record<string, unknown> = {
				app: this.options.app,
				file: null,
				containerEl: editorWrap,
				editorEl: editorWrap,
				hoverPopover: null,
				getViewType: () => "pure-mind-map-note",
				getDisplayText: () => "",
				getMode: () => "source",
				getViewData: () => this.getValue(),
				setViewData: () => {},
				clear: () => {},
				requestSave: () => {
					if (!this.isProgrammaticUpdate) {
						this.options.onChange(this.getValue());
					}
				},
				save: () => {
					if (!this.isProgrammaticUpdate) {
						this.options.onChange(this.getValue());
					}
					return Promise.resolve();
				},
				editMode: null,
				editor: null,
			};

			const instance = new EditorCtor(this.options.app, editorWrap, owner);
			if (
				typeof instance.get !== "function" &&
				!instance.editor &&
				!instance.cm
			) {
				instance.destroy?.();
				editorWrap.remove();
				return false;
			}

			owner.editMode = instance;
			owner.editor = instance.editor ?? null;

			const origOnUpdate = instance.onUpdate;
			instance.onUpdate = (update: unknown, changed: boolean) => {
				if (typeof origOnUpdate === "function") {
					origOnUpdate.call(instance, update, changed);
				}
				if (changed && !this.isProgrammaticUpdate) {
					this.options.onChange(this.getValue());
				}
			};

			if (instance.cm?.contentDOM) {
				instance.cm.contentDOM.setAttribute(
					"data-placeholder",
					this.options.placeholder
				);
			}

			editorWrap.addEventListener("focusin", () => {
				this.claimWorkspaceActiveEditor(owner);
			});
			editorWrap.addEventListener("focusout", (evt) => {
				const related = evt.relatedTarget as Node | null;
				if (related && editorWrap.contains(related)) {
					return;
				}
				this.restoreWorkspaceActiveEditor();
				this.options.onBlur();
			});
			editorWrap.addEventListener("keydown", (evt) => {
				if (evt.isComposing || evt.key === "Process") return;
				if (evt.key === "Escape") {
					// Let Obsidian's [[ link suggester close first if it is currently open
					if (activeDocument.querySelector(".suggestion-container")) {
						return;
					}
					evt.preventDefault();
					evt.stopPropagation();
					this.options.onEscape();
				}
			});

			this.nativeEditor = instance;
			this.nativeOwner = owner;
			this.nativeMode = true;
			return true;
		} catch {
			editorWrap.remove();
			this.nativeEditor = null;
			this.nativeOwner = null;
			this.nativeMode = false;
			return false;
		}
	}

	private mountFallbackTextarea(): void {
		const textarea = this.hostEl.createEl("textarea", {
			cls: "mm-note-textarea",
			attr: {
				placeholder: this.options.placeholder,
			},
		});

		textarea.addEventListener("input", () => {
			if (!this.isProgrammaticUpdate) {
				this.options.onChange(textarea.value);
			}
		});
		textarea.addEventListener("blur", () => {
			this.options.onBlur();
		});
		textarea.addEventListener("keydown", (evt) => {
			if (evt.isComposing || evt.key === "Process") return;
			if (evt.key === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				this.options.onEscape();
				return;
			}
			if (evt.key === "Tab") {
				evt.preventDefault();
				const start = textarea.selectionStart;
				const end = textarea.selectionEnd;
				const value = textarea.value;
				textarea.value = `${value.slice(0, start)}  ${value.slice(end)}`;
				textarea.selectionStart = textarea.selectionEnd = start + 2;
				this.options.onChange(textarea.value);
				return;
			}
			if ((evt.ctrlKey || evt.metaKey) && !evt.altKey && !evt.shiftKey) {
				const lower = evt.key.toLowerCase();
				if (lower === "b" || lower === "i") {
					evt.preventDefault();
					const marker = lower === "b" ? "**" : "*";
					const start = textarea.selectionStart;
					const end = textarea.selectionEnd;
					const selected = textarea.value.slice(start, end);
					textarea.value = `${textarea.value.slice(0, start)}${marker}${selected}${marker}${textarea.value.slice(end)}`;
					textarea.selectionStart = start + marker.length;
					textarea.selectionEnd = end + marker.length;
					this.options.onChange(textarea.value);
				}
			}
		});

		this.fallbackTextarea = textarea;
		this.nativeMode = false;
	}

	private claimWorkspaceActiveEditor(owner: Record<string, unknown>): void {
		const ws = (this.options.app as unknown as InternalAppShape).workspace;
		if (!ws) return;
		if (ws.activeEditor !== owner) {
			this.previousActiveEditor = ws.activeEditor;
			ws.activeEditor = owner;
		}
	}

	private restoreWorkspaceActiveEditor(): void {
		const ws = (this.options.app as unknown as InternalAppShape).workspace;
		if (!ws || !this.nativeOwner) return;
		if (ws.activeEditor === this.nativeOwner) {
			ws.activeEditor =
				this.previousActiveEditor !== undefined
					? this.previousActiveEditor
					: null;
		}
		this.previousActiveEditor = undefined;
	}
}
