import { describe, expect, it } from "vitest";
import type { NodeObj } from "mind-elixir";
import {
	extractSearchableNodeText,
	findMatchingNodes,
	stepSearchMatchIndex,
} from "./nodeSearch";

const SAMPLE_TREE: NodeObj = {
	id: "root",
	topic: "Project Plan",
	children: [
		{
			id: "b1",
			topic: "**dfadsf***asdf* [[LLM基础]]",
			children: [
				{
					id: "c1",
					topic: "参考 [[目标笔记|知识库]] 与 ![[diagram.png|200]]",
					children: [],
				},
			],
		},
		{
			id: "b2",
			topic: "==核心架构== #重要",
			expanded: false,
			children: [
				{
					id: "c2",
					topic: "Hidden Child Match",
					children: [],
				},
			],
		},
	],
};

describe("nodeSearch", () => {
	it("strips inline markdown formatting so mixed-style words remain searchable", () => {
		expect(extractSearchableNodeText("**dfadsf***asdf*")).toBe("dfadsfasdf");
		expect(extractSearchableNodeText("[[目标笔记|知识库]]")).toBe(
			"知识库 目标笔记"
		);
		expect(extractSearchableNodeText("![[shot.png|200]]")).toBe("shot.png");
		expect(extractSearchableNodeText("==高亮== `code`")).toBe("高亮 code");
	});

	it("finds matches case-insensitively across formatted text, wikilinks, images, and collapsed branches", () => {
		expect(findMatchingNodes(SAMPLE_TREE, "")).toEqual([]);
		expect(findMatchingNodes(SAMPLE_TREE, "   ")).toEqual([]);

		// Matches across adjacent bold + italic formatting
		const styled = findMatchingNodes(SAMPLE_TREE, "DFADSFASDF");
		expect(styled.map((m) => m.nodeId)).toEqual(["b1"]);
		expect(styled[0].ancestorIds).toEqual(["root"]);

		// Matches aliased wikilink and image filename
		expect(findMatchingNodes(SAMPLE_TREE, "知识库").map((m) => m.nodeId)).toEqual([
			"c1",
		]);
		expect(
			findMatchingNodes(SAMPLE_TREE, "diagram.png").map((m) => m.nodeId)
		).toEqual(["c1"]);

		// Finds nodes inside collapsed branches with full ancestor chain for auto-expand
		const collapsed = findMatchingNodes(SAMPLE_TREE, "hidden child");
		expect(collapsed).toEqual([
			{
				nodeId: "c2",
				topic: "Hidden Child Match",
				ancestorIds: ["root", "b2"],
			},
		]);
	});

	it("cycles match indices cleanly in both directions", () => {
		expect(stepSearchMatchIndex(-1, 0, 1)).toBe(-1);
		expect(stepSearchMatchIndex(-1, 3, 1)).toBe(0);
		expect(stepSearchMatchIndex(-1, 3, -1)).toBe(2);
		expect(stepSearchMatchIndex(0, 3, 1)).toBe(1);
		expect(stepSearchMatchIndex(2, 3, 1)).toBe(0);
		expect(stepSearchMatchIndex(0, 3, -1)).toBe(2);
	});
});
