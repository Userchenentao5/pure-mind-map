import { describe, expect, it } from "vitest";
import {
	NodeInlineEditorSession,
	decideTextBlurAction,
	decideUrlBarBlurAction,
	insertImageEmbedIntoText,
	isImageExtension,
	resolveRichShortcutMark,
	type LinkCandidate,
	type LinkPopupViewModel,
	type NodeInlineEditorAdapter,
	type SelectionRange,
	type VaultFileMeta,
} from "./NodeInlineEditorSession";

interface FakeNode {
	id: string;
	topic: string;
}

const SAMPLE_FILES: VaultFileMeta[] = [
	{
		path: "notes/Alpha.md",
		basename: "Alpha",
		name: "Alpha.md",
		extension: "md",
		folderPath: "notes/",
		mtime: 100,
	},
	{
		path: "notes/Beta.md",
		basename: "Beta",
		name: "Beta.md",
		extension: "md",
		folderPath: "notes/",
		mtime: 300,
	},
	{
		path: "notes/Gamma.md",
		basename: "Gamma",
		name: "Gamma.md",
		extension: "md",
		folderPath: "notes/",
		mtime: 200,
	},
	{
		path: "assets/diagram.png",
		basename: "diagram",
		name: "diagram.png",
		extension: "png",
		folderPath: "assets/",
		mtime: 400,
	},
	{
		path: "archive/spec.pdf",
		basename: "spec",
		name: "spec.pdf",
		extension: "pdf",
		folderPath: "archive/",
		mtime: 500,
	},
];

function createEditorHarness(opts?: {
	files?: VaultFileMeta[];
	initialText?: string;
	initialSelection?: SelectionRange;
	connected?: boolean;
	selectedNode?: FakeNode | null;
}) {
	const files = opts?.files ?? SAMPLE_FILES;
	let connected = opts?.connected ?? true;
	let text = opts?.initialText ?? "";
	let selection: SelectionRange = opts?.initialSelection ?? {
		start: text.length,
		end: text.length,
	};
	let selectedNode: FakeNode | null =
		opts?.selectedNode !== undefined
			? opts.selectedNode
			: { id: "N1", topic: "Root" };

	let vaultScanCount = 0;
	let renderCount = 0;
	let blurCount = 0;
	let lastPopup: LinkPopupViewModel<VaultFileMeta> | null = null;
	const events: string[] = [];

	const adapter: NodeInlineEditorAdapter<VaultFileMeta, FakeNode> = {
		listVaultCandidates: (): LinkCandidate<VaultFileMeta>[] => {
			vaultScanCount++;
			return files.map((file) => ({ ...file, file }));
		},
		createFuzzyScorer: (query) => {
			const needle = query.toLowerCase();
			return (haystack) => {
				const idx = haystack.toLowerCase().indexOf(needle);
				return idx === -1 ? null : { score: 100 - idx - haystack.length * 0.01 };
			};
		},
		generateMarkdownLink: (file) => `[[${file.basename}]]`,
		getFileMeta: (file) => ({
			name: file.name,
			basename: file.basename,
			extension: file.extension,
		}),
		readInputBox: () => ({
			connected,
			text,
			selection: { ...selection },
		}),
		writeInputBox: (nextText, nextSelection, keepEditing) => {
			text = nextText;
			selection = { ...nextSelection };
			events.push(
				`write:${nextText}:${nextSelection.start}-${nextSelection.end}:keep=${keepEditing}`
			);
			if (!keepEditing) {
				blurCount++;
			}
		},
		blurInputBox: () => {
			blurCount++;
			events.push("blur");
		},
		renderSuggester: (state) => {
			renderCount++;
			lastPopup = {
				...state,
				candidates: [...state.candidates],
			};
		},
		getSelectedNode: () =>
			selectedNode
				? { node: selectedNode, topic: selectedNode.topic }
				: null,
		reshapeNodeTopic: async (node, topic) => {
			node.topic = topic;
			events.push(`reshape:${node.id}:${topic}`);
		},
		reopenNodeEditor: async (node, nextText, nextSelection) => {
			connected = true;
			text = nextText;
			selection = { ...nextSelection };
			events.push(
				`reopen:${node.id}:${nextText}:${nextSelection.start}-${nextSelection.end}`
			);
		},
	};

	const session = new NodeInlineEditorSession(adapter);

	return {
		session,
		events,
		getState: () => ({
			text,
			selection,
			connected,
			selectedNode,
			lastPopup,
			vaultScanCount,
			renderCount,
			blurCount,
		}),
		setInput: (nextText: string, caret = nextText.length) => {
			text = nextText;
			selection = { start: caret, end: caret };
		},
		setConnected: (value: boolean) => {
			connected = value;
		},
		setSelectedNode: (node: FakeNode | null) => {
			selectedNode = node;
		},
	};
}

