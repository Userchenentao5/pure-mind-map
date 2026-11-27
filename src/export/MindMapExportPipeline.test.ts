import { describe, expect, it, vi } from "vitest";
import {
	allocateUniqueVaultPath,
	resolveDefaultVaultFolder,
} from "../vault/vaultPaths";
import {
	MindMapExportPipeline,
	getExportFormatMeta,
	type ExportFormat,
	type LocalSaveOutcome,
	type MindMapExportAdapter,
	type RenderedExportPayload,
	type RenderedRasterBlob,
	type StandaloneSvgSource,
} from "./MindMapExportPipeline";

const PNG_SIGNATURE = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const WEBP_SIGNATURE = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function createExportHarness(opts?: {
	existingPaths?: string[];
	localMethod?: "picker" | "download";
	throwOnRender?: Error;
	throwOnLocalSave?: Error;
	svgSource?: Partial<StandaloneSvgSource>;
	rasterBlobFactory?: (
		format: Exclude<ExportFormat, "svg">,
		options: { scale: number; quality: number }
	) => RenderedRasterBlob;
}) {
	const existing = new Set(opts?.existingPaths ?? []);
	const createdFolders: string[] = [];
	const binaryWrites = new Map<string, ArrayBuffer>();
	const textWrites = new Map<string, string>();
	const localSaves: Array<{
		payload: RenderedExportPayload;
		suggestedName: string;
		extension: string;
		mimeType: string;
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
		renderRasterBlob: async (_mind, format, options) => {
			if (opts?.throwOnRender) throw opts.throwOnRender;
			rasterCalls.push({ format, ...options });
			if (opts?.rasterBlobFactory) {
				return opts.rasterBlobFactory(format, options);
			}
			return new Blob([new Uint8Array([1, 2, 3])], {
				type: getExportFormatMeta(format).mimeType,
			});
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
			localSaves.push({
				payload,
				suggestedName,
				extension: meta.extension,
				mimeType: meta.mimeType,
			});
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

	it("aborts WebP vault and local exports before reading bytes when canvas falls back to PNG", async () => {
		const readBytesVault = vi.fn(async () => PNG_SIGNATURE.slice().buffer);
		const vaultHarness = createExportHarness({
			rasterBlobFactory: () => ({
				type: "image/png",
				arrayBuffer: readBytesVault,
			}),
		});

		const vaultResult = await vaultHarness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "mind-map",
			format: "webp",
			destination: "vault",
			vaultFolder: "Exports",
			scale: 2,
		});

		expect(vaultResult).toBeNull();
		expect(readBytesVault).not.toHaveBeenCalled();
		expect(vaultHarness.createdFolders).toEqual([]);
		expect(vaultHarness.binaryWrites.size).toBe(0);
		expect(vaultHarness.textWrites.size).toBe(0);
		expect(vaultHarness.errors).toHaveLength(0);
		expect(vaultHarness.notices).toEqual([
			"正在生成 WEBP 图片...",
			"当前环境不支持 WebP 编码，请改用 PNG",
		]);

		const readBytesLocal = vi.fn(async () => PNG_SIGNATURE.slice().buffer);
		const localHarness = createExportHarness({
			localMethod: "picker",
			rasterBlobFactory: () => ({
				type: "image/png",
				arrayBuffer: readBytesLocal,
			}),
		});

		const localResult = await localHarness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "mind-map",
			format: "webp",
			destination: "local",
			scale: 2,
		});

		expect(localResult).toBeNull();
		expect(readBytesLocal).not.toHaveBeenCalled();
		expect(localHarness.localSaves).toHaveLength(0);
		expect(localHarness.binaryWrites.size).toBe(0);
		expect(localHarness.errors).toHaveLength(0);
		expect(localHarness.notices).toEqual([
			"正在生成 WEBP 图片...",
			"当前环境不支持 WebP 编码，请改用 PNG",
		]);
	});

	it("rejects empty or mismatched MIME types and guides JPEG fallback to PNG", async () => {
		const readBytesEmpty = vi.fn(async () => PNG_SIGNATURE.slice().buffer);
		const emptyTypeHarness = createExportHarness({
			rasterBlobFactory: () => ({
				type: "",
				arrayBuffer: readBytesEmpty,
			}),
		});

		const emptyResult = await emptyTypeHarness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "mind-map",
			format: "webp",
			destination: "vault",
			vaultFolder: "",
			scale: 2,
		});
		expect(emptyResult).toBeNull();
		expect(readBytesEmpty).not.toHaveBeenCalled();
		expect(emptyTypeHarness.notices).toContain(
			"当前环境不支持 WebP 编码，请改用 PNG"
		);

		const readBytesJpeg = vi.fn(async () => PNG_SIGNATURE.slice().buffer);
		const jpegFallbackHarness = createExportHarness({
			rasterBlobFactory: () => ({
				type: "image/png",
				arrayBuffer: readBytesJpeg,
			}),
		});

		const jpegResult = await jpegFallbackHarness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "mind-map",
			format: "jpeg",
			destination: "local",
			scale: 2,
		});
		expect(jpegResult).toBeNull();
		expect(readBytesJpeg).not.toHaveBeenCalled();
		expect(jpegFallbackHarness.localSaves).toHaveLength(0);
		expect(jpegFallbackHarness.notices).toContain(
			"当前环境不支持 JPEG 编码，请改用 PNG"
		);
	});

	it("saves matching PNG and WebP blobs with their requested format, extension, and bytes", async () => {
		const harness = createExportHarness({
			localMethod: "picker",
			rasterBlobFactory: (format) =>
				format === "webp"
					? new Blob([WEBP_SIGNATURE], { type: "IMAGE/WEBP; charset=binary" })
					: new Blob([PNG_SIGNATURE], { type: "image/png" }),
		});

		const vaultPng = await harness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Map",
			format: "png",
			destination: "vault",
			vaultFolder: "",
			scale: 2,
		});
		const vaultWebp = await harness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Map",
			format: "webp",
			destination: "vault",
			vaultFolder: "",
			scale: 2,
		});
		const localPng = await harness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Map",
			format: "png",
			destination: "local",
			scale: 2,
		});
		const localWebp = await harness.pipeline.exportMindMap({
			mind: { id: "m1" },
			sourceBasename: "Map",
			format: "webp",
			destination: "local",
			scale: 2,
		});

		expect(vaultPng).toBe("Map.png");
		expect(vaultWebp).toBe("Map.webp");
		expect(localPng).toBe("Map.png");
		expect(localWebp).toBe("Map.webp");

		expect(new Uint8Array(harness.binaryWrites.get("Map.png")!)).toEqual(
			PNG_SIGNATURE
		);
		expect(new Uint8Array(harness.binaryWrites.get("Map.webp")!)).toEqual(
			WEBP_SIGNATURE
		);

		expect(harness.localSaves).toHaveLength(2);
		expect(harness.localSaves[0].suggestedName).toBe("Map.png");
		expect(harness.localSaves[0].extension).toBe("png");
		expect(harness.localSaves[0].mimeType).toBe("image/png");
		expect(harness.localSaves[0].payload.kind).toBe("raster");
		if (harness.localSaves[0].payload.kind === "raster") {
			expect(harness.localSaves[0].payload.mimeType).toBe("image/png");
			expect(new Uint8Array(harness.localSaves[0].payload.data)).toEqual(
				PNG_SIGNATURE
			);
		}

		expect(harness.localSaves[1].suggestedName).toBe("Map.webp");
		expect(harness.localSaves[1].extension).toBe("webp");
		expect(harness.localSaves[1].mimeType).toBe("image/webp");
		expect(harness.localSaves[1].payload.kind).toBe("raster");
		if (harness.localSaves[1].payload.kind === "raster") {
			expect(harness.localSaves[1].payload.mimeType).toBe("image/webp");
			expect(new Uint8Array(harness.localSaves[1].payload.data)).toEqual(
				WEBP_SIGNATURE
			);
		}
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
