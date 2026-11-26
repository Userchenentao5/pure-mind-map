export interface RectLike {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface MinimapNodeInput extends RectLike {
	isRoot: boolean;
	isSelected: boolean;
	color?: string;
}

export interface MinimapEdgeInput {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	color?: string;
}

export interface MinimapLayout {
	canvasWidth: number;
	canvasHeight: number;
	scale: number;
	offsetX: number;
	offsetY: number;
	bounds: RectLike;
	viewport: RectLike;
	nodes: Array<{
		x: number;
		y: number;
		w: number;
		h: number;
		isRoot: boolean;
		isSelected: boolean;
		color?: string;
	}>;
	edges: Array<{
		x1: number;
		y1: number;
		x2: number;
		y2: number;
		color?: string;
	}>;
}

/**
 * Computes a tight, aspect-preserving minimap projection from live screen-space
 * node boxes and the container viewport rectangle.
 */
export function computeMinimapLayout(
	nodes: readonly MinimapNodeInput[],
	edges: readonly MinimapEdgeInput[],
	viewRect: RectLike,
	canvasWidth: number,
	canvasHeight: number,
	padding = 10
): MinimapLayout | null {
	if (
		nodes.length === 0 ||
		viewRect.width <= 0 ||
		viewRect.height <= 0 ||
		canvasWidth <= padding * 2 ||
		canvasHeight <= padding * 2
	) {
		return null;
	}

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const node of nodes) {
		if (node.width <= 0 && node.height <= 0) continue;
		minX = Math.min(minX, node.left);
		minY = Math.min(minY, node.top);
		maxX = Math.max(maxX, node.left + node.width);
		maxY = Math.max(maxY, node.top + node.height);
	}

	if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
		return null;
	}

	const margin = 48;
	const nodesWidth = Math.max(1, maxX - minX);
	const nodesHeight = Math.max(1, maxY - minY);
	const nodesCenterX = (minX + maxX) / 2;
	const nodesCenterY = (minY + maxY) / 2;

	// Ensure comfortable canvas breathing room around small maps so the viewport box
	// stays well-proportioned and draggable, while expanding to include the viewport
	// if the user pans far outside the map.
	const worldWidth = Math.max(nodesWidth + margin * 2, viewRect.width * 1.8);
	const worldHeight = Math.max(nodesHeight + margin * 2, viewRect.height * 1.8);

	const worldLeft = Math.min(nodesCenterX - worldWidth / 2, viewRect.left - 24);
	const worldTop = Math.min(nodesCenterY - worldHeight / 2, viewRect.top - 24);
	const worldRight = Math.max(
		nodesCenterX + worldWidth / 2,
		viewRect.left + viewRect.width + 24
	);
	const worldBottom = Math.max(
		nodesCenterY + worldHeight / 2,
		viewRect.top + viewRect.height + 24
	);

	const bounds: RectLike = {
		left: worldLeft,
		top: worldTop,
		width: Math.max(1, worldRight - worldLeft),
		height: Math.max(1, worldBottom - worldTop),
	};

	const availW = canvasWidth - padding * 2;
	const availH = canvasHeight - padding * 2;
	const scale = Math.min(availW / bounds.width, availH / bounds.height);
	const offsetX = padding + (availW - bounds.width * scale) / 2;
	const offsetY = padding + (availH - bounds.height * scale) / 2;

	const projectX = (screenX: number) => offsetX + (screenX - bounds.left) * scale;
	const projectY = (screenY: number) => offsetY + (screenY - bounds.top) * scale;

	const projectedNodes = nodes.map((node) => ({
		x: projectX(node.left),
		y: projectY(node.top),
		w: Math.max(3, node.width * scale),
		h: Math.max(2, node.height * scale),
		isRoot: node.isRoot,
		isSelected: node.isSelected,
		color: node.color,
	}));

	const projectedEdges = edges.map((edge) => ({
		x1: projectX(edge.x1),
		y1: projectY(edge.y1),
		x2: projectX(edge.x2),
		y2: projectY(edge.y2),
		color: edge.color,
	}));

	const viewport: RectLike = {
		left: projectX(viewRect.left),
		top: projectY(viewRect.top),
		width: Math.max(8, viewRect.width * scale),
		height: Math.max(8, viewRect.height * scale),
	};

	return {
		canvasWidth,
		canvasHeight,
		scale,
		offsetX,
		offsetY,
		bounds,
		viewport,
		nodes: projectedNodes,
		edges: projectedEdges,
	};
}

/**
 * Translates a click/drag point (mx, my) inside the minimap canvas into the
 * screen-space (dx, dy) pan delta needed to center that map point in viewRect.
 */
export function minimapPointToPanDelta(
	layout: MinimapLayout,
	viewRect: RectLike,
	mx: number,
	my: number
): { dx: number; dy: number } {
	const targetScreenX = layout.bounds.left + (mx - layout.offsetX) / layout.scale;
	const targetScreenY = layout.bounds.top + (my - layout.offsetY) / layout.scale;
	const viewCenterX = viewRect.left + viewRect.width / 2;
	const viewCenterY = viewRect.top + viewRect.height / 2;
	return {
		dx: viewCenterX - targetScreenX,
		dy: viewCenterY - targetScreenY,
	};
}
