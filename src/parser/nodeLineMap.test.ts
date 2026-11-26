import { describe, expect, it } from "vitest";
import { markdownToMindMap } from "./markdownParser";
import {
	findMarkdownLineForNodePath,
	findNodePathForMarkdownLine,
	findNodePathKeyById,
	resolveNodeByPathKey,
} from "./nodeLineMap";

const SAMPLE_MD = [
	"---", // 0
	"mindmap-plugin: basic", // 1
	"mindmap-direction: side", // 2
	"---", // 3
	"", // 4
	"# Project", // 5
	"", // 6
	"<!-- note comment -->", // 7
	"", // 8
	"## Branch A", // 9
	"- Item A1", // 10
	"  - Leaf A1-1", // 11
	"", // 12
	"```sh", // 13
	"# inside code", // 14
	"echo hi", // 15
	"```", // 16
	"", // 17
	"## Branch B", // 18
	"- Item B1", // 19
].join("\n");

describe("nodeLineMap", () => {
	it("maps Mind Map node paths to exact 0-based Markdown lines across frontmatter and preserved blocks", () => {
		expect(findMarkdownLineForNodePath(SAMPLE_MD, "0")).toBe(5);
		expect(findMarkdownLineForNodePath(SAMPLE_MD, "0.0")).toBe(9);
		expect(findMarkdownLineForNodePath(SAMPLE_MD, "0.0.0")).toBe(10);
		expect(findMarkdownLineForNodePath(SAMPLE_MD, "0.0.0.0")).toBe(11);
		expect(findMarkdownLineForNodePath(SAMPLE_MD, "0.1")).toBe(18);
		expect(findMarkdownLineForNodePath(SAMPLE_MD, "0.1.0")).toBe(19);
	});

	it("maps Source Mode cursor lines back to exact or nearest preceding Mind Map node path", () => {
		// Inside frontmatter -> no node
		expect(findNodePathForMarkdownLine(SAMPLE_MD, 1)).toBeNull();
		// Exact heading / list lines
		expect(findNodePathForMarkdownLine(SAMPLE_MD, 5)).toBe("0");
		expect(findNodePathForMarkdownLine(SAMPLE_MD, 9)).toBe("0.0");
		expect(findNodePathForMarkdownLine(SAMPLE_MD, 11)).toBe("0.0.0.0");
		expect(findNodePathForMarkdownLine(SAMPLE_MD, 19)).toBe("0.1.0");
		// Inside comment under # Project -> maps to root ("0")
		expect(findNodePathForMarkdownLine(SAMPLE_MD, 7)).toBe("0");
		// Inside fenced code block under Leaf A1-1 -> maps to Leaf A1-1 ("0.0.0.0")
		expect(findNodePathForMarkdownLine(SAMPLE_MD, 14)).toBe("0.0.0.0");
	});

	it("finds pathKey by live node ID and resolves pathKey with full ancestor chain", () => {
		const parsed = markdownToMindMap(SAMPLE_MD);
		const root = parsed.data.nodeData;
		const leaf = root.children![0].children![0].children![0];

		expect(findNodePathKeyById(root, leaf.id)).toBe("0.0.0.0");
		const resolved = resolveNodeByPathKey(root, "0.0.0.0");
		expect(resolved?.node.id).toBe(leaf.id);
		expect(resolved?.ancestorIds).toEqual([
			root.id,
			root.children![0].id,
			root.children![0].children![0].id,
		]);
	});
});
