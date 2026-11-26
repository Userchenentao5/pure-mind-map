import type { NodeObj } from "mind-elixir";
import { markdownToMindMap } from "./markdownParser";

/**
 * Finds the tree pathKey ("0", "0.1", "0.1.0", ...) of a live MindElixir node by ID.
 */
export function findNodePathKeyById(
	root: NodeObj | null | undefined,
	targetNodeId: string
): string | null {
	if (!root || !targetNodeId) return null;

	const walk = (node: NodeObj, pathKey: string): string | null => {
		if (node.id === targetNodeId) return pathKey;
		const children = node.children ?? [];
		for (let i = 0; i < children.length; i++) {
			const hit = walk(children[i], `${pathKey}.${i}`);
			if (hit) return hit;
		}
		return null;
	};

	return walk(root, "0");
}

/**
 * Resolves a pathKey ("0.1.0") in a live MindElixir tree, returning the target node
 * and its ancestor IDs (from root down to parent) so collapsed branches can be expanded.
 */
export function resolveNodeByPathKey(
	root: NodeObj | null | undefined,
	pathKey: string
): { node: NodeObj; ancestorIds: string[] } | null {
	if (!root || !pathKey) return null;
	const parts = pathKey.split(".");
	if (parts[0] !== "0") return null;

	let current: NodeObj = root;
	const ancestorIds: string[] = [];

	for (let i = 1; i < parts.length; i++) {
		const idx = Number(parts[i]);
		const children = current.children ?? [];
		if (!Number.isInteger(idx) || idx < 0 || idx >= children.length) {
			return null;
		}
		ancestorIds.push(current.id);
		current = children[idx];
	}

	return { node: current, ancestorIds };
}

/**
 * Maps a Mind Map node pathKey (+ optional topic fallback) to its 0-based line number
 * in the Markdown source file.
 */
export function findMarkdownLineForNodePath(
	markdown: string,
	pathKey: string,
	topicFallback?: string
): number | null {
	const parsed = markdownToMindMap(markdown);
	const exact = parsed.nodeLines.find((entry) => entry.pathKey === pathKey);
	if (exact) return exact.line;

	if (topicFallback) {
		const byTopic = parsed.nodeLines.find(
			(entry) => entry.topic === topicFallback
		);
		if (byTopic) return byTopic.line;
	}
	return null;
}

/**
 * Maps a 0-based Source Mode cursor line to the corresponding Mind Map node pathKey.
 * Exact line matches win; when cursor sits on a blank line, comment, or code block
 * underneath a heading/item, resolves to the nearest preceding node line.
 */
export function findNodePathForMarkdownLine(
	markdown: string,
	cursorLine: number
): string | null {
	if (cursorLine < 0) return null;
	const parsed = markdownToMindMap(markdown);
	if (parsed.nodeLines.length === 0) return null;

	let best: { pathKey: string; line: number } | null = null;
	for (const entry of parsed.nodeLines) {
		if (entry.line === cursorLine) {
			return entry.pathKey;
		}
		if (entry.line < cursorLine) {
			if (!best || entry.line >= best.line) {
				best = { pathKey: entry.pathKey, line: entry.line };
			}
		}
	}

	return best ? best.pathKey : null;
}
