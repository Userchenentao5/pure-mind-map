import { describe, expect, it } from "vitest";
import {
	applyImageSizePreset,
	extractNodeDisplayTitle,
	extractSearchableNodeText,
	getImageSizePreset,
	normalizeCommittedTopic,
	normalizeExternalUrlInput,
	parseNodeTopicToRichNodes,
	renderNodeMarkdown,
	serializeImageAttachment,
	serializeRichNodesToMarkdown,
	wrapMarkMarkdown,
} from "./inlineNodeContent";

describe("inlineNodeContent", () => {
	it("preserves exact document order across text, inline images, and wikilink chips", () => {
		const raw =
			"asdasdfsad![[企业微信截图_20261019133423.png]]\n[[LLM基础]]";
		const nodes = parseNodeTopicToRichNodes(raw);

		expect(nodes).toEqual([
			{ kind: "text", text: "asdasdfsad" },
			{
				kind: "image",
				imageKind: "obsidian",
				target: "企业微信截图_20261019133423.png",
				size: undefined,
				raw: "![[企业微信截图_20261019133423.png]]",
			},
			{ kind: "text", text: "\n" },
			{
				kind: "wikilink",
				target: "LLM基础",
				label: "LLM基础",
				raw: "[[LLM基础]]",
			},
		]);

		expect(normalizeCommittedTopic(serializeRichNodesToMarkdown(nodes))).toBe(
			raw
		);
	});

	it("parses inline bold, italic, strikethrough, highlight, code, and nested marks losslessly", () => {
		const raw =
			"**加粗** *斜体* ~~删除~~ ==高亮== `**literal** [[raw]]` **==重点 [[LLM基础]]==**";
		const nodes = parseNodeTopicToRichNodes(raw);

		expect(nodes).toEqual([
			{ kind: "mark", mark: "bold", children: [{ kind: "text", text: "加粗" }] },
			{ kind: "text", text: " " },
			{ kind: "mark", mark: "italic", children: [{ kind: "text", text: "斜体" }] },
			{ kind: "text", text: " " },
			{
				kind: "mark",
				mark: "strikethrough",
				children: [{ kind: "text", text: "删除" }],
			},
			{ kind: "text", text: " " },
			{
				kind: "mark",
				mark: "highlight",
				children: [{ kind: "text", text: "高亮" }],
			},
			{ kind: "text", text: " " },
			{
				kind: "mark",
				mark: "code",
				children: [{ kind: "text", text: "**literal** [[raw]]" }],
			},
			{ kind: "text", text: " " },
			{
				kind: "mark",
				mark: "bold",
				children: [
					{
						kind: "mark",
						mark: "highlight",
						children: [
							{ kind: "text", text: "重点 " },
							{
								kind: "wikilink",
								target: "LLM基础",
								label: "LLM基础",
								raw: "[[LLM基础]]",
							},
						],
					},
				],
			},
		]);

		expect(normalizeCommittedTopic(serializeRichNodesToMarkdown(nodes))).toBe(
			raw
		);
		// Inline code contents stay literal across AST, HTML, and searchable plain text
		expect(extractSearchableNodeText("`**literal**`")).toBe("**literal**");
		expect(renderNodeMarkdown("`**literal**`")).toBe(
			'<code class="mm-inline-code">**literal**</code>'
		);
	});

	it("renders wikilinks, images, inline styles, and escapes raw HTML safely from the same AST", () => {
		const raw =
			"**重点** `[[raw]]` [[目标笔记|别名]] ![[demo.png|200]] <script>alert(1)</script> #测试";
		const html = renderNodeMarkdown(raw, (target) =>
			target === "demo.png" ? "app://local/demo.png" : null
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

		expect(extractSearchableNodeText("[[目标笔记|别名]] ![[demo.png|200]]")).toBe(
			"别名 目标笔记 demo.png"
		);
		expect(extractNodeDisplayTitle("参考 [[目标笔记|别名]]")).toBe("参考 别名");
		expect(extractNodeDisplayTitle("   ", "备注")).toBe("备注");
	});

	it("keeps URL validation consistent across AST, HTML rendering, and normalization", () => {
		expect(parseNodeTopicToRichNodes("See [链接](https://)")).toEqual([
			{ kind: "text", text: "See [链接](https://)" },
		]);
		expect(renderNodeMarkdown("See [链接](https://)")).toBe(
			"See [链接](https://)"
		);
		expect(renderNodeMarkdown("[bad](javascript:alert(1))")).not.toContain(
			"<a "
		);

		expect(normalizeExternalUrlInput("example.com/docs")).toBe(
			"https://example.com/docs"
		);
		expect(normalizeExternalUrlInput("https://obsidian.md")).toBe(
			"https://obsidian.md"
		);
		expect(normalizeExternalUrlInput("javascript:alert(1)")).toBeNull();

		expect(wrapMarkMarkdown("bold", "line1\nline2")).toBe(
			"**line1**\n**line2**"
		);
		expect(wrapMarkMarkdown("code", "a\nb")).toBe("`a b`");
		expect(wrapMarkMarkdown("highlight", "")).toBe("");
	});

	it("keeps adjacent mixed styles identical across AST, HTML, and plain-text projections", () => {
		const boldThenItalic = parseNodeTopicToRichNodes("**dfadsf***asdf*");
		expect(boldThenItalic).toEqual([
			{ kind: "mark", mark: "bold", children: [{ kind: "text", text: "dfadsf" }] },
			{ kind: "mark", mark: "italic", children: [{ kind: "text", text: "asdf" }] },
		]);
		expect(serializeRichNodesToMarkdown(boldThenItalic)).toBe("**dfadsf***asdf*");
		expect(renderNodeMarkdown("**dfadsf***asdf*")).toBe(
			"<strong>dfadsf</strong><em>asdf</em>"
		);
		expect(extractSearchableNodeText("**dfadsf***asdf*")).toBe("dfadsfasdf");

		const italicThenBold = parseNodeTopicToRichNodes("*asdf***dfadsf**");
		expect(italicThenBold).toEqual([
			{ kind: "mark", mark: "italic", children: [{ kind: "text", text: "asdf" }] },
			{ kind: "mark", mark: "bold", children: [{ kind: "text", text: "dfadsf" }] },
		]);
		expect(serializeRichNodesToMarkdown(italicThenBold)).toBe("*asdf***dfadsf**");
		expect(renderNodeMarkdown("*asdf***dfadsf**")).toBe(
			"<em>asdf</em><strong>dfadsf</strong>"
		);
		expect(extractSearchableNodeText("*asdf***dfadsf**")).toBe("asdfdfadsf");

		expect(renderNodeMarkdown("***both***")).toBe(
			"<strong><em>both</em></strong>"
		);
		expect(extractSearchableNodeText("***both***==hi==~~del~~`code`")).toBe(
			"bothhidelcode"
		);
	});

	it("handles image-only nodes, markdown images, and obsidian size presets cleanly", () => {
		const raw = "![[shot.png|200]]\n![diagram](https://img.example.com/a.png)";
		const nodes = parseNodeTopicToRichNodes(raw);

		expect(nodes).toEqual([
			{
				kind: "image",
				imageKind: "obsidian",
				target: "shot.png",
				size: "200",
				raw: "![[shot.png|200]]",
			},
			{ kind: "text", text: "\n" },
			{
				kind: "image",
				imageKind: "markdown",
				target: "https://img.example.com/a.png",
				alt: "diagram",
				raw: "![diagram](https://img.example.com/a.png)",
			},
		]);

		const firstImg = nodes[0];
		if (firstImg.kind !== "image") throw new Error("Expected image");
		expect(getImageSizePreset(firstImg.size)).toBe("200");

		const resized = applyImageSizePreset(
			{ kind: firstImg.imageKind, target: firstImg.target, size: firstImg.size },
			"320"
		);
		expect(serializeImageAttachment(resized)).toBe("![[shot.png|320]]");

		const reset = applyImageSizePreset(resized, "auto");
		expect(serializeImageAttachment(reset)).toBe("![[shot.png]]");
	});
});
