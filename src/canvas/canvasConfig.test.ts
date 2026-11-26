import { describe, expect, it } from "vitest";
import { DEFAULT_HOTKEYS } from "../settings/types";
import {
	buildCanvasKeypressOptions,
	buildCanvasTheme,
	buildCenterBezierPath,
	buildContextMenuOption,
	buildHorizontalBracketPath,
	buildVerticalBracketPath,
	computeContextMenuPosition,
	countDescendantNodes,
	createCanvasRelinkScheduler,
	formatDescendantCountBadge,
	formatHotkeyForDisplay,
	isImageEventTarget,
	normalizeHotkeyKey,
	resolveEffectiveDarkMode,
	type CanvasKeypressTarget,
} from "./canvasConfig";

function createFakeCanvasTarget() {
	const calls: string[] = [];
	const target: CanvasKeypressTarget = {
		currentNode: null,
		currentNodes: [],
		currentSummary: null,
		currentArrow: null,
		addChild: () => calls.push("addChild"),
		insertSibling: (type) => calls.push(`insertSibling:${type}`),
		insertParent: () => calls.push("insertParent"),
		editSummary: (s) => calls.push(`editSummary:${s.summaryObj.id}`),
		editArrowLabel: () => calls.push("editArrowLabel"),
		beginEdit: () => calls.push("beginEdit"),
		removeNodes: (nodes) => calls.push(`removeNodes:${nodes.length}`),
		removeArrow: () => calls.push("removeArrow"),
		removeSummary: (id) => calls.push(`removeSummary:${id}`),
		toCenter: () => calls.push("toCenter"),
		expandNode: () => calls.push("expandNode"),
	};
	return { target, calls };
}

function keyEvt(partial?: Partial<KeyboardEvent>): KeyboardEvent {
	return {
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		...partial,
	} as KeyboardEvent;
}

