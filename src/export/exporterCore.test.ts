import { describe, expect, it } from "vitest";
import {
	allocateUniqueVaultPath,
	assembleStandaloneSvg,
	escapeCdata,
	escapeXmlAttr,
	resolveExportFolder,
	shouldIncludeExportCssRule,
} from "./exporterCore";

describe("exporterCore", () => {
	it("resolves export folder with configured folder taking precedence over source folder", () => {
		expect(resolveExportFolder("Attachments/Maps/", "Notes")).toBe("Attachments/Maps");
		expect(resolveExportFolder("  ", "/Notes/Sub/")).toBe("Notes/Sub");
		expect(resolveExportFolder("", "")).toBe("");
		expect(resolveExportFolder("", null)).toBe("");
	});

	it("allocates collision-free vault paths with configurable separator", () => {
		const existing = new Set([
			"Exports/demo.png",
			"Exports/demo-1.png",
			"新建脑图.md",
			"新建脑图 1.md",
		]);

		expect(
			allocateUniqueVaultPath({
				folder: "Exports/",
				baseName: "demo",
				extension: "png",
				separator: "-",
				exists: (p) => existing.has(p),
			})
		).toEqual({
			filePath: "Exports/demo-2.png",
			title: "demo-2",
		});

		expect(
			allocateUniqueVaultPath({
				folder: "",
				baseName: "新建脑图",
				extension: "md",
				separator: " ",
				exists: (p) => existing.has(p),
			})
		).toEqual({
			filePath: "新建脑图 2.md",
			title: "新建脑图 2",
		});
	});

	it("escapes XML attributes and guards CDATA terminators safely", () => {
		expect(escapeXmlAttr(`"red" & <blue> 'x'`)).toBe(
			"&quot;red&quot; &amp; &lt;blue&gt; &apos;x&apos;"
		);
		expect(escapeCdata(`.a::after { content: "]]>"; }`)).toBe(
			`.a::after { content: "]]]]><![CDATA[>"; }`
		);
	});

	it("filters stylesheet rules relevant to mind-elixir and plugin styles", () => {
		expect(shouldIncludeExportCssRule(".map-container { color: red; }")).toBe(true);
		expect(shouldIncludeExportCssRule("me-tpc { padding: 4px; }")).toBe(true);
		expect(shouldIncludeExportCssRule(".mm-wikilink { color: purple; }")).toBe(true);
		expect(shouldIncludeExportCssRule(".workspace-leaf { display: flex; }")).toBe(false);
	});

	it("assembles valid standalone SVG with escaped theme vars and CDATA CSS", () => {
		const svg = assembleStandaloneSvg({
			width: 800,
			height: 600,
			bgColor: "#1e1e1e",
			cssVars: {
				"--bgcolor": "#1e1e1e",
				"--font": `"Inter", sans-serif`,
				"--empty": undefined,
			},
			collectedCss: `.mm-tag { content: "]]>"; }`,
			serializedHtml: `<div class="nodes">Hello</div>`,
		});

		expect(svg).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
		expect(svg).toContain(`width="800" height="600" viewBox="0 0 800 600"`);
		expect(svg).toContain(`fill="#1e1e1e"`);
		expect(svg).toContain(`--font: &quot;Inter&quot;, sans-serif;`);
		expect(svg).not.toContain(`--empty`);
		expect(svg).toContain(`<![CDATA[.mm-tag { content: "]]]]><![CDATA[>"; }]]>`);
		expect(svg).toContain(`<div class="nodes">Hello</div>`);
	});
});
