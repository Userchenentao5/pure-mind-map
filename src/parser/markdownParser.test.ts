import { describe, expect, it } from "vitest";
import {
	createDefaultMindMapMarkdown,
	ensureMindMapFrontmatter,
	extractFrontmatter,
	hasMindMapFrontmatter,
	markdownToMindMap,
	mindMapToMarkdown,
	renderNodeMarkdown,
} from "./markdownParser";

describe("markdownParser", () => {
	it("extracts and detects mindmap frontmatter cleanly", () => {
		const md = `---\ntitle: Demo\nmindmap-plugin: basic\nmindmap-direction: right\n---\n\n# Root\n`;
		expect(hasMindMapFrontmatter(md)).toBe(true);

		const fm = extractFrontmatter(md);
		expect(fm.properties["title"]).toBe("Demo");
		expect(fm.properties["mindmap-plugin"]).toBe("basic");
		expect(fm.properties["mindmap-direction"]).toBe("right");
		expect(fm.body.trim()).toBe("# Root");
	});

	it("returns false when mindmap-plugin frontmatter is missing or false", () => {
		expect(hasMindMapFrontmatter("# Normal Note\n- item")).toBe(false);
		expect(hasMindMapFrontmatter("---\nmindmap-plugin: false\n---\n# Note")).toBe(false);
	});

	it("adds mindmap frontmatter while preserving existing YAML properties", () => {
		const original = `---\ntags: [work]\n---\n\n# Existing Note\n`;
		const updated = ensureMindMapFrontmatter(original, "left");
		expect(hasMindMapFrontmatter(updated)).toBe(true);
		const fm = extractFrontmatter(updated);
		expect(fm.properties["tags"]).toBe("[work]");
		expect(fm.properties["mindmap-direction"]).toBe("left");
		expect(fm.body.trim()).toBe("# Existing Note");
	});

	it("parses heading + nested bullet list markdown into a tree", () => {
		const md = `---
mindmap-plugin: basic
mindmap-direction: side
---

# 项目规划

## 设计阶段
- 需求调研 [[调研文档]]
  - 用户访谈
  - 竞品分析
- 架构评审

## 开发阶段
- 核心功能
- 联调测试
`;
		const parsed = markdownToMindMap(md);
		expect(parsed.direction).toBe("side");
		expect(parsed.data.nodeData.topic).toBe("项目规划");
		expect(parsed.data.nodeData.children).toHaveLength(2);

		const design = parsed.data.nodeData.children![0];
		expect(design.topic).toBe("设计阶段");
		expect(design.children).toHaveLength(2);
		expect(design.children![0].topic).toBe("需求调研 [[调研文档]]");
		expect(design.children![0].children).toHaveLength(2);
		expect(design.children![0].children![1].topic).toBe("竞品分析");
	});

	it("parses pure bullet list markdown and round-trips cleanly", () => {
		const md = createDefaultMindMapMarkdown("学习路线", "right", "list");
		const parsed = markdownToMindMap(md);
		expect(parsed.data.nodeData.topic).toBe("学习路线");
		expect(parsed.data.nodeData.children).toHaveLength(2);

		const serialized = mindMapToMarkdown(parsed.data, {
			existingFrontmatterRaw: parsed.frontmatter.raw,
			style: "list",
			direction: "right",
		});
		const reparsed = markdownToMindMap(serialized);
		expect(reparsed.data.nodeData.topic).toBe("学习路线");
		expect(reparsed.data.nodeData.children?.map((c) => c.topic)).toEqual([
			"分支一",
			"分支二",
		]);
		expect(reparsed.data.nodeData.children?.[0].children?.[0].topic).toBe("子节点 1");
	});

	it("round-trips heading-list style and preserves extra custom frontmatter keys", () => {
		const md = `---
author: tester
mindmap-plugin: basic
---

# 中心

## A
- A1
  - A1-1

## B
- B1
`;
		const parsed = markdownToMindMap(md);
		const out = mindMapToMarkdown(parsed.data, {
			existingFrontmatterRaw: parsed.frontmatter.raw,
			style: "heading-list",
			direction: "down",
		});
		expect(out).toContain("author: tester");
		expect(out).toContain("mindmap-direction: down");
		expect(out).toContain("# 中心");
		expect(out).toContain("## A");
		expect(out).toContain("  - A1-1");
		expect(out).not.toContain("mindmap-extra");
	});

	it("preserves arrows and summaries via trailing comment only when present", () => {
		const parsed = markdownToMindMap(createDefaultMindMapMarkdown("Root"));
		const firstId = parsed.data.nodeData.children![0].id;
		const secondId = parsed.data.nodeData.children![1].id;
		parsed.data.arrows = [
			{
				id: "arr-1",
				label: "关联",
				from: firstId,
				to: secondId,
				delta1: { x: 10, y: 10 },
				delta2: { x: -10, y: -10 },
			},
		];

		const serialized = mindMapToMarkdown(parsed.data, {
			existingFrontmatterRaw: parsed.frontmatter.raw,
			style: "heading-list",
		});
		expect(serialized).toContain("mindmap-extra");

		const reparsed = markdownToMindMap(serialized);
		expect(reparsed.data.arrows).toHaveLength(1);
		expect(reparsed.data.arrows![0].from).toBe(firstId);
		expect(reparsed.data.arrows![0].to).toBe(secondId);
	});

	it("renders wikilinks, images, inline styles, and escapes raw HTML safely", () => {
		const html = renderNodeMarkdown(
			"**重点** `[[raw]]` [[目标笔记|别名]] ![[demo.png|200]] <script>alert(1)</script> #测试",
			(target) => (target === "demo.png" ? "app://local/demo.png" : null)
		);

		expect(html).toContain("<strong>重点</strong>");
		expect(html).toContain('<code class="mm-inline-code">[[raw]]</code>');
		expect(html).toContain('class="internal-link mm-wikilink"');
		expect(html).toContain('data-href="目标笔记"');
		expect(html).toContain(">别名</a>");
		expect(html).toContain('src="app://local/demo.png"');
		expect(html).toContain('style="width:200px;height:auto"');
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain('<span class="mm-tag">#测试</span>');

		expect(renderNodeMarkdown("**dfadsf***asdf*")).toBe(
			"<strong>dfadsf</strong><em>asdf</em>"
		);
		expect(renderNodeMarkdown("*asdf***dfadsf**")).toBe(
			"<em>asdf</em><strong>dfadsf</strong>"
		);
		expect(renderNodeMarkdown("***both***")).toBe(
			"<strong><em>both</em></strong>"
		);
	});

	it("never nests H1 under a synthetic root if empty comments or text precede H1", () => {
		const md = `---
mindmap-plugin: basic
---

%%%%

# 新建脑图

## 分支一
- 子节点 1

## 分支二
- 子节点 2
`;
		const parsed = markdownToMindMap(md, "新建脑图");
		expect(parsed.data.nodeData.topic).toBe("新建脑图");
		expect(parsed.data.nodeData.children?.map((c) => c.topic)).toEqual([
			"分支一",
			"分支二",
		]);

		// Repeated round-trips must stay completely idempotent
		let current = md;
		for (let i = 0; i < 5; i++) {
			const p = markdownToMindMap(current, "新建脑图");
			current = mindMapToMarkdown(p.data, {
				existingFrontmatterRaw: p.frontmatter.raw,
				style: "heading-list",
				direction: p.direction,
			});
		}
		const finalParsed = markdownToMindMap(current, "新建脑图");
		expect(finalParsed.data.nodeData.topic).toBe("新建脑图");
		expect(finalParsed.data.nodeData.children?.map((c) => c.topic)).toEqual([
			"分支一",
			"分支二",
		]);
	});

	it("preserves standalone HTML comments, Obsidian comments, and fenced code blocks without turning them into nodes", () => {
		const md = [
			"---",
			"mindmap-plugin: basic",
			"mindmap-direction: side",
			"---",
			"",
			"<!-- preamble comment -->",
			"",
			"# Project",
			"",
			"<!--",
			"# commented heading",
			"- commented item",
			"-->",
			"",
			"```sh",
			"# explain the next line",
			"printf 'hello'",
			"```",
			"",
			"## Branch A",
			"%% obsidian note %%",
			"- Item 1",
			"  ```js",
			"  const a = 1;",
			"  ```",
			"- Item 2",
			"",
			"~~~md",
			"```sh",
			"# nested fence heading",
			"```",
			"~~~",
			"",
		].join("\n");

		const parsed = markdownToMindMap(md);
		expect(parsed.data.nodeData.topic).toBe("Project");
		expect(parsed.data.nodeData.children?.map((c) => c.topic)).toEqual(["Branch A"]);
		expect(parsed.data.nodeData.children?.[0].children?.map((c) => c.topic)).toEqual([
			"Item 1",
			"Item 2",
		]);

		parsed.data.nodeData.topic = "Project updated";
		const out = mindMapToMarkdown(parsed.data, {
			existingFrontmatterRaw: parsed.frontmatter.raw,
			style: "heading-list",
			direction: parsed.direction,
			preservedBlocks: parsed.preservedBlocks,
		});
		expect(out).toBe(md.replace("# Project", "# Project updated"));

		// Round-tripping again stays idempotent
		const reparsed = markdownToMindMap(out);
		const out2 = mindMapToMarkdown(reparsed.data, {
			existingFrontmatterRaw: reparsed.frontmatter.raw,
			style: "heading-list",
			direction: reparsed.direction,
			preservedBlocks: reparsed.preservedBlocks,
		});
		expect(out2).toBe(out);
	});

	it("does not mistake headings inside fenced code blocks for heading mode in pure list notes", () => {
		const md = [
			"---",
			"mindmap-plugin: basic",
			"mindmap-direction: right",
			"---",
			"",
			"- Root",
			"",
			"<!-- list comment -->",
			"",
			"```sh",
			"# not a markdown heading",
			"echo ok",
			"```",
			"",
			"  - Child 1",
			"",
		].join("\n");

		const parsed = markdownToMindMap(md);
		expect(parsed.data.nodeData.topic).toBe("Root");
		expect(parsed.data.nodeData.children?.map((c) => c.topic)).toEqual(["Child 1"]);

		parsed.data.nodeData.topic = "Root updated";
		const out = mindMapToMarkdown(parsed.data, {
			existingFrontmatterRaw: parsed.frontmatter.raw,
			style: "list",
			direction: parsed.direction,
			preservedBlocks: parsed.preservedBlocks,
		});
		expect(out).toBe(md.replace("- Root", "- Root updated"));
	});

	it("keeps preserved blocks aligned when saved nodeIds and mindmap-extra are present, and retains blocks if anchor node is deleted", () => {
		const base = markdownToMindMap(
			[
				"---",
				"mindmap-plugin: basic",
				"mindmap-direction: side",
				"---",
				"",
				"# Root",
				"",
				"## Branch A",
				"- Leaf A",
				"",
				"<!-- keep me -->",
				"",
				"## Branch B",
				"",
			].join("\n")
		);

		const branchA = base.data.nodeData.children![0];
		const branchB = base.data.nodeData.children![1];
		base.data.arrows = [
			{
				id: "arr-1",
				label: "rel",
				from: branchA.id,
				to: branchB.id,
				delta1: { x: 0, y: 0 },
				delta2: { x: 0, y: 0 },
			},
		];

		const withExtra = mindMapToMarkdown(base.data, {
			existingFrontmatterRaw: base.frontmatter.raw,
			style: "heading-list",
			direction: base.direction,
			preservedBlocks: base.preservedBlocks,
		});
		expect(withExtra).toContain("<!-- keep me -->");
		expect(withExtra).toContain("<!-- mindmap-extra:");

		// Re-parse with mindmap-extra nodeIds applied, then delete Leaf A: comment must still be preserved under surviving ancestor
		const reparsed = markdownToMindMap(withExtra);
		reparsed.data.nodeData.children![0].children = [];
		const afterDelete = mindMapToMarkdown(reparsed.data, {
			existingFrontmatterRaw: reparsed.frontmatter.raw,
			style: "heading-list",
			direction: reparsed.direction,
			preservedBlocks: reparsed.preservedBlocks,
		});
		expect(afterDelete).toContain("<!-- keep me -->");
		expect(afterDelete).toContain("## Branch A");
		expect(afterDelete).toContain("## Branch B");
	});
});
