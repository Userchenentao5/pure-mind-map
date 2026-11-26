import { describe, expect, it } from "vitest";
import type { MindElixirData } from "mind-elixir";
import {
	MarkdownLineIndexCache,
	MindMapDocument,
	findNodePathKeyById,
	resolveNodeByPathKey,
} from "./MindMapDocument";

describe("MindMapDocument", () => {
	it("reconciles mount, refresh, and echo-skipping noop transitions with direction precedence", () => {
		const doc = new MindMapDocument("side");

		// 1. No mindmap-direction in frontmatter -> falls back to defaultDirection ("right")
		const mdWithoutDir = "---\nmindmap-plugin: basic\ntags: [work]\n---\n\n# Plan\n\n## Step 1\n";
		const first = doc.reconcileExternalMarkdown(mdWithoutDir, {
			fallbackTitle: "Fallback",
			defaultDirection: "right",
			clear: true,
			hasCanvas: false,
		});
		expect(first.action).toBe("mount");
		if (first.action !== "noop") {
			expect(first.direction).toBe("right");
			expect(first.data.direction).toBe(1);
			expect(first.data.nodeData.topic).toBe("Plan");
		}

		// 2. Same markdown while canvas is mounted -> noop (skip redundant re-render)
		const echo = doc.reconcileExternalMarkdown(mdWithoutDir, {
			fallbackTitle: "Fallback",
			defaultDirection: "right",
			clear: false,
			hasCanvas: true,
		});
		expect(echo.action).toBe("noop");

		// 3. Explicit mindmap-direction in frontmatter overrides defaultDirection -> refresh
		const mdWithDir =
			"---\nmindmap-plugin: basic\nmindmap-direction: down\ntags: [work]\n---\n\n# Plan\n\n## Step 2\n";
		const updated = doc.reconcileExternalMarkdown(mdWithDir, {
			fallbackTitle: "Fallback",
			defaultDirection: "right",
			clear: false,
			hasCanvas: true,
		});
		expect(updated.action).toBe("refresh");
		if (updated.action !== "noop") {
			expect(updated.direction).toBe("down");
			expect(updated.data.direction).toBe(3);
		}
		expect(doc.direction).toBe("down");
	});

	it("preserves raw Source Mode Markdown when untouched and does not clear dirty state on pure serialize() reads", () => {
		const doc = new MindMapDocument("side");
		const rawSource =
			"---\nmindmap-plugin: basic\nauthor: Alice\n---\n\n\n# Custom Spacing\n\n## Branch A\n- Leaf\n";

		const mounted = doc.reconcileExternalMarkdown(rawSource, {
			fallbackTitle: "Doc",
			defaultDirection: "side",
			clear: true,
			hasCanvas: false,
		});
		expect(mounted.action).toBe("mount");
		if (mounted.action === "noop") {
			throw new Error("Expected mount decision");
		}

		// Untouched canvas preserves exact raw Markdown formatting
		expect(doc.hasPendingLocalEdits()).toBe(false);
		expect(doc.serialize(mounted.data, "heading-list")).toBe(rawSource);

		// Local edit marks document dirty; pure serialize() MUST NOT clear hasPendingLocalEdits()
		const editedData: MindElixirData = {
			...mounted.data,
			nodeData: {
				...mounted.data.nodeData,
				topic: "Edited Root",
			},
		};
		doc.markLocalEdit();
		doc.setDirection("left");

		const serialized = doc.serialize(editedData, "heading-list");
		expect(serialized).toContain("author: Alice");
		expect(serialized).toContain("mindmap-direction: left");
		expect(serialized).toContain("# Edited Root");
		expect(doc.hasPendingLocalEdits()).toBe(true);

		// Recording save-in-flight suppresses echo re-renders while preserving dirty until markSaved()
		doc.markSaveInFlight(serialized);
		expect(doc.hasPendingLocalEdits()).toBe(true);

		// Confirmed save clears dirty state and subsequent identical setViewData is a noop
		doc.markSaved(serialized);
		expect(doc.hasPendingLocalEdits()).toBe(false);
		expect(
			doc.reconcileExternalMarkdown(serialized, {
				fallbackTitle: "Doc",
				defaultDirection: "side",
				clear: false,
				hasCanvas: true,
			}).action
		).toBe("noop");
	});

	it("resets frontmatter, direction, and dirty state on clear()", () => {
		const doc = new MindMapDocument("side");
		doc.reconcileExternalMarkdown("---\nmindmap-plugin: basic\nmindmap-direction: down\n---\n\n# A\n", {
			fallbackTitle: "A",
			defaultDirection: "side",
			clear: true,
			hasCanvas: false,
		});
		doc.markLocalEdit();
		expect(doc.direction).toBe("down");
		expect(doc.hasPendingLocalEdits()).toBe(true);

		doc.clear("right");
		expect(doc.direction).toBe("right");
		expect(doc.hasPendingLocalEdits()).toBe(false);
		expect(doc.lastSyncedMarkdown).toBe("");
		expect(doc.serialize(null, "heading-list", "fallback")).toBe("fallback");
	});

	it("preserves standalone HTML comments and fenced code blocks verbatim after editing root title", () => {
		const doc = new MindMapDocument("side");
		const original = [
			"---",
			"mindmap-plugin: basic",
			"mindmap-direction: side",
			"---",
			"",
			"# Project",
			"",
			"<!-- sample note comment -->",
			"",
			"```sh",
			"# explain the next line",
			"printf 'hello'",
			"```",
			"",
		].join("\n");

		const mounted = doc.reconcileExternalMarkdown(original, {
			fallbackTitle: "Project",
			defaultDirection: "side",
			clear: true,
			hasCanvas: false,
		});
		expect(mounted.action).toBe("mount");
		if (mounted.action === "noop") {
			throw new Error("Expected mount decision");
		}

		expect(mounted.data.nodeData.topic).toBe("Project");
		expect(mounted.data.nodeData.children).toEqual([]);
		expect(doc.serialize(mounted.data, "heading-list")).toBe(original);

		mounted.data.nodeData.topic = "Project updated";
		doc.markLocalEdit();

		const expected = original.replace("# Project", "# Project updated");
		const firstSaved = doc.serialize(mounted.data, "heading-list");
		expect(firstSaved).toBe(expected);

		// Confirm save + echo reconcile + subsequent edit keeps preserving comment and code block
		doc.markSaved(firstSaved);
		expect(
			doc.reconcileExternalMarkdown(firstSaved, {
				fallbackTitle: "Project",
				defaultDirection: "side",
				clear: false,
				hasCanvas: true,
			}).action
		).toBe("noop");

		mounted.data.nodeData.topic = "Project v2";
		doc.markLocalEdit();
		expect(doc.serialize(mounted.data, "heading-list")).toBe(
			original.replace("# Project", "# Project v2")
		);
	});

	it("tracks mindmap-style frontmatter precedence and persists explicit style preset changes", () => {
		const doc = new MindMapDocument("side", "classic");
		const mdNoStyle = "---\nmindmap-plugin: basic\nmindmap-direction: right\n---\n\n# Plan\n";

		const mounted = doc.reconcileExternalMarkdown(mdNoStyle, {
			fallbackTitle: "Plan",
			defaultDirection: "side",
			defaultStylePreset: "card",
			clear: true,
			hasCanvas: false,
		});
		expect(mounted.action).toBe("mount");
		if (mounted.action === "noop") throw new Error("Expected mount");
		expect(mounted.stylePreset).toBe("card");
		expect(doc.hasExplicitStyleInNote()).toBe(false);

		// Explicit style switch writes mindmap-style to frontmatter
		doc.setStylePreset("bordered", true);
		doc.markLocalEdit();
		const serialized = doc.serialize(mounted.data, "heading-list");
		expect(serialized).toContain("mindmap-style: bordered");

		// Reconciling a note with explicit mindmap-style overrides defaultStylePreset
		const reloaded = doc.reconcileExternalMarkdown(serialized, {
			fallbackTitle: "Plan",
			defaultDirection: "side",
			defaultStylePreset: "classic",
			clear: true,
			hasCanvas: false,
		});
		expect(reloaded.action).toBe("mount");
		if (reloaded.action === "noop") throw new Error("Expected mount");
		expect(reloaded.stylePreset).toBe("bordered");
		expect(doc.hasExplicitStyleInNote()).toBe(true);
	});

	it("indexes Node lines across frontmatter, comments, notes, and code blocks, and caches Split View lookups", () => {
		const sampleMd = [
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
			"  > Note line under A1", // 11
			"  - Leaf A1-1", // 12
			"", // 13
			"```sh", // 14
			"# inside code", // 15
			"echo hi", // 16
			"```", // 17
			"", // 18
			"## Branch B", // 19
			"- Item B1", // 20
		].join("\n");

		const doc = new MindMapDocument("side");
		const mounted = doc.reconcileExternalMarkdown(sampleMd, {
			fallbackTitle: "Project",
			defaultDirection: "side",
			clear: true,
			hasCanvas: false,
		});
		if (mounted.action === "noop") throw new Error("Expected mount");

		// Direct cached lookup on MindMapDocument
		expect(doc.findLineForNodePath("0")).toBe(5);
		expect(doc.findLineForNodePath("0.0")).toBe(9);
		expect(doc.findLineForNodePath("0.0.0")).toBe(10);
		expect(doc.findLineForNodePath("0.0.0.0")).toBe(12);
		expect(doc.findLineForNodePath("0.1")).toBe(19);
		expect(doc.findLineForNodePath("0.1.0")).toBe(20);

		expect(doc.findNodePathForLine(1)).toBeNull();
		expect(doc.findNodePathForLine(7)).toBe("0");
		expect(doc.findNodePathForLine(11)).toBe("0.0.0");
		expect(doc.findNodePathForLine(15)).toBe("0.0.0.0");

		// Live tree pathKey & ancestor resolution
		const root = mounted.data.nodeData;
		const leaf = root.children![0].children![0].children![0];
		expect(findNodePathKeyById(root, leaf.id)).toBe("0.0.0.0");
		const resolved = resolveNodeByPathKey(root, "0.0.0.0");
		expect(resolved?.node.id).toBe(leaf.id);
		expect(resolved?.ancestorIds).toEqual([
			root.id,
			root.children![0].id,
			root.children![0].children![0].id,
		]);

		// MarkdownLineIndexCache returns the same index reference on unchanged Markdown
		const cache = new MarkdownLineIndexCache();
		const firstIdx = cache.getLineIndex("maps/a.md", sampleMd);
		const secondIdx = cache.getLineIndex("maps/a.md", sampleMd);
		expect(secondIdx).toBe(firstIdx);
		expect(cache.findLineForNodePath("maps/a.md", sampleMd, "0.1.0")).toBe(20);
		expect(cache.findNodePathForLine("maps/a.md", sampleMd, 11)).toBe("0.0.0");
	});
});
