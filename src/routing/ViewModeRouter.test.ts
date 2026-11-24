import { describe, expect, it } from "vitest";
import { isMindMapFrontmatterValue } from "../parser/markdownParser";
import { MINDMAP_VIEW_TYPE } from "../settings/types";
import {
	ViewModeRouter,
	isImePeriodToggleShortcut,
	type LeafSnapshot,
	type ViewModeRouterAdapter,
	type ViewStateTarget,
} from "./ViewModeRouter";

interface FakeLeaf {
	id: string;
	kind: "mindmap" | "markdown" | "other";
	filePath: string | null;
	rawMarkdown?: string | null;
}

function createHarness(opts?: {
	autoOpen?: boolean;
	mindMapPaths?: string[];
	holdApply?: boolean;
}) {
	const mindMapPaths = new Set(opts?.mindMapPaths ?? ["maps/a.md", "maps/b.md"]);
	let autoOpen = opts?.autoOpen ?? true;
	const events: string[] = [];
	let releaseApply: (() => void) | null = null;

	const adapter: ViewModeRouterAdapter<FakeLeaf> = {
		isAutoOpenEnabled: () => autoOpen,
		isMindMapPath: (p) => mindMapPaths.has(p),
		inspectLeaf: (leaf): LeafSnapshot => ({
			kind: leaf.kind,
			filePath: leaf.filePath,
			rawMarkdown: leaf.rawMarkdown,
		}),
		prepareForSwitch: async (leaf, currentKind) => {
			events.push(`prepare:${leaf.id}:${currentKind}`);
		},
		applyViewState: async (leaf, target: ViewStateTarget) => {
			events.push(`apply:${leaf.id}:${target.type}:${target.filePath}`);
			if (opts?.holdApply) {
				await new Promise<void>((resolve) => {
					releaseApply = resolve;
				});
			}
			leaf.kind = target.type === "mindmap" ? "mindmap" : "markdown";
			leaf.filePath = target.filePath;
		},
	};

	const router = new ViewModeRouter(adapter);
	return {
		router,
		events,
		setAutoOpen: (v: boolean) => {
			autoOpen = v;
		},
		release: () => releaseApply?.(),
	};
}

