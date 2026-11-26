import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMindMapFrontmatterValue } from "../parser/markdownParser";
import { MINDMAP_VIEW_TYPE, type SplitLayout } from "../settings/types";
import {
	WorkspaceSession,
	inferLayoutFromRects,
	isImePeriodToggleShortcut,
	splitLayoutToObsidianDirection,
	type LeafRect,
	type ObsidianSplitDirection,
	type ViewStateTarget,
	type WorkspaceSessionAdapter,
} from "./WorkspaceSession";

interface FakeLeaf {
	id: string;
	kind: "mindmap" | "markdown" | "other";
	filePath: string | null;
	markdown: string;
	dirty: boolean;
	pendingInlineEdit?: string;
	rect: LeafRect | null;
}

function createWorkspaceHarness(opts?: {
	initialLeaves?: FakeLeaf[];
	autoOpen?: boolean;
	layoutReady?: boolean;
	defaultSplitLayout?: SplitLayout;
	mindMapPaths?: string[];
	holdApply?: boolean;
	emitSyncEchoOnSourceApply?: boolean;
}) {
	const leaves = new Set<FakeLeaf>(opts?.initialLeaves ?? []);
	const mindMapPaths = new Set(opts?.mindMapPaths ?? ["maps/a.md", "maps/b.md"]);
	let autoOpen = opts?.autoOpen ?? true;
	let layoutReady = opts?.layoutReady ?? true;
	let defaultSplitLayout: SplitLayout = opts?.defaultSplitLayout ?? "left-right";
	let activeLeaf: FakeLeaf | null = opts?.initialLeaves?.[0] ?? null;
	let nextId = (opts?.initialLeaves?.length ?? 0) + 1;
	let releaseApply: (() => void) | null = null;
	let notifyApplyEntered: (() => void) | null = null;
	const applyEntered = new Promise<void>((resolve) => {
		notifyApplyEntered = resolve;
	});
	const events: string[] = [];

	let session!: WorkspaceSession<FakeLeaf>;

	const adapter: WorkspaceSessionAdapter<FakeLeaf> = {
		isAutoOpenEnabled: () => autoOpen,
		isLayoutReady: () => layoutReady,
		getDefaultSplitLayout: () => defaultSplitLayout,
		isMindMapPath: (p) => mindMapPaths.has(p),

		getAllLeaves: () => Array.from(leaves),
		getActiveLeaf: () => activeLeaf,
		inspectLeaf: (leaf) => ({
			kind: leaf.kind,
			filePath: leaf.filePath,
			rawMarkdown: leaf.markdown,
		}),
		getLeafRect: (leaf) => leaf.rect,

		commitLeafEdit: (leaf) => {
			events.push(`commit:${leaf.id}`);
			if (leaf.pendingInlineEdit !== undefined) {
				leaf.markdown = leaf.pendingInlineEdit;
				leaf.pendingInlineEdit = undefined;
				leaf.dirty = true;
				if (leaf.filePath) {
					session.onMindMapChange(leaf.filePath);
				}
			}
		},
		readLeafMarkdown: (leaf) => leaf.markdown,
		applyMarkdownToMindMapLeaf: (leaf, markdown) => {
			events.push(`syncToMindMap:${leaf.id}:${markdown}`);
			leaf.markdown = markdown;
			leaf.dirty = false;
		},
		applyMarkdownToSourceLeaf: (leaf, markdown) => {
			events.push(`syncToSource:${leaf.id}:${markdown}`);
			leaf.markdown = markdown;
			if (opts?.emitSyncEchoOnSourceApply && leaf.filePath) {
				session.onSourceEditorChange(leaf.filePath, markdown);
			}
		},
		saveLeaf: async (leaf, onlyIfDirty = false) => {
			if (leaf.kind === "mindmap" && onlyIfDirty && !leaf.dirty) {
				return;
			}
			events.push(`save:${leaf.id}:${leaf.markdown}`);
			leaf.dirty = false;
		},

		applyViewState: async (leaf, target: ViewStateTarget) => {
			// Run through the real incoming view-type interceptor just like Obsidian
			const requestedType =
				target.type === "mindmap" ? MINDMAP_VIEW_TYPE : "markdown";
			const resolvedType = session.resolveIncomingViewType(
				leaf,
				requestedType,
				target.filePath
			);
			events.push(`apply:${leaf.id}:${resolvedType}:${target.filePath}`);
			if (opts?.holdApply) {
				await new Promise<void>((resolve) => {
					releaseApply = resolve;
					notifyApplyEntered?.();
				});
			}
			leaf.kind = resolvedType === MINDMAP_VIEW_TYPE ? "mindmap" : "markdown";
			leaf.filePath = target.filePath;
		},
		createSplitLeaf: (originLeaf, direction: ObsidianSplitDirection) => {
			const id = `L${nextId++}`;
			events.push(`split:${originLeaf.id}:${direction}->${id}`);
			const rect: LeafRect =
				direction === "vertical"
					? { left: 500, top: 0, width: 500, height: 800 }
					: { left: 0, top: 400, width: 1000, height: 400 };
			const created: FakeLeaf = {
				id,
				kind: "other",
				filePath: null,
				markdown: originLeaf.markdown,
				dirty: false,
				rect,
			};
			leaves.add(created);
			return created;
		},
		detachLeaf: (leaf) => {
			events.push(`detach:${leaf.id}`);
			leaves.delete(leaf);
		},
		focusLeaf: (leaf) => {
			events.push(`focus:${leaf.id}`);
			activeLeaf = leaf;
		},
		recenterMindMapLeaf: (leaf) => {
			events.push(`recenter:${leaf.id}`);
		},
		revealSourceLine: (leaf, line) => {
			events.push(`revealSource:${leaf.id}:${line}`);
		},
		revealMindMapNode: (leaf, pathKey) => {
			events.push(`revealNode:${leaf.id}:${pathKey}`);
		},
		refreshUi: () => {
			events.push("ui-refresh");
		},

		scheduleTimer: (fn, delayMs) => setTimeout(fn, delayMs),
		cancelTimer: (handle) => clearTimeout(handle),
	};

	session = new WorkspaceSession(adapter, {
		sourceToMindMapDelayMs: 250,
		mindMapToSourceDelayMs: 150,
	});

	return {
		session,
		leaves,
		events,
		setAutoOpen: (v: boolean) => {
			autoOpen = v;
		},
		setLayoutReady: (v: boolean) => {
			layoutReady = v;
		},
		setDefaultSplitLayout: (layout: SplitLayout) => {
			defaultSplitLayout = layout;
		},
		setActiveLeaf: (leaf: FakeLeaf | null) => {
			activeLeaf = leaf;
		},
		waitForApplyEntered: () => applyEntered,
		releaseApply: () => releaseApply?.(),
	};
}

