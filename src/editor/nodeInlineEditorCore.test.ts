import { describe, expect, it } from "vitest";
import {
	cycleSelectionIndex,
	findLinkTrigger,
	formatEmbedLink,
	formatWikiLink,
	getSuggesterFooterText,
	isEmbeddableExtension,
	isImageExtension,
	rankLinkCandidates,
	replaceTextRange,
	wrapExternalLink,
	wrapTextSelection,
	type FuzzyScorer,
	type LinkCandidate,
} from "./nodeInlineEditorCore";

const simpleScorer: FuzzyScorer = (query) => {
	const needle = query.toLowerCase();
	return (text) => {
		const idx = text.toLowerCase().indexOf(needle);
		if (idx === -1) return null;
		return { score: 100 - idx - (text.length - needle.length) };
	};
};

describe("nodeInlineEditorCore", () => {
	it("detects [[ and ![[ triggers and consumes existing closing ]]", () => {
		expect(findLinkTrigger("参考 [[LLM", 8)).toEqual({
			isEmbed: false,
			start: 3,
			end: 8,
			query: "LLM",
		});

		// Caret placed inside auto-closed [[]]
		expect(findLinkTrigger("[[]]", 2)).toEqual({
			isEmbed: false,
			start: 0,
			end: 4,
			query: "",
		});

		// Image embed trigger ![[demo]]
		expect(findLinkTrigger("图示 ![[demo]]", 10)).toEqual({
			isEmbed: true,
			start: 3,
			end: 12,
			query: "demo",
		});

		// Does not trigger after pipe alias or closed brackets
		expect(findLinkTrigger("[[Note|Alias", 12)).toBeNull();
		expect(findLinkTrigger("[[Note]] text", 13)).toBeNull();
	});

	it("ranks candidates by mtime when empty and prioritizes basename matches when querying", () => {
		const files: LinkCandidate[] = [
			{ path: "a/old.md", basename: "old", name: "old.md", extension: "md", folderPath: "a/", mtime: 10 },
			{ path: "b/LLM基础.md", basename: "LLM基础", name: "LLM基础.md", extension: "md", folderPath: "b/", mtime: 50 },
			{ path: "LLM/notes.md", basename: "notes", name: "notes.md", extension: "md", folderPath: "LLM/", mtime: 90 },
			{ path: "assets/diagram.png", basename: "diagram", name: "diagram.png", extension: "png", folderPath: "assets/", mtime: 100 },
			{ path: "docs/archive.pdf", basename: "archive", name: "archive.pdf", extension: "pdf", folderPath: "docs/", mtime: 200 },
		];

		// Wikilink mode: markdown only, sorted by mtime desc when query is empty
		const recentNotes = rankLinkCandidates(files, "", false, simpleScorer);
		expect(recentNotes.map((f) => f.basename)).toEqual(["notes", "LLM基础", "old"]);

		// Embed mode: includes images + markdown, excludes non-embeddable pdf
		const embedCandidates = rankLinkCandidates(files, "", true, simpleScorer);
		expect(embedCandidates.map((f) => f.name)).toEqual([
			"diagram.png",
			"notes.md",
			"LLM基础.md",
			"old.md",
		]);

		// Querying "LLM" ranks basename match ("LLM基础") ahead of folder-only match ("LLM/notes.md")
		const matched = rankLinkCandidates(files, "LLM", false, simpleScorer);
		expect(matched.map((f) => f.basename)).toEqual(["LLM基础", "notes"]);
	});

	it("enforces canonical wikilink and embed formats regardless of global markdown link settings", () => {
		expect(formatWikiLink("[[LLM基础]]", "LLM基础")).toBe("[[LLM基础]]");
		expect(formatWikiLink("[[项目/LLM基础|LLM基础]]", "LLM基础")).toBe("[[项目/LLM基础|LLM基础]]");
		expect(formatWikiLink("[LLM基础](LLM基础.md)", "LLM基础")).toBe("[[LLM基础]]");

		expect(formatEmbedLink("diagram.png", "diagram", "png")).toBe("![[diagram.png]]");
		expect(formatEmbedLink("LLM基础.md", "LLM基础", "md")).toBe("![[LLM基础]]");
	});

	it("wraps selected text or inserts placeholder with accurate caret range", () => {
		expect(wrapTextSelection("hello world", 6, 11, "**", "**", "加粗文本")).toEqual({
			text: "hello **world**",
			caretStart: 8,
			caretEnd: 13,
		});

		expect(wrapTextSelection("hello ", 6, 6, "`", "`", "code")).toEqual({
			text: "hello `code`",
			caretStart: 7,
			caretEnd: 11,
		});
	});

	it("wraps external links with caret targeting the URL slot", () => {
		const res = wrapExternalLink("查看文档", 2, 4);
		expect(res.text).toBe("查看[文档](https://)");
		expect(res.text.slice(res.caretStart, res.caretEnd)).toBe("https://");

		const emptyRes = wrapExternalLink("", 0, 0);
		expect(emptyRes.text).toBe("[链接](https://)");
		expect(emptyRes.text.slice(emptyRes.caretStart, emptyRes.caretEnd)).toBe("https://");
	});

	it("replaces text ranges, cycles indices, checks extensions, and updates footer text", () => {
		expect(replaceTextRange("节点 [[]]", 3, 7, "[[基础]]")).toEqual({
			text: "节点 [[基础]]",
			caretStart: 9,
			caretEnd: 9,
		});

		expect(cycleSelectionIndex(0, 3, -1)).toBe(2);
		expect(cycleSelectionIndex(2, 3, 1)).toBe(0);
		expect(cycleSelectionIndex(0, 0, 1)).toBe(0);

		expect(isImageExtension("PNG")).toBe(true);
		expect(isImageExtension("md")).toBe(false);
		expect(isEmbeddableExtension("md")).toBe(true);
		expect(isEmbeddableExtension("webp")).toBe(true);
		expect(isEmbeddableExtension("zip")).toBe(false);

		expect(getSuggesterFooterText(false)).toContain("双链");
		expect(getSuggesterFooterText(true)).toContain("嵌入");
	});
});
