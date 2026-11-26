import {
	DARK_THEME,
	THEME,
	type KeypressOptions,
	type MainLineParams,
	type NodeObj,
	type Options,
	type SubLineParams,
	type Theme,
} from "mind-elixir";
import type {
	ContextMenuLanguage,
	MindMapHotkeys,
	MindMapStylePreset,
	ThemeMode,
} from "../settings/types";

export const STYLE_PRESET_LABELS: Record<MindMapStylePreset, string> = {
	classic: "经典导图（1 级边框 + 下划线曲线）",
	card: "卡片逻辑图（全节点圆角卡片 + 圆角折线）",
	bordered: "柔和卡片（全节点圆角卡片 + 柔和曲线）",
};

export function buildHorizontalBracketPath(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	radius = 8,
	elbowRatio = 0.5
): string {
	if (Math.abs(endY - startY) < 2) {
		const alignedY = Math.round((startY + endY) / 2);
		return `M ${startX} ${alignedY} H ${endX}`;
	}
	const midX = startX + (endX - startX) * elbowRatio;
	const dirX = endX >= startX ? 1 : -1;
	const dirY = endY >= startY ? 1 : -1;
	const r = Math.min(
		radius,
		Math.abs(midX - startX),
		Math.abs(endX - midX),
		Math.abs(endY - startY) / 2
	);
	return `M ${startX} ${startY} H ${midX - dirX * r} Q ${midX} ${startY} ${midX} ${startY + dirY * r} V ${endY - dirY * r} Q ${midX} ${endY} ${midX + dirX * r} ${endY} H ${endX}`;
}

export function buildVerticalBracketPath(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	radius = 8,
	elbowRatio = 0.5
): string {
	if (Math.abs(endX - startX) < 2) {
		const alignedX = Math.round((startX + endX) / 2);
		return `M ${alignedX} ${startY} V ${endY}`;
	}
	const midY = startY + (endY - startY) * elbowRatio;
	const dirX = endX >= startX ? 1 : -1;
	const dirY = endY >= startY ? 1 : -1;
	const r = Math.min(
		radius,
		Math.abs(midY - startY),
		Math.abs(endY - midY),
		Math.abs(endX - startX) / 2
	);
	return `M ${startX} ${startY} V ${midY - dirY * r} Q ${startX} ${midY} ${startX + dirX * r} ${midY} H ${endX - dirX * r} Q ${endX} ${midY} ${endX} ${midY + dirY * r} V ${endY}`;
}

export function buildCenterBezierPath(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	vertical = false
): string {
	if (vertical) {
		const midY = (startY + endY) / 2;
		return `M ${startX} ${startY} C ${startX} ${midY} ${endX} ${midY} ${endX} ${endY}`;
	}
	const midX = (startX + endX) / 2;
	return `M ${startX} ${startY} C ${midX} ${startY} ${midX} ${endY} ${endX} ${endY}`;
}

function generateCardMainBranch({
	pT,
	pL,
	pW,
	pH,
	cT,
	cL,
	cW,
	cH,
	direction,
}: MainLineParams): string {
	if (direction === "down") {
		return buildVerticalBracketPath(pL + pW / 2, pT + pH, cL + cW / 2, cT);
	}
	const startY = pT + pH / 2;
	const endY = cT + cH / 2;
	if (direction === "lhs") {
		return buildHorizontalBracketPath(pL, startY, cL + cW, endY);
	}
	return buildHorizontalBracketPath(pL + pW, startY, cL, endY);
}

function generateBorderedMainBranch({
	pT,
	pL,
	pW,
	pH,
	cT,
	cL,
	cW,
	cH,
	direction,
}: MainLineParams): string {
	if (direction === "down") {
		return buildCenterBezierPath(pL + pW / 2, pT + pH, cL + cW / 2, cT, true);
	}
	const startY = pT + pH / 2;
	const endY = cT + cH / 2;
	if (direction === "lhs") {
		return buildCenterBezierPath(pL, startY, cL + cW, endY, false);
	}
	return buildCenterBezierPath(pL + pW, startY, cL, endY, false);
}