describe("WorkspaceSession", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("evaluates pure routing, shortcut, and split layout helpers consistently", () => {
		expect(isMindMapFrontmatterValue("basic")).toBe(true);
		expect(isMindMapFrontmatterValue(true)).toBe(true);
		expect(isMindMapFrontmatterValue(false)).toBe(false);
		expect(isMindMapFrontmatterValue("false")).toBe(false);
		expect(isMindMapFrontmatterValue("   ")).toBe(false);

		expect(splitLayoutToObsidianDirection("left-right")).toBe("vertical");
		expect(splitLayoutToObsidianDirection("top-bottom")).toBe("horizontal");

		expect(
			inferLayoutFromRects(
				{ left: 0, top: 0, width: 500, height: 800 },
				{ left: 500, top: 0, width: 500, height: 800 }
			)
		).toBe("left-right");
		expect(
			inferLayoutFromRects(
				{ left: 0, top: 0, width: 1000, height: 400 },
				{ left: 0, top: 400, width: 1000, height: 400 }
			)
		).toBe("top-bottom");
		expect(inferLayoutFromRects(null, null)).toBeNull();

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
	});

	it("routes Mind Map Notes with per-tab View-Mode Overrides and falls back to rawMarkdown", async () => {
		const mindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# A",
			dirty: true,
			rect: { left: 0, top: 0, width: 1000, height: 800 },
		};
		const freshLeaf: FakeLeaf = {
			id: "L2",
			kind: "markdown",
			filePath: "notes/fresh.md",
			markdown: "---\nmindmap-plugin: basic\n---\n\n# Topic\n",
			dirty: false,
			rect: null,
		};
		const plainLeaf: FakeLeaf = {
			id: "L3",
			kind: "markdown",
			filePath: "notes/plain.md",
			markdown: "# Ordinary Note\n",
			dirty: false,
			rect: null,
		};

		const { session, setAutoOpen } = createWorkspaceHarness({
			initialLeaves: [mindLeaf, freshLeaf, plainLeaf],
		});

		expect(session.resolveIncomingViewType(mindLeaf, "markdown", "maps/a.md")).toBe(
			MINDMAP_VIEW_TYPE
		);
		expect(session.resolveIncomingViewType(mindLeaf, "markdown", "notes/plain.md")).toBe(
			"markdown"
		);

		// Toggle MindMap -> Source installs View-Mode Override
		expect(await session.toggleViewMode(mindLeaf)).toBe(true);
		expect(mindLeaf.kind).toBe("markdown");
		expect(session.hasOverrideFor(mindLeaf, "maps/a.md")).toBe(true);
		expect(session.resolveIncomingViewType(mindLeaf, "markdown", "maps/a.md")).toBe(
			"markdown"
		);

		// Navigating the same tab to another Mind Map Note clears the override
		expect(session.resolveIncomingViewType(mindLeaf, "markdown", "maps/b.md")).toBe(
			MINDMAP_VIEW_TYPE
		);
		expect(session.hasOverrideFor(mindLeaf, "maps/a.md")).toBe(false);

		// Toggle back to MindMap clears override
		await session.openSourceMode(mindLeaf, "maps/a.md");
		expect(await session.toggleViewMode(mindLeaf)).toBe(true);
		expect(mindLeaf.kind).toBe("mindmap");
		expect(session.hasOverrideFor(mindLeaf, "maps/a.md")).toBe(false);

		// Unindexed frontmatter fallback
		expect(session.isMarkdownMindMapLeaf(freshLeaf)).toBe(true);
		expect(session.canToggleViewMode(freshLeaf)).toBe(true);
		expect(session.isMarkdownMindMapLeaf(plainLeaf)).toBe(false);
		expect(session.canToggleViewMode(plainLeaf)).toBe(false);
		expect(await session.toggleViewMode(plainLeaf)).toBe(false);

		setAutoOpen(false);
		expect(session.resolveIncomingViewType(mindLeaf, "markdown", "maps/a.md")).toBe(
			"markdown"
		);
	});

	it("preserves restored Split Views on layout ready while auto-opening standalone Mind Map Notes", async () => {
		const splitMindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# A",
			dirty: false,
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const splitSourceLeaf: FakeLeaf = {
			id: "L2",
			kind: "markdown",
			filePath: "maps/a.md",
			markdown: "# A",
			dirty: false,
			rect: { left: 500, top: 0, width: 500, height: 800 },
		};
		const standaloneLeaf: FakeLeaf = {
			id: "L3",
			kind: "markdown",
			filePath: "maps/b.md",
			markdown: "# B",
			dirty: false,
			rect: { left: 0, top: 0, width: 1000, height: 800 },
		};

		const { session } = createWorkspaceHarness({
			initialLeaves: [splitMindLeaf, splitSourceLeaf, standaloneLeaf],
		});

		await session.restoreOnLayoutReady();

		expect(splitSourceLeaf.kind).toBe("markdown");
		expect(session.hasOverrideFor(splitSourceLeaf, "maps/a.md")).toBe(true);
		expect(
			session.resolveIncomingViewType(splitSourceLeaf, "markdown", "maps/a.md")
		).toBe("markdown");
		expect(standaloneLeaf.kind).toBe("mindmap");
		expect(session.getSplitState(splitMindLeaf)).toEqual({
			isActive: true,
			layout: "left-right",
			counterpartLeaf: splitSourceLeaf,
		});
	});

	it("does not hijack Split View Source panes during cold startup restoration or deferred tab hydration", async () => {
		const leftLeaf: FakeLeaf = {
			id: "L1",
			kind: "other",
			filePath: null,
			markdown: "# A",
			dirty: false,
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const rightLeaf: FakeLeaf = {
			id: "L2",
			kind: "other",
			filePath: null,
			markdown: "# A",
			dirty: false,
			rect: { left: 500, top: 0, width: 500, height: 800 },
		};
		const deferredSourceLeaf: FakeLeaf = {
			id: "L3",
			kind: "other",
			filePath: null,
			markdown: "# A",
			dirty: false,
			rect: { left: 500, top: 0, width: 500, height: 800 },
		};

		const { session, setLayoutReady } = createWorkspaceHarness({
			initialLeaves: [leftLeaf, rightLeaf, deferredSourceLeaf],
			autoOpen: true,
			layoutReady: false,
		});

		// 1. Cold startup before layoutReady: Obsidian restores left as mindmap and right as markdown
		expect(
			session.resolveIncomingViewType(leftLeaf, MINDMAP_VIEW_TYPE, "maps/a.md")
		).toBe(MINDMAP_VIEW_TYPE);
		leftLeaf.kind = "mindmap";
		leftLeaf.filePath = "maps/a.md";

		expect(
			session.resolveIncomingViewType(rightLeaf, "markdown", "maps/a.md", "source")
		).toBe("markdown");
		rightLeaf.kind = "markdown";
		rightLeaf.filePath = "maps/a.md";

		// 2. Layout ready fires: rightLeaf gets a View-Mode Override and stays in Source Mode
		setLayoutReady(true);
		await session.restoreOnLayoutReady();
		expect(rightLeaf.kind).toBe("markdown");
		expect(session.hasOverrideFor(rightLeaf, "maps/a.md")).toBe(true);
		expect(
			session.resolveIncomingViewType(rightLeaf, "markdown", "maps/a.md", "source")
		).toBe("markdown");

		// 3. Deferred Source Mode tab hydrated AFTER layoutReady also stays in Source Mode
		expect(
			session.resolveIncomingViewType(
				deferredSourceLeaf,
				"markdown",
				"maps/a.md",
				"source"
			)
		).toBe("markdown");
		expect(session.hasOverrideFor(deferredSourceLeaf, "maps/a.md")).toBe(true);
	});

	it("installs View-Mode Override when opening Split View so auto-open never hijacks the Source pane", async () => {
		const mindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# Root",
			dirty: false,
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const { session, leaves, events } = createWorkspaceHarness({
			initialLeaves: [mindLeaf],
			autoOpen: true,
		});

		// Open left-right split: applyViewState runs through resolveIncomingViewType!
		expect(await session.openOrSwitchSplit(mindLeaf, "left-right")).toBe(true);
		const state1 = session.getSplitState(mindLeaf);
		expect(state1.isActive).toBe(true);
		expect(state1.layout).toBe("left-right");
		expect(state1.counterpartLeaf?.kind).toBe("markdown");
		if (!state1.counterpartLeaf) {
			throw new Error("Expected counterpart leaf to be created");
		}
		expect(session.hasOverrideFor(state1.counterpartLeaf, "maps/a.md")).toBe(true);
		expect(events).toContain("recenter:L1");

		// Switch to top-bottom layout
		mindLeaf.rect = { left: 0, top: 0, width: 1000, height: 400 };
		expect(await session.flipSplitLayout(mindLeaf)).toBe(true);
		const state2 = session.getSplitState(mindLeaf);
		expect(state2.isActive).toBe(true);
		expect(state2.layout).toBe("top-bottom");
		expect(state2.counterpartLeaf?.kind).toBe("markdown");
		expect(leaves.size).toBe(2);

		// Toggle same layout closes split and recenters Mind Map
		expect(await session.toggleSplitLayout(mindLeaf, "top-bottom")).toBe(true);
		expect(session.getSplitState(mindLeaf).isActive).toBe(false);
		expect(leaves.size).toBe(1);
	});

	it("commits active Node Inline Editor BEFORE flushing sync when changing Split View layout", async () => {
		const mindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# Initial",
			dirty: false,
			pendingInlineEdit: "# Edited Inside Inline Box",
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const sourceLeaf: FakeLeaf = {
			id: "L2",
			kind: "markdown",
			filePath: "maps/a.md",
			markdown: "# Initial",
			dirty: false,
			rect: { left: 500, top: 0, width: 500, height: 800 },
		};

		const { session, events } = createWorkspaceHarness({
			initialLeaves: [mindLeaf, sourceLeaf],
		});

		mindLeaf.rect = { left: 0, top: 0, width: 1000, height: 400 };
		expect(await session.openOrSwitchSplit(mindLeaf, "top-bottom")).toBe(true);

		const commitIdx = events.indexOf("commit:L1");
		const syncIdx = events.indexOf("syncToSource:L2:# Edited Inside Inline Box");
		const detachIdx = events.indexOf("detach:L2");
		expect(commitIdx).toBeGreaterThanOrEqual(0);
		expect(syncIdx).toBeGreaterThan(commitIdx);
		expect(detachIdx).toBeGreaterThan(syncIdx);
		expect(mindLeaf.markdown).toBe("# Edited Inside Inline Box");
	});

	it("blocks single-pane view toggling while Split View is active and unlocks after closing split", async () => {
		const mindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# A",
			dirty: false,
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const { session, leaves } = createWorkspaceHarness({
			initialLeaves: [mindLeaf],
		});

		expect(session.canToggleViewMode(mindLeaf)).toBe(true);
		await session.openOrSwitchSplit(mindLeaf, "left-right");
		const sourceLeaf = session.getSplitState(mindLeaf).counterpartLeaf;
		if (!sourceLeaf) {
			throw new Error("Expected source counterpart leaf");
		}
		expect(leaves.size).toBe(2);

		// Neither pane can toggle view mode while Split View is active, but split controls stay enabled
		expect(session.canToggleViewMode(mindLeaf)).toBe(false);
		expect(session.canToggleViewMode(sourceLeaf)).toBe(false);
		expect(session.canSplit(mindLeaf)).toBe(true);
		expect(session.canSplit(sourceLeaf)).toBe(true);

		expect(await session.toggleViewMode(mindLeaf)).toBe(false);
		expect(await session.toggleViewMode(sourceLeaf)).toBe(false);
		await session.openSourceMode(mindLeaf, "maps/a.md");
		await session.openMindMap(sourceLeaf, "maps/a.md");

		expect(mindLeaf.kind).toBe("mindmap");
		expect(sourceLeaf.kind).toBe("markdown");
		expect(session.getSplitState(mindLeaf).isActive).toBe(true);

		// Closing Split View re-enables single-pane view toggling
		expect(await session.closeSplit(mindLeaf)).toBe(true);
		expect(session.canToggleViewMode(mindLeaf)).toBe(true);
		expect(await session.toggleViewMode(mindLeaf)).toBe(true);
		expect(mindLeaf.kind).toBe("markdown");
	});

	it("swaps Split View pane positions in place while committing edits, swapping overrides, and preserving layout", async () => {
		const leftLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# Initial",
			dirty: false,
			pendingInlineEdit: "# Swapped With Inline Edit",
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const rightLeaf: FakeLeaf = {
			id: "L2",
			kind: "markdown",
			filePath: "maps/a.md",
			markdown: "# Initial",
			dirty: false,
			rect: { left: 500, top: 0, width: 500, height: 800 },
		};
		const { session, leaves, events } = createWorkspaceHarness({
			initialLeaves: [leftLeaf, rightLeaf],
			autoOpen: true,
		});

		// Swap from the Mind Map pane (L1 -> Source, L2 -> Mind Map)
		expect(await session.swapSplitPositions(leftLeaf)).toBe(true);
		expect(leaves.size).toBe(2);
		expect(events.filter((e) => e.startsWith("detach:"))).toHaveLength(0);
		expect(leftLeaf.kind).toBe("markdown");
		expect(rightLeaf.kind).toBe("mindmap");
		expect(leftLeaf.markdown).toBe("# Swapped With Inline Edit");
		expect(rightLeaf.markdown).toBe("# Swapped With Inline Edit");
		expect(session.hasOverrideFor(leftLeaf, "maps/a.md")).toBe(true);
		expect(session.hasOverrideFor(rightLeaf, "maps/a.md")).toBe(false);
		expect(session.getSplitState(rightLeaf)).toEqual({
			isActive: true,
			layout: "left-right",
			counterpartLeaf: leftLeaf,
		});
		expect(events).toContain("focus:L2");
		expect(events).toContain("recenter:L2");

		// Swap back from the Source Mode pane (L1 -> Mind Map, L2 -> Source)
		expect(await session.swapSplitPositions(leftLeaf)).toBe(true);
		expect(leftLeaf.kind).toBe("mindmap");
		expect(rightLeaf.kind).toBe("markdown");
		expect(session.hasOverrideFor(rightLeaf, "maps/a.md")).toBe(true);
		expect(session.hasOverrideFor(leftLeaf, "maps/a.md")).toBe(false);
	});

	it("returns context-aware file menu open actions for Mind Map, Source Mode, Split View, and unopened files", async () => {
		const mindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# A",
			dirty: false,
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const { session, setAutoOpen } = createWorkspaceHarness({
			initialLeaves: [mindLeaf],
			mindMapPaths: ["maps/a.md", "maps/b.md"],
			autoOpen: true,
		});

		// 1. Currently open as Mind Map -> offer Source Mode on that leaf
		expect(session.getFileMenuOpenAction("maps/a.md")).toEqual({
			action: "open-source",
			targetLeaf: mindLeaf,
		});

		// 2. Unopened Mind Map Note with auto-open enabled -> offer Source Mode
		expect(session.getFileMenuOpenAction("maps/b.md")).toEqual({
			action: "open-source",
			targetLeaf: null,
		});

		// 3. Regular Markdown note -> offer Mind Map
		expect(session.getFileMenuOpenAction("notes/plain.md")).toEqual({
			action: "open-mindmap",
			targetLeaf: null,
		});

		// 4. Open in Split View -> no single-pane switch action
		await session.openOrSwitchSplit(mindLeaf, "left-right");
		expect(session.getFileMenuOpenAction("maps/a.md")).toEqual({
			action: "none",
		});

		// 5. After closing Split View and switching to Source Mode -> offer Mind Map
		await session.closeSplit(mindLeaf);
		await session.openSourceMode(mindLeaf, "maps/a.md");
		expect(session.getFileMenuOpenAction("maps/a.md")).toEqual({
			action: "open-mindmap",
			targetLeaf: mindLeaf,
		});

		// 6. Unopened Mind Map Note when auto-open is disabled -> offer Mind Map
		setAutoOpen(false);
		expect(session.getFileMenuOpenAction("maps/b.md")).toEqual({
			action: "open-mindmap",
			targetLeaf: null,
		});
	});

	it("performs debounced bidirectional sync with echo suppression and focus-change flush", async () => {
		const mindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# Start",
			dirty: false,
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const sourceLeaf: FakeLeaf = {
			id: "L2",
			kind: "markdown",
			filePath: "maps/a.md",
			markdown: "# Start",
			dirty: false,
			rect: { left: 500, top: 0, width: 500, height: 800 },
		};

		const { session, events } = createWorkspaceHarness({
			initialLeaves: [mindLeaf, sourceLeaf],
			emitSyncEchoOnSourceApply: true,
		});
		session.recordSyncedMarkdown("maps/a.md", "# Start");

		// 1. Mind Map edit -> Source sync + save (150ms debounce)
		mindLeaf.markdown = "# From Map";
		mindLeaf.dirty = true;
		session.onMindMapChange("maps/a.md");
		await vi.advanceTimersByTimeAsync(150);
		expect(sourceLeaf.markdown).toBe("# From Map");

		// Deferred echo from Obsidian after vault.modify must be ignored
		session.onSourceEditorChange("maps/a.md", "# From Map");
		vi.advanceTimersByTime(500);
		expect(events.filter((e) => e.startsWith("syncToMindMap:"))).toHaveLength(0);

		// 2. Genuine Source edit -> Mind Map sync (250ms debounce)
		session.onSourceEditorChange("maps/a.md", "# From Source");
		vi.advanceTimersByTime(250);
		expect(mindLeaf.markdown).toBe("# From Source");

		// 3. Undo in Source back to "# From Map" must still sync!
		session.onSourceEditorChange("maps/a.md", "# From Map");
		vi.advanceTimersByTime(250);
		expect(mindLeaf.markdown).toBe("# From Map");

		// 4. Focus switch into Mind Map flushes pending Source edit immediately
		session.onActiveLeafChange(sourceLeaf);
		session.onSourceEditorChange("maps/a.md", "# Unflushed Draft");
		session.onActiveLeafChange(mindLeaf);
		expect(mindLeaf.markdown).toBe("# Unflushed Draft");

		// 5. Focus switch out of Mind Map commits inline edit & flushes to Source
		mindLeaf.pendingInlineEdit = "# Inline On Blur";
		session.onActiveLeafChange(sourceLeaf);
		await Promise.resolve();
		expect(sourceLeaf.markdown).toBe("# Inline On Blur");
	});

	it("guards against overlapping re-entrant transitions and cleans up timers on dispose", async () => {
		const mindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# A",
			dirty: false,
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const sourceLeaf: FakeLeaf = {
			id: "L2",
			kind: "markdown",
			filePath: "maps/b.md",
			markdown: "# B",
			dirty: false,
			rect: { left: 500, top: 0, width: 500, height: 800 },
		};

		const { session, events, waitForApplyEntered, releaseApply } =
			createWorkspaceHarness({
				initialLeaves: [mindLeaf, sourceLeaf],
				holdApply: true,
			});

		const first = session.openSourceMode(mindLeaf, "maps/a.md");
		await waitForApplyEntered();
		const second = session.openSourceMode(mindLeaf, "maps/a.md");
		releaseApply();
		await Promise.all([first, second]);

		expect(events.filter((e) => e.startsWith("apply:L1:"))).toHaveLength(1);

		session.onSourceEditorChange("maps/b.md", "# Pending");
		session.dispose();
		await vi.advanceTimersByTimeAsync(1000);
		expect(events.filter((e) => e.startsWith("syncToMindMap:"))).toHaveLength(0);
	});

	it("bidirectionally locates matching Source lines and Mind Map nodes in Split View without echo loops", () => {
		const md = [
			"---",
			"mindmap-plugin: basic",
			"---",
			"",
			"# Root",
			"",
			"## Branch A",
			"- Child A1",
			"- Child A2",
			"",
			"## Branch B",
			"- Child B1",
		].join("\n");

		const mindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: md,
			dirty: false,
			rect: { left: 0, top: 0, width: 500, height: 800 },
		};
		const sourceLeaf: FakeLeaf = {
			id: "L2",
			kind: "markdown",
			filePath: "maps/a.md",
			markdown: md,
			dirty: false,
			rect: { left: 500, top: 0, width: 500, height: 800 },
		};
		const standaloneMindLeaf: FakeLeaf = {
			id: "L3",
			kind: "mindmap",
			filePath: "maps/b.md",
			markdown: md,
			dirty: false,
			rect: { left: 0, top: 0, width: 1000, height: 800 },
		};

		const { session, events } = createWorkspaceHarness({
			initialLeaves: [mindLeaf, sourceLeaf, standaloneMindLeaf],
		});

		// Non-split file does nothing
		session.onMindMapNodeSelected("maps/b.md", "0.0.1", "Child A2");
		expect(events.filter((e) => e.startsWith("revealSource:"))).toHaveLength(0);

		// 1. Selecting node "0.0.1" (Child A2) in Mind Map reveals line 8 in Source Mode
		session.onMindMapNodeSelected("maps/a.md", "0.0.1", "Child A2");
		expect(events).toContain("revealSource:L2:8");

		// Programmatic cursor echo at line 8 is suppressed (no bounce back to Mind Map)
		session.onSourceCursorLineChanged("maps/a.md", md, 8);
		expect(events.filter((e) => e.startsWith("revealNode:"))).toHaveLength(0);

		// 2. Moving cursor to line 11 (Child B1) in Source Mode locates node "0.1.0" in Mind Map
		session.onSourceCursorLineChanged("maps/a.md", md, 11);
		expect(events).toContain("revealNode:L1:0.1.0");

		// Staying on the same line without force deduplicates
		const countAfterFirst = events.filter((e) =>
			e.startsWith("revealNode:")
		).length;
		session.onSourceCursorLineChanged("maps/a.md", md, 11);
		expect(
			events.filter((e) => e.startsWith("revealNode:")).length
		).toBe(countAfterFirst);

		// Explicit click (force: true) re-locates even on the same node
		session.onSourceCursorLineChanged("maps/a.md", md, 11, { force: true });
		expect(
			events.filter((e) => e.startsWith("revealNode:")).length
		).toBe(countAfterFirst + 1);
	});

	it("projects canonical Split View action descriptors for single-pane, left-right, and top-bottom layouts", async () => {
		const mindLeaf: FakeLeaf = {
			id: "L1",
			kind: "mindmap",
			filePath: "maps/a.md",
			markdown: "# Root",
			dirty: false,
			rect: { left: 0, top: 0, width: 1000, height: 800 },
		};
		const { session } = createWorkspaceHarness({
			initialLeaves: [mindLeaf],
		});

		expect(session.getSplitActionDescriptor(mindLeaf)).toMatchObject({
			isActive: false,
			layout: null,
			showSwapAction: false,
			swapIconId: "arrow-left-right",
			canSwitchSinglePaneMode: true,
		});

		await session.openOrSwitchSplit(mindLeaf, "left-right");
		expect(session.getSplitActionDescriptor(mindLeaf)).toMatchObject({
			isActive: true,
			layout: "left-right",
			showSwapAction: true,
			swapIconId: "arrow-left-right",
			swapTitle: "调换左右位置（脑图 ↔ 源码）",
			canSwitchSinglePaneMode: false,
		});

		mindLeaf.rect = { left: 0, top: 0, width: 1000, height: 400 };
		await session.openOrSwitchSplit(mindLeaf, "top-bottom");
		expect(session.getSplitActionDescriptor(mindLeaf)).toMatchObject({
			isActive: true,
			layout: "top-bottom",
			showSwapAction: true,
			swapIconId: "arrow-up-down",
			swapTitle: "调换上下位置（脑图 ↔ 源码）",
			canSwitchSinglePaneMode: false,
		});
	});
});
