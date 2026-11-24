import {
	DARK_THEME,
	THEME,
	type KeypressOptions,
	type Theme,
} from "mind-elixir";
import type { MindMapHotkeys, ThemeMode } from "../settings/types";

export interface CanvasKeypressTarget {
	currentNode: { nodeObj: { children?: unknown[] } } | null;
	currentNodes: unknown[];
	currentSummary: { summaryObj: { id: string } } | null;
	currentArrow: unknown | null;
	addChild(): unknown;
	insertSibling(type: "before" | "after"): unknown;
	insertParent(): unknown;
	editSummary(summary: NonNullable<CanvasKeypressTarget["currentSummary"]>): void;
	editArrowLabel(arrow: NonNullable<CanvasKeypressTarget["currentArrow"]>): void;
	beginEdit(): unknown;
	removeNodes(nodes: unknown[]): unknown;
	removeArrow(): void;
	removeSummary(id: string): void;
	toCenter(): void;
	expandNode(node: NonNullable<CanvasKeypressTarget["currentNode"]>): void;
}

export function normalizeHotkeyKey(raw: string | undefined): string {
	if (!raw) return "";
	const trimmed = raw.trim();
	if (trimmed === "Space") return " ";
	return trimmed;
}

export function formatHotkeyForDisplay(key: string | undefined): string {
	if (!key) return "";
	return key === " " ? "Space" : key;
}

export function resolveEffectiveDarkMode(
	mode: ThemeMode,
	systemIsDark: boolean
): boolean {
	if (mode === "dark") return true;
	if (mode === "light") return false;
	return systemIsDark;
}

export function buildCanvasTheme(
	mode: ThemeMode,
	systemIsDark: boolean,
	readCssVar: (varName: string) => string
): Theme {
	const isDark = resolveEffectiveDarkMode(mode, systemIsDark);
	const base = isDark ? DARK_THEME : THEME;
	const token = (name: string, fallback: string) =>
		readCssVar(name).trim() || fallback;

	const bgPrimary = token("--background-primary", isDark ? "#1e1e1e" : "#ffffff");
	const bgSecondary = token("--background-secondary", isDark ? "#262626" : "#f5f5f5");
	const textNormal = token("--text-normal", isDark ? "#dcddde" : "#222222");
	const accent = token("--interactive-accent", isDark ? "#7c6af7" : "#4c6ef5");
	const border = token("--background-modifier-border", isDark ? "#3a3a3a" : "#e0e0e0");

	return {
		...base,
		name: isDark ? "ObsidianDark" : "ObsidianLight",
		type: isDark ? "dark" : "light",
		cssVar: {
			...base.cssVar,
			"--bgcolor": bgPrimary,
			"--color": textNormal,
			"--main-color": textNormal,
			"--main-bgcolor": bgSecondary,
			"--main-bgcolor-transparent": bgSecondary,
			"--root-bgcolor": accent,
			"--root-color": "#ffffff",
			"--selected": accent,
			"--accent-color": accent,
			"--panel-bgcolor": bgSecondary,
			"--panel-color": textNormal,
			"--panel-border-color": border,
			"--root-border-color": border,
			"--node-gap-x": "30px",
			"--node-gap-y": "12px",
			"--main-gap-x": "60px",
			"--main-gap-y": "36px",
			"--topic-padding": "4px 8px",
		},
	};
}

export function buildCanvasKeypressOptions(
	hotkeys: MindMapHotkeys,
	getTarget: () => CanvasKeypressTarget | null
): KeypressOptions {
	const options: KeypressOptions = {};

	const bindKey = (
		rawKey: string | undefined,
		handler: (e: KeyboardEvent, target: CanvasKeypressTarget) => void
	) => {
		const actualKey = normalizeHotkeyKey(rawKey);
		if (!actualKey) return;
		options[actualKey] = (e: KeyboardEvent) => {
			const target = getTarget();
			if (!target) return;
			handler(e, target);
		};
	};

	bindKey(hotkeys.addChild, (_e, target) => {
		void target.addChild();
	});

	bindKey(hotkeys.addSibling, (e, target) => {
		if (e.shiftKey) {
			void target.insertSibling("before");
		} else if (e.ctrlKey || e.metaKey) {
			void target.insertParent();
		} else {
			void target.insertSibling("after");
		}
	});

	bindKey(hotkeys.editNode, (_e, target) => {
		if (target.currentSummary) {
			target.editSummary(target.currentSummary);
		} else if (target.currentArrow) {
			target.editArrowLabel(target.currentArrow);
		} else {
			void target.beginEdit();
		}
	});

	bindKey(hotkeys.deleteNode, (_e, target) => {
		if (target.currentNodes.length > 0) {
			void target.removeNodes(target.currentNodes);
		} else if (target.currentArrow) {
			target.removeArrow();
		} else if (target.currentSummary) {
			target.removeSummary(target.currentSummary.summaryObj.id);
		}
	});

	bindKey(hotkeys.centerMap, (_e, target) => {
		target.toCenter();
	});

	bindKey(hotkeys.toggleCollapse, (_e, target) => {
		if (target.currentNode && target.currentNode.nodeObj.children?.length) {
			target.expandNode(target.currentNode);
		}
	});

	return options;
}
