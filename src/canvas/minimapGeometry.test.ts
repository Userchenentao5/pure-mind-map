import { describe, expect, it } from "vitest";
import {
	computeMinimapLayout,
	minimapPointToPanDelta,
	type MinimapNodeInput,
	type RectLike,
} from "./minimapGeometry";

describe("minimapGeometry", () => {
	it("computes tight aspect-preserving projection and maps minimap clicks back to exact pan deltas", () => {
		const nodes: MinimapNodeInput[] = [
			{ left: 100, top: 200, width: 100, height: 40, isRoot: true, isSelected: false },
			{ left: 300, top: 100, width: 120, height: 30, isRoot: false, isSelected: true },
			{ left: 300, top: 300, width: 120, height: 30, isRoot: false, isSelected: false },
		];
		const viewRect: RectLike = { left: 50, top: 50, width: 500, height: 400 };

		const layout = computeMinimapLayout(nodes, [], viewRect, 200, 120, 10);
		expect(layout).not.toBeNull();
		if (!layout) return;

		expect(layout.nodes).toHaveLength(3);
		expect(layout.nodes[0].isRoot).toBe(true);
		expect(layout.nodes[1].isSelected).toBe(true);

		// Clicking the projected center of the root node produces the exact delta to center it in viewRect
		const rootProjected = layout.nodes[0];
		const clickX = rootProjected.x + rootProjected.w / 2;
		const clickY = rootProjected.y + rootProjected.h / 2;
		const delta = minimapPointToPanDelta(layout, viewRect, clickX, clickY);

		// View center is (300, 250); root center is (150, 220) -> delta should be (+150, +30)
		expect(delta.dx).toBeCloseTo(150, 5);
		expect(delta.dy).toBeCloseTo(30, 5);

		// Viewport box stays well-proportioned inside the minimap with surrounding breathing room
		expect(layout.viewport.width).toBeLessThan(200 * 0.65);
		expect(layout.viewport.height).toBeLessThan(120 * 0.65);
		expect(layout.viewport.left).toBeGreaterThanOrEqual(10);
		expect(layout.viewport.top).toBeGreaterThanOrEqual(10);
	});

	it("returns null when there are no visible nodes or viewport is collapsed", () => {
		expect(
			computeMinimapLayout([], [], { left: 0, top: 0, width: 500, height: 400 }, 200, 120)
		).toBeNull();
		expect(
			computeMinimapLayout(
				[{ left: 0, top: 0, width: 80, height: 30, isRoot: true, isSelected: false }],
				[],
				{ left: 0, top: 0, width: 0, height: 0 },
				200,
				120
			)
		).toBeNull();
	});
});
