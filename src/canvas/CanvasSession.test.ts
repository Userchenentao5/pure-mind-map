import { describe, expect, it } from "vitest";
import type { NodeObj } from "mind-elixir";
import {
	CanvasSession,
	type CanvasSessionAdapter,
	type SearchCounterState,
} from "./CanvasSession";

function createCanvasHarness(root: NodeObj) {
	const events: string[] = [];
	let lastCounter: SearchCounterState | null = null;

	const adapter: CanvasSessionAdapter = {
		getRootNodeData: () => root,
		applyRootCollapsedDom: (collapsed) => {
			events.push(`rootCollapsed:${collapsed}`);
		},
		expandAncestorSilently: (id) => {
			events.push(`expand:${id}`);
		},
		selectAndScrollToNode: (id) => {
			events.push(`reveal:${id}`);
		},
		applySearchHighlights: (ids, activeId) => {
			events.push(`highlight:${ids.join(",")}|active:${activeId}`);
		},
		clearSearchHighlights: () => {
			events.push("clearHighlights");
		},
		updateSearchCounter: (state) => {
			lastCounter = state;
		},
		syncCollapseBadges: () => {
			events.push("syncCollapseBadges");
		},
		syncNoteBadges: () => {
			events.push("syncNoteBadges");
		},
		notifyExternalNoteRefresh: () => {
			events.push("noteExternalRefresh");
		},
		notifyNoteSelectionChanged: () => {
			events.push("noteSelection");
		},
		updateQuickAddAndRootHandles: () => {
			events.push("quickAdd");
		},
		updateNoteToolbarButton: () => {
			events.push("noteToolbar");
		},
		scheduleMinimapRender: () => {
			events.push("minimap");
		},
		notifySelectionForSplitSync: () => {
			events.push("splitNotify");
		},
	};

	const session = new CanvasSession(adapter);
	return {
		session,
		events,
		getLastCounter: () => lastCounter,
	};
}

const TREE: NodeObj = {
	id: "root",
	topic: "Project",
	children: [
		{
			id: "b1",
			topic: "Design",
			expanded: false,
			children: [{ id: "c1", topic: "API Spec", children: [] }],
		},
		{
			id: "b2",
			topic: "Build",
			note: "Contains API checklist",
			children: [],
		},
	],
};

describe("CanvasSession", () => {
	it("expands collapsed root and ancestors silently during Split View reveal without emitting selection echoes", () => {
		const h = createCanvasHarness(TREE);
		h.session.setRootCollapsed(true);
		h.events.length = 0;

		expect(h.session.revealNodeByPathKey("0.0.0")).toBe(true);
		expect(h.session.isRootCollapsed()).toBe(false);
		expect(h.events).toContain("rootCollapsed:false");
		expect(h.events).toContain("expand:root");
		expect(h.events).toContain("expand:b1");
		expect(h.events).toContain("reveal:c1");
		// Echo guard suppresses Split View bounce-back
		expect(h.events).not.toContain("splitNotify");
	});

	it("runs and steps Node search across topics and notes using the same reveal path", () => {
		const h = createCanvasHarness(TREE);
		h.session.setRootCollapsed(true);
		h.events.length = 0;

		h.session.runSearch("api", true);
		expect(h.getLastCounter()).toMatchObject({
			total: 2,
			activeIndex: 0,
			text: "1 / 2",
			isEmpty: false,
		});
		expect(h.session.isRootCollapsed()).toBe(false);
		expect(h.events).toContain("reveal:c1");
		expect(h.events).toContain("highlight:c1,b2|active:c1");

		h.session.stepSearch(1);
		expect(h.getLastCounter()?.text).toBe("2 / 2");
		expect(h.events).toContain("reveal:b2");

		h.session.runSearch("nomatch", true);
		expect(h.getLastCounter()).toMatchObject({
			total: 0,
			text: "无匹配",
			isEmpty: true,
		});
	});

	it("runs consistent post-event overlay sync pipelines and guards internal refreshes", () => {
		const h = createCanvasHarness(TREE);

		// Style change must sync collapse badges, note badges, handles, toolbar, and minimap together
		h.session.syncCanvas("style");
		expect(h.events).toEqual([
			"syncCollapseBadges",
			"syncNoteBadges",
			"quickAdd",
			"noteToolbar",
			"minimap",
		]);

		h.events.length = 0;
		h.session.runInternalRefresh(() => {
			expect(h.session.canProcessCanvasMutation()).toBe(false);
			h.session.syncCanvas("selection");
		});
		// During internal refresh, Split View selection notification is suppressed
		expect(h.events).not.toContain("splitNotify");
		expect(h.session.canProcessCanvasMutation()).toBe(true);

		h.events.length = 0;
		h.session.syncCanvas("selection");
		expect(h.events).toContain("splitNotify");
		expect(h.events).toContain("noteSelection");
	});
});
