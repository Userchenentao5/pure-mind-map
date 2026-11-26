import { describe, expect, it } from "vitest";
import type { MindElixirData } from "mind-elixir";
import { MindMapDocument } from "./MindMapDocument";

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
});
