import { describe, expect, it } from "vitest";
import {
	allocateUniqueVaultPath,
	resolveDefaultVaultFolder,
} from "../vault/vaultPaths";
import {
	MindMapExportPipeline,
	getExportFormatMeta,
	type LocalSaveOutcome,
	type MindMapExportAdapter,
	type RenderedExportPayload,
	type StandaloneSvgSource,
} from "./MindMapExportPipeline";

function createExportHarness(opts?: {
	existingPaths?: string[];
	localMethod?: "picker" | "download";
	throwOnRender?: Error;
	throwOnLocalSave?: Error;
	svgSource?: Partial<StandaloneSvgSource>;
}) {
	const existing = new Set(opts?.existingPaths ?? []);
	const createdFolders: string[] = [];
	const binaryWrites = new Map<string, ArrayBuffer>();
	const textWrites = new Map<string, string>();
	const localSaves: Array<{
		payload: RenderedExportPayload;
		suggestedName: string;
		extension: string;
	}> = [];
	const rasterCalls: Array<{
		format: string;
		scale: number;
		quality: number;
	}> = [];
	const notices: string[] = [];
	const errors: Array<{ context: string; err: unknown }> = [];

	const adapter: MindMapExportAdapter<{ id: string }> = {
		renderSvgSource: async () => {
			if (opts?.throwOnRender) throw opts.throwOnRender;
			return {
				width: opts?.svgSource?.width ?? 640.4,
				height: opts?.svgSource?.height ?? 320.6,
				bgColor: opts?.svgSource?.bgColor ?? '#1e1e1e"data',
				serializedHostHtml:
					opts?.svgSource?.serializedHostHtml ?? "<div>Mind Map</div>",
			};
		},
		renderRasterBytes: async (_mind, format, options) => {
			if (opts?.throwOnRender) throw opts.throwOnRender;
			rasterCalls.push({ format, ...options });
			return new Uint8Array([1, 2, 3]).buffer;
		},
		normalizeVaultPath: (p) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
		vaultPathExists: (p) => existing.has(p),
		ensureVaultFolder: async (folderPath) => {
			createdFolders.push(folderPath);
			existing.add(folderPath);
		},
		writeVaultBinary: async (path, data) => {
			binaryWrites.set(path, data);
			existing.add(path);
		},
		writeVaultText: async (path, text) => {
			textWrites.set(path, text);
			existing.add(path);
		},
		saveLocalFile: async (
			payload,
			suggestedName,
			meta
		): Promise<LocalSaveOutcome> => {
			if (opts?.throwOnLocalSave) throw opts.throwOnLocalSave;
			localSaves.push({ payload, suggestedName, extension: meta.extension });
			return {
				method: opts?.localMethod ?? "picker",
				savedName: suggestedName,
			};
		},
		notify: (message) => {
			notices.push(message);
		},
		logError: (context, err) => {
			errors.push({ context, err });
		},
	};

	const pipeline = new MindMapExportPipeline(adapter);
	return {
		pipeline,
		createdFolders,
		binaryWrites,
		textWrites,
		localSaves,
		rasterCalls,
		notices,
		errors,
	};
}