describe("NodeInlineEditorSession", () => {
	it("recognizes supported image extensions case-insensitively", () => {
		expect(isImageExtension("png")).toBe(true);
		expect(isImageExtension("WEBP")).toBe(true);
		expect(isImageExtension("svg")).toBe(true);
		expect(isImageExtension("md")).toBe(false);
		expect(isImageExtension("pdf")).toBe(false);
	});

	it("caches vault candidates per Link Suggestion session and deduplicates redundant refreshes", () => {
		const harness = createEditorHarness({ initialText: "See [[" });

		// Simulate input + keyup firing back-to-back for the same text/caret
		harness.session.refreshSuggester();
		harness.session.refreshSuggester();

		expect(harness.getState().vaultScanCount).toBe(1);
		expect(harness.getState().renderCount).toBe(1);
		expect(harness.getState().lastPopup?.candidates.map((c) => c.basename)).toEqual([
			"Beta",
			"Gamma",
			"Alpha",
		]);

		// Further typing inside the same [[ session reuses the cached vault snapshot
		harness.setInput("See [[al");
		harness.session.refreshSuggester();
		expect(harness.getState().vaultScanCount).toBe(1);
		expect(harness.getState().lastPopup?.candidates.map((c) => c.basename)).toEqual([
			"Alpha",
		]);

		// Closing and opening a new trigger scans fresh
		harness.session.closeSuggester();
		harness.setInput("![[");
		harness.session.refreshSuggester();
		expect(harness.getState().vaultScanCount).toBe(2);
		expect(harness.getState().lastPopup?.candidates.map((c) => c.name)).toEqual([
			"diagram.png",
			"Beta.md",
			"Gamma.md",
			"Alpha.md",
		]);
	});

	it("resets selectedIndex to 0 when the Link Suggestion query changes", () => {
		const harness = createEditorHarness({ initialText: "[[" });
		harness.session.refreshSuggester();

		// Move selection down to index 2 ("Alpha")
		expect(harness.session.handleSuggesterKeyDown({ key: "ArrowDown" })).toBe("handled");
		expect(harness.session.handleSuggesterKeyDown({ key: "ArrowDown" })).toBe("handled");
		expect(harness.getState().lastPopup?.selectedIndex).toBe(2);

		// Typing a new query resets selection to the top-ranked result (0)
		harness.setInput("[[a");
		harness.session.refreshSuggester();
		expect(harness.getState().lastPopup?.selectedIndex).toBe(0);
	});

	it("navigates with keyboard, ignores IME composing Enter, and commits canonical wikilinks/embeds", () => {
		const harness = createEditorHarness({ initialText: "Ref [[be]] end" });
		harness.setInput("Ref [[be]] end", 8); // caret between "be" and "]]"
		harness.session.refreshSuggester();

		// IME composition Enter must be ignored so Chinese/Japanese input can finish
		expect(
			harness.session.handleSuggesterKeyDown({ key: "Enter", isComposing: true })
		).toBe("ignored");
		expect(harness.session.isSuggesterOpen()).toBe(true);

		// Regular Enter replaces trigger + auto-closed "]]" and places caret after link
		expect(harness.session.handleSuggesterKeyDown({ key: "Enter" })).toBe("handled");
		expect(harness.getState().text).toBe("Ref [[Beta]] end");
		expect(harness.getState().selection).toEqual({ start: 12, end: 12 });
		expect(harness.session.isSuggesterOpen()).toBe(false);

		// Embed trigger inserts ![[file.png]]
		harness.setInput("Pic ![[diag");
		harness.session.refreshSuggester();
		expect(harness.session.handleSuggesterKeyDown({ key: "Tab" })).toBe("handled");
		expect(harness.getState().text).toBe("Pic ![[diagram.png]]");
	});

	it("applies inline formatting when connected and recovers cleanly when #input-box is detached", async () => {
		const node: FakeNode = { id: "N1", topic: "hello world" };
		const harness = createEditorHarness({
			initialText: "hello world",
			connected: true,
			selectedNode: node,
		});

		// 1. Connected inline bold wrap selects wrapped inner text
		await harness.session.applyInlineFormat(
			node,
			"hello world",
			{ start: 6, end: 11 },
			"bold"
		);
		expect(harness.getState().text).toBe("hello **world**");
		expect(harness.getState().selection).toEqual({ start: 8, end: 13 });

		// 2. Detached editor recovery (context menu blurred and detached #input-box)
		harness.setConnected(false);
		await harness.session.applyInlineFormat(
			node,
			"hello world",
			{ start: 6, end: 11 },
			"external-link"
		);
		expect(node.topic).toBe("hello [world](https://)");
		expect(harness.getState().connected).toBe(true);
		expect(harness.getState().selection).toEqual({ start: 14, end: 22 });

		// 3. Detached modal link insertion commits without reopening editor
		harness.setConnected(false);
		await harness.session.insertFileIntoSelection(
			node,
			"See here",
			{ start: 4, end: 8 },
			SAMPLE_FILES[0],
			false
		);
		expect(node.topic).toBe("See [[Alpha]]");
		expect(harness.getState().connected).toBe(false);
	});

	it("appends wikilinks and image embeds directly to the selected Node", async () => {
		const node: FakeNode = { id: "N1", topic: "Summary" };
		const harness = createEditorHarness({ selectedNode: node });

		expect(
			await harness.session.appendFileToSelectedNode(SAMPLE_FILES[0], false)
		).toBe(true);
		expect(node.topic).toBe("Summary [[Alpha]]");

		expect(
			await harness.session.appendFileToSelectedNode(SAMPLE_FILES[3], true)
		).toBe(true);
		expect(node.topic).toBe("Summary [[Alpha]]\n![[diagram.png]]");

		harness.setSelectedNode(null);
		expect(
			await harness.session.appendFileToSelectedNode(SAMPLE_FILES[0], false)
		).toBe(false);
	});

	it("arbitrates floating toolbar visibility, inline external-link flow, shortcuts, and blur transitions", () => {
		const h = createEditorHarness({
			initialText: "Visit docs now",
			initialSelection: { start: 6, end: 10 },
		});

		expect(
			h.session.resolveFormatToolbarVisibility({
				isRichEditing: true,
				isPointerSelecting: true,
				hasNonEmptySelection: true,
			})
		).toBe("hidden");
		expect(
			h.session.resolveFormatToolbarVisibility({
				isRichEditing: true,
				isPointerSelecting: false,
				hasNonEmptySelection: true,
			})
		).toBe("format-bar");

		const pending = h.session.beginExternalLink("Visit docs now", {
			start: 6,
			end: 10,
		});
		expect(pending.label).toBe("docs");
		expect(
			h.session.resolveFormatToolbarVisibility({
				isRichEditing: true,
				isPointerSelecting: false,
				hasNonEmptySelection: false,
			})
		).toBe("url-bar");

		expect(h.session.confirmExternalLink("javascript:alert(1)")).toEqual({
			ok: false,
		});
		expect(h.session.hasPendingExternalLink()).toBe(true);

		expect(h.session.confirmExternalLink("obsidian.md")).toEqual({
			ok: true,
			text: "Visit [docs](https://obsidian.md) now",
			selection: { start: 33, end: 33 },
		});
		expect(h.session.hasPendingExternalLink()).toBe(false);

		expect(
			decideTextBlurAction({
				relatedInsideCard: false,
				relatedInsidePopup: false,
				relatedInsideToolbar: true,
				hasPendingExternalLink: false,
			})
		).toBe("keep-editing");
		expect(
			decideTextBlurAction({
				relatedInsideCard: false,
				relatedInsidePopup: false,
				relatedInsideToolbar: false,
				hasPendingExternalLink: false,
			})
		).toBe("commit");

		expect(
			decideUrlBarBlurAction({
				relatedInsideToolbar: true,
				relatedInsideCard: false,
			})
		).toBe("keep-url-bar");
		expect(
			decideUrlBarBlurAction({
				relatedInsideToolbar: false,
				relatedInsideCard: true,
			})
		).toBe("cancel-to-editor");
		expect(
			decideUrlBarBlurAction({
				relatedInsideToolbar: false,
				relatedInsideCard: false,
			})
		).toBe("cancel-and-commit");

		expect(
			insertImageEmbedIntoText("Hello", { start: 5, end: 5 }, "shot.png")
		).toEqual({
			text: "Hello\n![[shot.png]]",
			caretStart: 19,
			caretEnd: 19,
		});
		expect(
			resolveRichShortcutMark({
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				key: "b",
			})
		).toBe("bold");
		expect(
			resolveRichShortcutMark({
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: true,
				key: "H",
			})
		).toBe("highlight");
	});
});
