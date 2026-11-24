import { describe, expect, it } from "vitest";
import {
	EXPORT_COMPUTED_STYLE_PROPS,
	allocateUniqueVaultPath,
	assembleStandaloneSvg,
	escapeXmlAttr,
	getExportFormatMeta,
	resolveExportFolder,
	sanitizeExportBaseName,
} from "./exporterCore";

describe("exporterCore", () => {
	it("resolves export folder with configured folder taking precedence over source folder", () => {
		expect(resolveExportFolder("Attachments/Maps/", "Notes")).toBe("Attachments/Maps");
		expect(resolveExportFolder("  ", "/Notes/Sub/")).toBe("Notes/Sub");
		expect(resolveExportFolder("", "")).toBe("");
		expect(resolveExportFolder("", null)).toBe("");
	});

	it("sanitizes unsafe filename characters and falls back cleanly", () => {
		expect(sanitizeExportBaseName('  my:map/2026?*  ')).toBe("my-map-2026-");
		expect(sanitizeExportBaseName("   ", "fallback")).toBe("fallback");
	});

	it("returns accurate format metadata for png, svg, jpeg, and webp", () => {
		expect(getExportFormatMeta("png")).toMatchObject({
			extension: "png",
			mimeType: "image/png",
			isRaster: true,
		});
		expect(getExportFormatMeta("svg")).toMatchObject({
			extension: "svg",
			mimeType: "image/svg+xml",
			isRaster: false,
		});
		expect(getExportFormatMeta("jpeg")).toMatchObject({
			extension: "jpg",
			mimeType: "image/jpeg",
			isRaster: true,
		});
		expect(getExportFormatMeta("webp")).toMatchObject({
			extension: "webp",
			mimeType: "image/webp",
			isRaster: true,
		});
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

	it("escapes XML attributes and includes critical layout style properties", () => {
		expect(escapeXmlAttr(`"red" & <blue> 'x'`)).toBe(
			"&quot;red&quot; &amp; &lt;blue&gt; &apos;x&apos;"
		);
		expect(EXPORT_COMPUTED_STYLE_PROPS).toContain("display");
		expect(EXPORT_COMPUTED_STYLE_PROPS).toContain("flex-direction");
		expect(EXPORT_COMPUTED_STYLE_PROPS).toContain("stroke-dasharray");
	});

	it("assembles valid standalone SVG around the computed-style inlined host HTML", () => {
		const svg = assembleStandaloneSvg({
			width: 800.4,
			height: 600.6,
			bgColor: "#1e1e1e",
			serializedHostHtml: `<div xmlns="http://www.w3.org/1999/xhtml">Hello</div>`,
		});

		expect(svg).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
		expect(svg).toContain(`width="800" height="601" viewBox="0 0 800 601"`);
		expect(svg).toContain(`fill="#1e1e1e"`);
		expect(svg).toContain(`<foreignObject x="0" y="0" width="800" height="601">`);
		expect(svg).toContain(`<div xmlns="http://www.w3.org/1999/xhtml">Hello</div>`);
	});
});
