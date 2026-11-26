import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NodeNoteSession,
	type NodeNoteAdapter,
	type NoteNodeSnapshot,
	type NotePanelMode,
} from "./NodeNoteSession";

function createNoteHarness(initialNodes: NoteNodeSnapshot[]) {
	const nodes = new Map<string, NoteNodeSnapshot>(
		initialNodes.map((n) => [n.id, { ...n }])
	);
	let selectedId: string | null = initialNodes[0]?.id ?? null;
	let editorValue = "";
	let editorFocused = false;
	let panelVisible = false;
	let hoverNodeId: string | null = null;
	const events: string[] = [];

	const adapter: NodeNoteAdapter = {
		getNode: (id) => {
			const n = nodes.get(id);
			return n ? { ...n } : null;
		},
		getSelectedNodeId: () => selectedId,
		getFallbackRootNodeId: () => initialNodes[0]?.id ?? null,
		selectNode: (id) => {
			selectedId = id;
			events.push(`select:${id}`);
		},
		writeNodeNote: (id, normalized) => {
			const n = nodes.get(id);
			if (n) n.note = normalized;
			events.push(`write:${id}:${normalized}`);
		},
		showPanel: (node, mode, focusEditor) => {
			panelVisible = true;
			editorFocused = focusEditor;
			events.push(`showPanel:${node.id}:${mode}`);
		},
		hidePanel: (restoreFocus) => {
			panelVisible = false;
			editorFocused = false;
			events.push(`hidePanel:${restoreFocus}`);
		},
		updatePanelHeader: (node) => {
			events.push(`header:${node.id}:${node.topic}`);
		},
		applyPanelMode: (mode: NotePanelMode, previewMarkdown: string) => {
			events.push(`mode:${mode}:${previewMarkdown}`);
		},
		setEditorValue: (val) => {
			editorValue = val;
		},
		getEditorValue: () => editorValue,
		isEditorFocused: () => editorFocused,
		focusEditor: () => {
			editorFocused = true;
		},
		updateClearButton: (hasContent) => {
			events.push(`clearBtn:${hasContent}`);
		},
		onPanelStateChanged: (isOpen) => {
			events.push(`state:${isOpen}`);
		},
		showHoverPreview: (node) => {
			hoverNodeId = node.id;
			events.push(`hoverShow:${node.id}:${node.note}`);
		},
		hideHoverPreview: () => {
			hoverNodeId = null;
			events.push("hoverHide");
		},
		scheduleTimer: (fn, delayMs) => setTimeout(fn, delayMs),
		cancelTimer: (handle) => clearTimeout(handle),
	};

	const session = new NodeNoteSession(adapter, {
		saveDebounceMs: 250,
		hoverShowDelayMs: 180,
		hoverHideDelayMs: 160,
	});

	return {
		session,
		nodes,
		events,
		typeNote: (text: string) => {
			editorValue = text;
			session.onEditorInput(text);
		},
		setEditorFocused: (focused: boolean) => {
			editorFocused = focused;
		},
		getEditorValue: () => editorValue,
		isPanelVisible: () => panelVisible,
		getHoverNodeId: () => hoverNodeId,
	};
}

describe("NodeNoteSession", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("debounces saves, deduplicates identical values, and flushes the previous Node before switching", () => {
		const h = createNoteHarness([
			{ id: "n1", topic: "Branch A", note: "Initial A" },
			{ id: "n2", topic: "Branch B", note: "Initial B" },
		]);

		h.session.openForNode("n1", "edit");
		expect(h.session.isOpen()).toBe(true);
		expect(h.getEditorValue()).toBe("Initial A");

		// Typing schedules debounced save; switching Nodes before 250ms flushes n1 immediately
		h.typeNote("Updated A draft");
		expect(h.events.filter((e) => e.startsWith("write:"))).toHaveLength(0);

		h.session.onCanvasSelectionChanged("n2");
		expect(h.nodes.get("n1")?.note).toBe("Updated A draft");
		expect(h.session.getActiveNodeId()).toBe("n2");
		expect(h.getEditorValue()).toBe("Initial B");

		// Debounced save on n2 fires after 250ms and deduplicates repeated flush
		h.typeNote("  Updated B  \n\n");
		vi.advanceTimersByTime(250);
		expect(h.nodes.get("n2")?.note).toBe("  Updated B  ");
		const writesAfterDebounce = h.events.filter((e) =>
			e.startsWith("write:")
		).length;
		h.session.flushPendingSave();
		expect(h.events.filter((e) => e.startsWith("write:")).length).toBe(
			writesAfterDebounce
		);

		// Clearing note writes empty string immediately
		h.session.clearActiveNote();
		expect(h.nodes.get("n2")?.note).toBe("");
		expect(h.getEditorValue()).toBe("");
	});

	it("reconciles external refreshes without overwriting live focused typing and closes if Node was deleted", () => {
		const h = createNoteHarness([{ id: "n1", topic: "Topic", note: "Old" }]);

		h.session.openForNode("n1", "edit");
		h.setEditorFocused(true);
		h.typeNote("Typing locally");

		// External update while editor is focused preserves local buffer and updates header
		h.nodes.set("n1", { id: "n1", topic: "Renamed Topic", note: "From Source" });
		h.session.onExternalRefresh();
		expect(h.getEditorValue()).toBe("Typing locally");
		expect(h.events).toContain("header:n1:Renamed Topic");

		// When unfocused, external refresh updates the editor buffer
		h.setEditorFocused(false);
		h.session.onExternalRefresh();
		expect(h.getEditorValue()).toBe("From Source");

		// If the Node is removed in Source Mode, panel closes cleanly
		h.nodes.delete("n1");
		h.session.onExternalRefresh();
		expect(h.session.isOpen()).toBe(false);
		expect(h.isPanelVisible()).toBe(false);
	});

	it("arbitrates hover preview delays, stays open while pointer enters preview, and suppresses same-Node hover", () => {
		const h = createNoteHarness([
			{ id: "n1", topic: "A", note: "Note A" },
			{ id: "n2", topic: "B", note: "Note B" },
		]);

		// Hover badge -> shows after 180ms
		h.session.onBadgeMouseEnter("n1");
		vi.advanceTimersByTime(179);
		expect(h.getHoverNodeId()).toBeNull();
		vi.advanceTimersByTime(1);
		expect(h.getHoverNodeId()).toBe("n1");

		// Moving from badge into preview cancels hide timer
		h.session.onBadgeMouseLeave();
		vi.advanceTimersByTime(80);
		h.session.onPreviewMouseEnter();
		vi.advanceTimersByTime(200);
		expect(h.getHoverNodeId()).toBe("n1");

		// Clicking edit in preview opens panel and hides preview
		h.session.openHoveredForEdit();
		expect(h.getHoverNodeId()).toBeNull();
		expect(h.session.isOpen()).toBe(true);
		expect(h.session.getActiveNodeId()).toBe("n1");

		// Hovering badge of already-open Node n1 is suppressed, while n2 still previews
		h.session.onBadgeMouseEnter("n1");
		vi.advanceTimersByTime(250);
		expect(h.getHoverNodeId()).toBeNull();

		h.session.onBadgeMouseEnter("n2");
		vi.advanceTimersByTime(180);
		expect(h.getHoverNodeId()).toBe("n2");

		// Leaving preview hides after 160ms
		h.session.onPreviewMouseLeave();
		vi.advanceTimersByTime(160);
		expect(h.getHoverNodeId()).toBeNull();
	});
});