describe("ViewModeRouter", () => {
	it("evaluates mindmap frontmatter values consistently across types and strings", () => {
		expect(isMindMapFrontmatterValue("basic")).toBe(true);
		expect(isMindMapFrontmatterValue(true)).toBe(true);
		expect(isMindMapFrontmatterValue(false)).toBe(false);
		expect(isMindMapFrontmatterValue("false")).toBe(false);
		expect(isMindMapFrontmatterValue("FALSE")).toBe(false);
		expect(isMindMapFrontmatterValue("   ")).toBe(false);
		expect(isMindMapFrontmatterValue(null)).toBe(false);
		expect(isMindMapFrontmatterValue(undefined)).toBe(false);
	});

	it("redirects Mind Map Notes to mindmap view unless auto-open is disabled or overridden", async () => {
		const { router, setAutoOpen } = createHarness();
		const leaf: FakeLeaf = { id: "L1", kind: "mindmap", filePath: "maps/a.md" };

		expect(router.resolveIncomingViewType(leaf, "markdown", "maps/a.md")).toBe(
			MINDMAP_VIEW_TYPE
		);
		expect(router.resolveIncomingViewType(leaf, "markdown", "notes/regular.md")).toBe(
			"markdown"
		);

		// Switching to Source Mode installs a View-Mode Override for maps/a.md
		await router.switchToSourceMode(leaf, "maps/a.md");
		expect(router.hasOverrideFor(leaf, "maps/a.md")).toBe(true);
		expect(router.resolveIncomingViewType(leaf, "markdown", "maps/a.md")).toBe(
			"markdown"
		);

		// Navigating the SAME leaf to a DIFFERENT Mind Map Note clears the override and redirects
		expect(router.resolveIncomingViewType(leaf, "markdown", "maps/b.md")).toBe(
			MINDMAP_VIEW_TYPE
		);
		expect(router.hasOverrideFor(leaf, "maps/a.md")).toBe(false);

		// Disabling auto-open leaves markdown untouched
		setAutoOpen(false);
		expect(router.resolveIncomingViewType(leaf, "markdown", "maps/a.md")).toBe(
			"markdown"
		);
	});

	it("prepares (commits + saves) before switching and toggles both directions cleanly", async () => {
		const { router, events } = createHarness();
		const leaf: FakeLeaf = { id: "L1", kind: "mindmap", filePath: "maps/a.md" };

		expect(router.canToggleLeaf(leaf)).toBe(true);
		expect(await router.toggleLeaf(leaf)).toBe(true);
		expect(leaf.kind).toBe("markdown");
		expect(events).toEqual([
			"prepare:L1:mindmap",
			"apply:L1:markdown:maps/a.md",
		]);

		// Toggle back to Mind Map clears override and saves Markdown first
		expect(await router.toggleLeaf(leaf)).toBe(true);
		expect(leaf.kind).toBe("mindmap");
		expect(router.hasOverrideFor(leaf, "maps/a.md")).toBe(false);
		expect(events).toEqual([
			"prepare:L1:mindmap",
			"apply:L1:markdown:maps/a.md",
			"prepare:L1:markdown",
			"apply:L1:mindmap:maps/a.md",
		]);
	});

	it("falls back to rawMarkdown when metadataCache has not indexed new frontmatter yet", async () => {
		const { router } = createHarness({ mindMapPaths: [] });
		const freshLeaf: FakeLeaf = {
			id: "L2",
			kind: "markdown",
			filePath: "notes/fresh.md",
			rawMarkdown: "---\nmindmap-plugin: basic\n---\n\n# Topic\n",
		};
		const plainLeaf: FakeLeaf = {
			id: "L3",
			kind: "markdown",
			filePath: "notes/plain.md",
			rawMarkdown: "# Ordinary Note\n",
		};

		expect(router.isMarkdownMindMapLeaf(freshLeaf)).toBe(true);
		expect(router.canToggleLeaf(freshLeaf)).toBe(true);
		expect(router.shouldAutoOpenOnLayoutReady(freshLeaf)).toBe("notes/fresh.md");

		expect(router.isMarkdownMindMapLeaf(plainLeaf)).toBe(false);
		expect(router.canToggleLeaf(plainLeaf)).toBe(false);
		expect(await router.toggleLeaf(plainLeaf)).toBe(false);
	});

	it("guards against overlapping re-entrant view switches", async () => {
		const { router, events, release } = createHarness({ holdApply: true });
		const leaf: FakeLeaf = { id: "L1", kind: "mindmap", filePath: "maps/a.md" };

		const first = router.switchToSourceMode(leaf, "maps/a.md");
		// Yield one microtask so first enters applyViewState
		await Promise.resolve();
		const second = router.switchToSourceMode(leaf, "maps/a.md");
		release();
		await Promise.all([first, second]);

		expect(events).toEqual([
			"prepare:L1:mindmap",
			"apply:L1:markdown:maps/a.md",
		]);
	});

	it("matches Ctrl+. / Cmd+. including Chinese IME Period events and ignores other combos", () => {
		expect(
			isImePeriodToggleShortcut({
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				key: ".",
				code: "Period",
			})
		).toBe(true);

		expect(
			isImePeriodToggleShortcut({
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				key: "Process",
				code: "Period",
			})
		).toBe(true);

		expect(
			isImePeriodToggleShortcut({
				ctrlKey: false,
				metaKey: true,
				altKey: false,
				shiftKey: false,
				key: "。",
				code: "Period",
			})
		).toBe(true);

		expect(
			isImePeriodToggleShortcut({
				ctrlKey: true,
				metaKey: false,
				altKey: true,
				shiftKey: false,
				key: ".",
				code: "Period",
			})
		).toBe(false);

		expect(
			isImePeriodToggleShortcut({
				ctrlKey: true,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				key: "/",
				code: "Slash",
			})
		).toBe(false);
	});
});