describe("MindMapExportPipeline", () => {
	it("honors explicit vault root ('') without falling back to sourceFile's subfolder", async () => {
		const harness = createExportHarness();

		const saved = await harness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Architecture",
			sourceFolder: "Projects/MindMaps",
			format: "png",
			destination: "vault",
			vaultFolder: "",
			scale: 2,
		});

		expect(saved).toBe("Architecture.png");
		expect(harness.createdFolders).toEqual([]);
		expect(harness.binaryWrites.has("Architecture.png")).toBe(true);
		expect(harness.rasterCalls).toEqual([{ format: "png", scale: 2, quality: 1 }]);
	});

	it("falls back to sourceFolder when vaultFolder is undefined, auto-creates folders, and avoids collisions", async () => {
		const harness = createExportHarness({
			existingPaths: ["Notes/Maps/Idea.jpg", "Notes/Maps/Idea-1.jpg"],
		});

		const saved = await harness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Idea",
			sourceFolder: "Notes/Maps",
			format: "jpeg",
			destination: "vault",
			scale: 3,
		});

		expect(saved).toBe("Notes/Maps/Idea-2.jpg");
		expect(harness.createdFolders).toEqual(["Notes/Maps"]);
		expect(harness.rasterCalls).toEqual([
			{ format: "jpeg", scale: 3, quality: 0.92 },
		]);
		expect(harness.binaryWrites.has("Notes/Maps/Idea-2.jpg")).toBe(true);
	});

	it("assembles escaped standalone SVG and writes it as text to vault", async () => {
		const harness = createExportHarness();

		const saved = await harness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "My:Map?",
			format: "svg",
			destination: "vault",
			vaultFolder: "\\Exports/SVG/",
			scale: 2,
		});

		expect(saved).toBe("Exports/SVG/My-Map-.svg");
		expect(harness.createdFolders).toEqual(["Exports/SVG"]);

		const svgText = harness.textWrites.get("Exports/SVG/My-Map-.svg");
		expect(svgText).toContain('width="640" height="321"');
		expect(svgText).toContain('fill="#1e1e1e&quot;data"');
		expect(svgText).toContain("<foreignObject");
		expect(svgText).toContain("<div>Mind Map</div>");
	});

	it("dispatches local disk export via File System Access picker or download fallback", async () => {
		const pickerHarness = createExportHarness({ localMethod: "picker" });
		const pickerResult = await pickerHarness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Plan",
			format: "webp",
			destination: "local",
			scale: 2,
		});
		expect(pickerResult).toBe("Plan.webp");
		expect(pickerHarness.notices).toContain("已导出到本地：Plan.webp");

		const downloadHarness = createExportHarness({ localMethod: "download" });
		const downloadResult = await downloadHarness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Plan",
			format: "png",
			destination: "local",
			scale: 1,
		});
		expect(downloadResult).toBe("Plan.png");
		expect(downloadHarness.notices).toContain("已触发下载：Plan.png");
	});

	it("silently returns null on AbortError and reports unexpected export errors", async () => {
		const abortErr = new Error("User aborted");
		abortErr.name = "AbortError";
		const cancelHarness = createExportHarness({ throwOnLocalSave: abortErr });

		const cancelResult = await cancelHarness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Draft",
			format: "png",
			destination: "local",
			scale: 2,
		});
		expect(cancelResult).toBeNull();
		expect(cancelHarness.errors).toHaveLength(0);
		expect(cancelHarness.notices).toEqual(["正在生成 PNG 图片..."]);

		const failHarness = createExportHarness({
			throwOnRender: new Error("Canvas tainted"),
		});
		const failResult = await failHarness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Draft",
			format: "png",
			destination: "vault",
			vaultFolder: "",
			scale: 2,
		});
		expect(failResult).toBeNull();
		expect(failHarness.errors).toHaveLength(1);
		expect(failHarness.notices).toContain("导出 PNG 失败：Canvas tainted");
	});

	it("provides consistent format metadata and shared vault path helpers", () => {
		expect(getExportFormatMeta("jpeg").extension).toBe("jpg");
		expect(getExportFormatMeta("svg").isRaster).toBe(false);
		expect(resolveDefaultVaultFolder("  \\Attachments/Maps/ ", "Notes")).toBe(
			"Attachments/Maps"
		);
		expect(resolveDefaultVaultFolder("", "Notes/Sub")).toBe("Notes/Sub");

		const existing = new Set(["Maps/新建脑图.md", "Maps/新建脑图 1.md"]);
		expect(
			allocateUniqueVaultPath({
				folder: "Maps",
				baseName: "新建脑图",
				extension: "md",
				separator: " ",
				exists: (p) => existing.has(p),
			})
		).toEqual({
			filePath: "Maps/新建脑图 2.md",
			title: "新建脑图 2",
		});
	});
});
