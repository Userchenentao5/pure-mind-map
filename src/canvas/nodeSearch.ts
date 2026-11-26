import type { NodeObj } from "mind-elixir";
import { extractSearchableNodeText } from "../parser/inlineNodeContent";

export interface NodeSearchMatch {
	nodeId: string;
	topic: string;
	/** Ancestor node IDs ordered from root down to immediate parent */
	ancestorIds: string[];
	/** True when the search query matched inside the node's note rather than its topic */
	matchedInNote?: boolean;
}

/**
 * Performs case-insensitive pre-order DFS search across the entire Mind Map tree,
 * including collapsed branches, returning each match with its ancestor chain.
 */
export function findMatchingNodes(
	root: NodeObj | null | undefined,
	query: string
): NodeSearchMatch[] {
	const needle = query.trim().toLowerCase();
	if (!root || !needle) return [];

	const matches: NodeSearchMatch[] = [];

	const walk = (node: NodeObj, ancestors: string[]): void => {
		const rawTopic = node.topic ?? "";
		const readable = extractSearchableNodeText(rawTopic).toLowerCase();
		const rawLower = rawTopic.toLowerCase();
		const topicMatched = readable.includes(needle) || rawLower.includes(needle);

		const rawNote = node.note ?? "";
		const noteMatched =
			!topicMatched &&
			rawNote.length > 0 &&
			(extractSearchableNodeText(rawNote).toLowerCase().includes(needle) ||
				rawNote.toLowerCase().includes(needle));

		if (topicMatched || noteMatched) {
			matches.push({
				nodeId: node.id,
				topic: rawTopic,
				ancestorIds: [...ancestors],
				...(noteMatched ? { matchedInNote: true } : {}),
			});
		}

		const children = node.children ?? [];
		if (children.length > 0) {
			ancestors.push(node.id);
			for (const child of children) {
				walk(child, ancestors);
			}
			ancestors.pop();
		}
	};

	walk(root, []);
	return matches;
}

export function stepSearchMatchIndex(
	currentIndex: number,
	total: number,
	delta: 1 | -1
): number {
	if (total <= 0) return -1;
	if (currentIndex < 0 || currentIndex >= total) {
		return delta === 1 ? 0 : total - 1;
	}
	return ((currentIndex + delta) % total + total) % total;
}