describe("canvasConfig", () => {
	it("normalizes and formats Space and regular hotkey names cleanly", () => {
		expect(normalizeHotkeyKey("Space")).toBe(" ");
		expect(normalizeHotkeyKey(" Tab ")).toBe("Tab");
		expect(normalizeHotkeyKey("   ")).toBe("");
		expect(formatHotkeyForDisplay(" ")).toBe("Space");
		expect(formatHotkeyForDisplay("F2")).toBe("F2");
	});

	it("synthesizes Obsidian light and dark themes with CSS token fallbacks", () => {
		expect(resolveEffectiveDarkMode("auto", true)).toBe(true);
		expect(resolveEffectiveDarkMode("auto", false)).toBe(false);
		expect(resolveEffectiveDarkMode("light", true)).toBe(false);
		expect(resolveEffectiveDarkMode("dark", false)).toBe(true);

		const customTokens: Record<string, string> = {
			"--background-primary": "#111111",
			"--interactive-accent": "#ff0055",
		};
		const darkTheme = buildCanvasTheme("dark", false, (v) => customTokens[v] ?? "");
		expect(darkTheme.name).toBe("ObsidianDark");
		expect(darkTheme.type).toBe("dark");
		expect(darkTheme.cssVar?.["--bgcolor"]).toBe("#111111");
		expect(darkTheme.cssVar?.["--root-bgcolor"]).toBe("#ff0055");
		expect(darkTheme.cssVar?.["--color"]).toBe("#dcddde");

		const lightTheme = buildCanvasTheme("light", true, () => "");
		expect(lightTheme.name).toBe("ObsidianLight");
		expect(lightTheme.cssVar?.["--bgcolor"]).toBe("#ffffff");
	});

	it("dispatches sibling/parent modifiers and edit/delete selection precedence", () => {
		const { target, calls } = createFakeCanvasTarget();
		const keymap = buildCanvasKeypressOptions(
			{ ...DEFAULT_HOTKEYS, toggleCollapse: "Space" },
			() => target
		);

		// Sibling modifier branching
		keymap["Enter"](keyEvt());
		keymap["Enter"](keyEvt({ shiftKey: true }));
		keymap["Enter"](keyEvt({ ctrlKey: true }));
		expect(calls.splice(0)).toEqual([
			"insertSibling:after",
			"insertSibling:before",
			"insertParent",
		]);

		// Edit priority: summary > arrow > node
		target.currentSummary = { summaryObj: { id: "s1" } };
		target.currentArrow = { id: "a1" };
		keymap["F2"](keyEvt());
		target.currentSummary = null;
		keymap["F2"](keyEvt());
		target.currentArrow = null;
		keymap["F2"](keyEvt());
		expect(calls.splice(0)).toEqual([
			"editSummary:s1",
			"editArrowLabel",
			"beginEdit",
		]);

		// Delete priority: nodes > arrow > summary
		target.currentNodes = [{ id: "n1" }, { id: "n2" }];
		target.currentArrow = { id: "a1" };
		target.currentSummary = { summaryObj: { id: "s1" } };
		keymap["Delete"](keyEvt());
		target.currentNodes = [];
		keymap["Delete"](keyEvt());
		target.currentArrow = null;
		keymap["Delete"](keyEvt());
		expect(calls.splice(0)).toEqual([
			"removeNodes:2",
			"removeArrow",
			"removeSummary:s1",
		]);

		// Toggle collapse via normalized "Space" -> " " only runs when node has children
		target.currentNode = { nodeObj: { children: [] } };
		keymap[" "](keyEvt());
		expect(calls).toEqual([]);
		target.currentNode = { nodeObj: { children: [{}] } };
		keymap[" "](keyEvt());
		expect(calls).toEqual(["expandNode"]);
	});

	it("coalesces image-load relinks into one frame and respects readiness and cancellation", () => {
		expect(isImageEventTarget({ tagName: "IMG" } as unknown as EventTarget)).toBe(true);
		expect(isImageEventTarget({ tagName: "img" } as unknown as EventTarget)).toBe(true);
		expect(isImageEventTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
		expect(isImageEventTarget(null)).toBe(false);

		const frames = new Map<number, () => void>();
		let nextId = 1;
		let ready = true;
		let relinkCount = 0;

		const scheduler = createCanvasRelinkScheduler({
			isReady: () => ready,
			linkDiv: () => {
				relinkCount++;
			},
			requestFrame: (cb) => {
				const id = nextId++;
				frames.set(id, cb);
				return id;
			},
			cancelFrame: (id) => {
				frames.delete(id);
			},
		});

		// Multiple concurrent image loads coalesce into a single linkDiv() call
		scheduler.schedule();
		scheduler.schedule();
		scheduler.schedule();
		expect(frames.size).toBe(1);

		const [firstId, firstCb] = Array.from(frames.entries())[0];
		frames.delete(firstId);
		firstCb();
		expect(relinkCount).toBe(1);

		// Hidden / detached canvas skips linkDiv()
		ready = false;
		scheduler.schedule();
		const [secondId, secondCb] = Array.from(frames.entries())[0];
		frames.delete(secondId);
		secondCb();
		expect(relinkCount).toBe(1);

		// Cancellation aborts pending frame cleanly
		ready = true;
		scheduler.schedule();
		expect(frames.size).toBe(1);
		scheduler.cancel();
		expect(frames.size).toBe(0);
	});

	it("builds localized node context menu options defaulting to Simplified Chinese", () => {
		const zhDefault = buildContextMenuOption(undefined);
		expect(zhDefault.focus).toBe(true);
		expect(zhDefault.link).toBe(true);
		expect(zhDefault.locale?.addChild).toBe("添加子节点");
		expect(zhDefault.locale?.removeNode).toBe("删除节点");
		expect(zhDefault.locale?.summary).toBe("添加概要");

		const enMenu = buildContextMenuOption("en");
		expect(enMenu.locale?.addChild).toBe("Add child");
		expect(enMenu.locale?.linkBidirectional).toBe("Bidirectional Link");

		const jaMenu = buildContextMenuOption("ja");
		expect(jaMenu.locale?.addChild).toBe("子ノードを追加");
	});

	it("attaches rounded orthogonal or bezier branch generators for card and bordered presets", () => {
		const classicTheme = buildCanvasTheme("light", false, () => "", "classic");
		expect(classicTheme.generateMainBranch).toBeUndefined();
		expect(classicTheme.generateSubBranch).toBeUndefined();

		const cardTheme = buildCanvasTheme("dark", true, () => "", "card");
		expect(typeof cardTheme.generateMainBranch).toBe("function");
		expect(typeof cardTheme.generateSubBranch).toBe("function");

		const borderedTheme = buildCanvasTheme("light", false, () => "", "bordered");
		expect(typeof borderedTheme.generateMainBranch).toBe("function");
		expect(typeof borderedTheme.generateSubBranch).toBe("function");

		// Geometry helpers: aligned vs elbowed horizontal/vertical brackets and bezier
		expect(buildHorizontalBracketPath(100, 50, 200, 50)).toBe("M 100 50 H 200");
		expect(buildHorizontalBracketPath(100, 50, 200, 110)).toContain("Q 150 50");
		expect(buildVerticalBracketPath(50, 100, 50, 200)).toBe("M 50 100 V 200");
		expect(buildVerticalBracketPath(50, 100, 110, 200)).toContain("Q 50 150");
		expect(buildCenterBezierPath(100, 50, 200, 110)).toBe(
			"M 100 50 C 150 50 150 110 200 110"
		);
	});

	it("counts all recursive descendants and formats large badge counts cleanly", () => {
		expect(countDescendantNodes(null)).toBe(0);
		expect(countDescendantNodes({ id: "leaf", topic: "Leaf", children: [] })).toBe(
			0
		);
		expect(
			countDescendantNodes({
				id: "n1",
				topic: "新节点",
				children: [
					{
						id: "n2",
						topic: "烦烦烦",
						children: [
							{ id: "n3", topic: "新节点", children: [] },
							{ id: "n4", topic: "新节点", children: [] },
						],
					},
					{ id: "n5", topic: "新节点", children: [] },
				],
			})
		).toBe(4);
		expect(formatDescendantCountBadge(4)).toBe("4");
		expect(formatDescendantCountBadge(99)).toBe("99");
		expect(formatDescendantCountBadge(100)).toBe("99+");
	});

	it("flips and clamps context menu position inside the mind map container bounds", () => {
		// Near bottom edge -> flips upward so bottom items are never clipped
		const bottomFlip = computeContextMenuPosition({
			clickX: 300,
			clickY: 500,
			menuWidth: 200,
			menuHeight: 340,
			containerWidth: 800,
			containerHeight: 600,
		});
		expect(bottomFlip.top).toBe(152);
		expect(bottomFlip.top + 340).toBeLessThanOrEqual(600 - 12);
		expect(bottomFlip.left).toBe(308);

		// Middle of short container -> clamps safely inside [margin, containerHeight - menuHeight - margin]
		const clamped = computeContextMenuPosition({
			clickX: 750,
			clickY: 220,
			menuWidth: 200,
			menuHeight: 340,
			containerWidth: 800,
			containerHeight: 400,
		});
		expect(clamped.top).toBe(12);
		expect(clamped.left).toBe(542);
	});
});
