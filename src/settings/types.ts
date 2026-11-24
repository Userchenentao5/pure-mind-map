export type MindMapDirection = "side" | "right" | "left" | "down";

export type MarkdownSerializeStyle = "heading-list" | "list";

export type ThemeMode = "auto" | "light" | "dark";

export interface MindMapHotkeys {
	addChild: string;
	addSibling: string;
	editNode: string;
	deleteNode: string;
	centerMap: string;
	toggleCollapse: string;
}

export interface MindMapSettings {
	autoOpenMindMap: boolean;
	defaultDirection: MindMapDirection;
	markdownStyle: MarkdownSerializeStyle;
	themeMode: ThemeMode;
	compactMode: boolean;
	defaultNewFolder: string;
	exportFolder: string;
	exportScale: number;
	hotkeys: MindMapHotkeys;
}

export const DEFAULT_HOTKEYS: MindMapHotkeys = {
	addChild: "Tab",
	addSibling: "Enter",
	editNode: "F2",
	deleteNode: "Delete",
	centerMap: "F1",
	toggleCollapse: " ",
};

export const DEFAULT_SETTINGS: MindMapSettings = {
	autoOpenMindMap: true,
	defaultDirection: "side",
	markdownStyle: "heading-list",
	themeMode: "auto",
	compactMode: false,
	defaultNewFolder: "",
	exportFolder: "",
	exportScale: 2,
	hotkeys: { ...DEFAULT_HOTKEYS },
};

export const MINDMAP_VIEW_TYPE = "simple-obsidian-mind-map-view";
export const MINDMAP_FRONTMATTER_KEY = "mindmap-plugin";
export const MINDMAP_DIRECTION_KEY = "mindmap-direction";
export const MINDMAP_ICON_ID = "simple-mind-map-icon";
export const MINDMAP_ICON_SVG = `<g fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="38" width="28" height="24" rx="6"/><rect x="66" y="12" width="26" height="20" rx="5"/><rect x="66" y="40" width="26" height="20" rx="5"/><rect x="66" y="68" width="26" height="20" rx="5"/><path d="M 36 50 C 51 50 51 22 66 22"/><path d="M 36 50 L 66 50"/><path d="M 36 50 C 51 50 51 78 66 78"/></g>`;

export function directionToCode(direction: MindMapDirection): 0 | 1 | 2 | 3 {
	switch (direction) {
		case "left":
			return 0;
		case "right":
			return 1;
		case "down":
			return 3;
		case "side":
		default:
			return 2;
	}
}

export function codeToDirection(code: number | undefined): MindMapDirection {
	switch (code) {
		case 0:
			return "left";
		case 1:
			return "right";
		case 3:
			return "down";
		case 2:
		default:
			return "side";
	}
}