function readNodeGapX(container: HTMLElement | undefined): number {
	const raw = container?.style.getPropertyValue("--node-gap-x");
	const parsed = raw ? parseInt(raw, 10) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function generateCardSubBranch(
	this: { container?: HTMLElement },
	{ pT, pL, pW, pH, cT, cL, cW, cH, direction, isFirst }: SubLineParams
): string {
	if (direction === "down") {
		return buildVerticalBracketPath(
			pL + pW / 2,
			pT + pH,
			cL + cW / 2,
			cT,
			8,
			0.65
		);
	}
	const gap = readNodeGapX(this?.container);
	const startY = pT + pH / 2;
	const endY = cT + cH / 2;
	if (direction === "lhs") {
		const startX = isFirst ? pL : pL + gap;
		const endX = cL + cW - gap;
		return buildHorizontalBracketPath(startX, startY, endX, endY, 8, 0.65);
	}
	const startX = isFirst ? pL + pW : pL + pW - gap;
	const endX = cL + gap;
	return buildHorizontalBracketPath(startX, startY, endX, endY, 8, 0.65);
}

function generateBorderedSubBranch(
	this: { container?: HTMLElement },
	{ pT, pL, pW, pH, cT, cL, cW, cH, direction, isFirst }: SubLineParams
): string {
	if (direction === "down") {
		return buildCenterBezierPath(pL + pW / 2, pT + pH, cL + cW / 2, cT, true);
	}
	const gap = readNodeGapX(this?.container);
	const startY = pT + pH / 2;
	const endY = cT + cH / 2;
	if (direction === "lhs") {
		const startX = isFirst ? pL : pL + gap;
		const endX = cL + cW - gap;
		return buildCenterBezierPath(startX, startY, endX, endY, false);
	}
	const startX = isFirst ? pL + pW : pL + pW - gap;
	const endX = cL + gap;
	return buildCenterBezierPath(startX, startY, endX, endY, false);
}

export type CanvasContextMenuOption = Exclude<
	NonNullable<Options["contextMenu"]>,
	boolean
>;
type ContextMenuLocale = NonNullable<CanvasContextMenuOption["locale"]>;

const CONTEXT_MENU_LOCALES: Record<ContextMenuLanguage, ContextMenuLocale> = {
	"zh-CN": {
		addChild: "添加子节点",
		addParent: "添加父节点",
		addSibling: "添加兄弟节点",
		removeNode: "删除节点",
		focus: "专注模式",
		cancelFocus: "退出专注模式",
		moveUp: "上移",
		moveDown: "下移",
		link: "连接节点",
		linkBidirectional: "双向连接",
		clickTips: "请点击目标节点",
		summary: "添加概要",
	},
	"zh-TW": {
		addChild: "新增子節點",
		addParent: "新增父節點",
		addSibling: "新增同級節點",
		removeNode: "刪除節點",
		focus: "專注模式",
		cancelFocus: "退出專注模式",
		moveUp: "上移",
		moveDown: "下移",
		link: "連接節點",
		linkBidirectional: "雙向連接",
		clickTips: "請點擊目標節點",
		summary: "新增概要",
	},
	en: {
		addChild: "Add child",
		addParent: "Add parent",
		addSibling: "Add sibling",
		removeNode: "Remove node",
		focus: "Focus Mode",
		cancelFocus: "Cancel Focus Mode",
		moveUp: "Move up",
		moveDown: "Move down",
		link: "Link",
		linkBidirectional: "Bidirectional Link",
		clickTips: "Please click the target node",
		summary: "Summary",
	},
	ja: {
		addChild: "子ノードを追加",
		addParent: "親ノードを追加",
		addSibling: "兄弟ノードを追加",
		removeNode: "ノードを削除",
		focus: "フォーカスモード",
		cancelFocus: "フォーカス解除",
		moveUp: "上へ移動",
		moveDown: "下へ移動",
		link: "リンク",
		linkBidirectional: "双方向リンク",
		clickTips: "対象ノードをクリックしてください",
		summary: "サマリー",
	},
	ko: {
		addChild: "하위 노드 추가",
		addParent: "상위 노드 추가",
		addSibling: "형제 노드 추가",
		removeNode: "노드 삭제",
		focus: "집중 모드",
		cancelFocus: "집중 모드 해제",
		moveUp: "위로 이동",
		moveDown: "아래로 이동",
		link: "연결",
		linkBidirectional: "양방향 연결",
		clickTips: "대상 노드를 클릭하세요",
		summary: "요약",
	},
};

const CONTEXT_MENU_NOTE_LABELS: Record<ContextMenuLanguage, string> = {
	"zh-CN": "编辑备注",
	"zh-TW": "編輯備註",
	en: "Edit note",
	ja: "メモを編集",
	ko: "메모 편집",
};

export function buildContextMenuOption(
	language: ContextMenuLanguage | undefined,
	onEditNote?: () => void
): CanvasContextMenuOption {
	const resolvedLang: ContextMenuLanguage =
		language && language in CONTEXT_MENU_LOCALES ? language : "zh-CN";
	const locale = CONTEXT_MENU_LOCALES[resolvedLang];
	return {
		focus: true,
		link: true,
		locale,
		...(onEditNote
			? {
					extend: [
						{
							name: CONTEXT_MENU_NOTE_LABELS[resolvedLang],
							onclick: () => {
								onEditNote();
							},
						},
					],
				}
			: {}),
	};
}

export function countDescendantNodes(node: NodeObj | null | undefined): number {
	if (!node?.children?.length) return 0;
	let total = 0;
	for (const child of node.children) {
		total += 1 + countDescendantNodes(child);
	}
	return total;
}

export function formatDescendantCountBadge(count: number): string {
	return count > 99 ? "99+" : String(count);
}

/**
 * Computes clamped (left, top) coordinates for a context menu relative to its
 * host container so it flips upward/leftward near edges and never clips off-screen.
 */
export function computeContextMenuPosition(params: {
	clickX: number;
	clickY: number;
	menuWidth: number;
	menuHeight: number;
	containerWidth: number;
	containerHeight: number;
	margin?: number;
}): { left: number; top: number } {
	const margin = params.margin ?? 12;
	const { clickX, clickY, menuWidth, menuHeight, containerWidth, containerHeight } =
		params;

	let left = clickX + 8;
	if (left + menuWidth > containerWidth - margin) {
		left = clickX - menuWidth - 8;
	}
	left = Math.max(margin, Math.min(left, containerWidth - menuWidth - margin));

	let top = clickY + 8;
	if (top + menuHeight > containerHeight - margin) {
		top = clickY - menuHeight - 8;
	}
	top = Math.max(margin, Math.min(top, containerHeight - menuHeight - margin));

	return { left: Math.round(left), top: Math.round(top) };
}

export interface CanvasRelinkHost {
	isReady(): boolean;
	linkDiv(): void;
	requestFrame(cb: () => void): number;
	cancelFrame(id: number): void;
}

export interface CanvasRelinkScheduler {
	schedule(): void;
	cancel(): void;
}

export function isImageEventTarget(target: EventTarget | null): boolean {
	if (!target || typeof target !== "object") return false;
	const tagName = (target as { tagName?: unknown }).tagName;
	return typeof tagName === "string" && tagName.toUpperCase() === "IMG";
}

/**
 * Coalesces asynchronous node layout shifts (such as newly inserted or loaded
 * embedded images expanding a Node box) into a single animation-frame linkDiv()
 * pass so branch SVG paths never lag behind or hide under resized Nodes.
 */
export function createCanvasRelinkScheduler(
	host: CanvasRelinkHost
): CanvasRelinkScheduler {
	let pendingFrameId: number | null = null;

	return {
		schedule(): void {
			if (pendingFrameId !== null) return;
			pendingFrameId = host.requestFrame(() => {
				pendingFrameId = null;
				if (!host.isReady()) return;
				host.linkDiv();
			});
		},
		cancel(): void {
			if (pendingFrameId !== null) {
				host.cancelFrame(pendingFrameId);
				pendingFrameId = null;
			}
		},
	};
}

export interface CanvasKeypressTarget {
	currentNode: { nodeObj: { children?: unknown[] } } | null;
	currentNodes: unknown[];
	currentSummary: { summaryObj: { id: string } } | null;
	currentArrow: object | null;
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
	readCssVar: (varName: string) => string,
	stylePreset: MindMapStylePreset = "classic"
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

	const branchGenerators: Partial<
		Pick<Theme, "generateMainBranch" | "generateSubBranch">
	> =
		stylePreset === "card"
			? {
					generateMainBranch: generateCardMainBranch,
					generateSubBranch: generateCardSubBranch,
				}
			: stylePreset === "bordered"
				? {
						generateMainBranch: generateBorderedMainBranch,
						generateSubBranch: generateBorderedSubBranch,
					}
				: {};

	return {
		...base,
		...branchGenerators,
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
