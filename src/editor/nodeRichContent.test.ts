import { describe, expect, it } from "vitest";
import {
	applyImageSizePreset,
	getImageSizePreset,
	normalizeCommittedTopic,
	normalizeExternalUrlInput,
	parseNodeTopicToRichNodes,
	serializeImageAttachment,
	serializeRichNodesToMarkdown,
	wrapMarkMarkdown,
} from "./nodeRichContent";

describe("nodeRichContent", () => {
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
	});

	it("parses aliased wikilinks, external links, tags, and normalizes external URLs", () => {
		const raw =
			"参考 [[目标笔记|别名]] 与 [文档](https://example.com) #核心";
		const nodes = parseNodeTopicToRichNodes(raw);

		expect(nodes).toEqual([
			{ kind: "text", text: "参考 " },
			{
				kind: "wikilink",
				target: "目标笔记",
				label: "别名",
				raw: "[[目标笔记|别名]]",
			},
			{ kind: "text", text: " 与 " },
			{
				kind: "extlink",
				label: "文档",
				url: "https://example.com",
				raw: "[文档](https://example.com)",
			},
			{ kind: "text", text: " " },
			{ kind: "tag", tag: "核心", raw: "#核心" },
		]);

		expect(normalizeCommittedTopic(serializeRichNodesToMarkdown(nodes))).toBe(
			raw
		);
		expect(normalizeExternalUrlInput("example.com/docs")).toBe(
			"https://example.com/docs"
		);
		expect(normalizeExternalUrlInput("https://obsidian.md")).toBe(
			"https://obsidian.md"
		);
		expect(normalizeExternalUrlInput("javascript:alert(1)")).toBeNull();
	});

	it("keeps incomplete external link placeholders editable and wraps multi-line marks per line", () => {
		const nodes = parseNodeTopicToRichNodes("See [链接](https://)");
		expect(nodes).toEqual([{ kind: "text", text: "See [链接](https://)" }]);

		expect(wrapMarkMarkdown("bold", "line1\nline2")).toBe(
			"**line1**\n**line2**"
		);
		expect(wrapMarkMarkdown("code", "a\nb")).toBe("`a b`");
		expect(wrapMarkMarkdown("highlight", "")).toBe("");
	});

	it("parses adjacent mixed styles on the same line without leaking asterisks or delimiters", () => {
		// **dfadsf***asdf* (bold immediately followed by italic)
		const boldThenItalic = parseNodeTopicToRichNodes("**dfadsf***asdf*");
		expect(boldThenItalic).toEqual([
			{ kind: "mark", mark: "bold", children: [{ kind: "text", text: "dfadsf" }] },
			{ kind: "mark", mark: "italic", children: [{ kind: "text", text: "asdf" }] },
		]);
		expect(serializeRichNodesToMarkdown(boldThenItalic)).toBe("**dfadsf***asdf*");

		// *asdf***dfadsf** (italic immediately followed by bold)
		const italicThenBold = parseNodeTopicToRichNodes("*asdf***dfadsf**");
		expect(italicThenBold).toEqual([
			{ kind: "mark", mark: "italic", children: [{ kind: "text", text: "asdf" }] },
			{ kind: "mark", mark: "bold", children: [{ kind: "text", text: "dfadsf" }] },
		]);
		expect(serializeRichNodesToMarkdown(italicThenBold)).toBe("*asdf***dfadsf**");

		// ***both*** (bold + italic on same span) and chained adjacent marks
		const tripleAndAdjacent = parseNodeTopicToRichNodes(
			"***both***==hi==~~del~~`code`"
		);
		expect(tripleAndAdjacent).toEqual([
			{
				kind: "mark",
				mark: "bold",
				children: [
					{
						kind: "mark",
						mark: "italic",
						children: [{ kind: "text", text: "both" }],
					},
				],
			},
			{ kind: "mark", mark: "highlight", children: [{ kind: "text", text: "hi" }] },
			{
				kind: "mark",
				mark: "strikethrough",
				children: [{ kind: "text", text: "del" }],
			},
			{ kind: "mark", mark: "code", children: [{ kind: "text", text: "code" }] },
		]);
		expect(serializeRichNodesToMarkdown(tripleAndAdjacent)).toBe(
			"***both***==hi==~~del~~`code`"
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
