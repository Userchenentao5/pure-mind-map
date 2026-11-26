import type MindElixir from "mind-elixir";
import type { NodeObj, Topic } from "mind-elixir";
import { setIcon } from "obsidian";
import {
	computeMinimapLayout,
	minimapPointToPanDelta,
	type MinimapEdgeInput,
	type MinimapLayout,
	type MinimapNodeInput,
	type RectLike,
} from "./minimapGeometry";

const MINIMAP_WIDTH = 188;
const MINIMAP_HEIGHT = 120;
const MINIMAP_PADDING = 10;

export interface MindMapMinimapHost {
	getMind: () => MindElixir | null;
	onRecenter: () => void;
}

/**
 * Floating bottom-left minimap widget for MindMapView.
 * Renders a live overview of visible nodes, branch connections, and the current
 * viewport rectangle, supporting click and drag panning plus collapse/expand.
 */
export class MindMapMinimap {
	private host: MindMapMinimapHost;
	private rootEl: HTMLElement | null = null;
	private canvasEl: HTMLCanvasElement | null = null;
	private toggleBtnEl: HTMLButtonElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private rafId: number | null = null;
	private lastLayout: MinimapLayout | null = null;
	private isCollapsed = true;
	private isDragging = false;
	private activePointerId: number | null = null;

	constructor(host: MindMapMinimapHost) {
		this.host = host;
	}

	public attach(container: HTMLElement): void {
		this.detach();

		const root = container.createDiv({ cls: "mm-minimap" });
		const stopEvent = (evt: Event) => {
			evt.stopPropagation();
		};
		root.addEventListener("pointerdown", stopEvent);
		root.addEventListener("pointermove", stopEvent);
		root.addEventListener("pointerup", stopEvent);
		root.addEventListener("mousedown", stopEvent);
		root.addEventListener("click", stopEvent);
		root.addEventListener("wheel", stopEvent, { passive: true });

		const header = root.createDiv({ cls: "mm-minimap-header" });
		header.createSpan({ cls: "mm-minimap-title", text: "缩略图" });

		const actions = header.createDiv({ cls: "mm-minimap-actions" });

		const centerBtn = actions.createEl("button", {
			cls: "mm-minimap-btn mm-minimap-center-btn",
			attr: {
				type: "button",
				title: "居中画布 (F1)",
				"aria-label": "居中画布",
			},
		});
		setIcon(centerBtn, "crosshair");
		centerBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.host.onRecenter();
		});

		const toggleBtn = actions.createEl("button", {
			cls: "mm-minimap-btn mm-minimap-toggle-btn",
			attr: {
				type: "button",
				title: "收起缩略图",
				"aria-label": "收起缩略图",
			},
		});
		setIcon(toggleBtn, "chevron-down");
		toggleBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.setCollapsed(!this.isCollapsed);
		});

		const body = root.createDiv({ cls: "mm-minimap-body" });
		const canvas = body.createEl("canvas", {
			cls: "mm-minimap-canvas",
			attr: {
				width: String(MINIMAP_WIDTH),
				height: String(MINIMAP_HEIGHT),
			},
		});

		canvas.addEventListener("pointerdown", (evt) =>
			this.handleCanvasPointerDown(evt)
		);
		canvas.addEventListener("pointermove", (evt) =>
			this.handleCanvasPointerMove(evt)
		);
		canvas.addEventListener("pointerup", (evt) =>
			this.handleCanvasPointerUp(evt)
		);
		canvas.addEventListener("pointercancel", (evt) =>
			this.handleCanvasPointerUp(evt)
		);

		this.rootEl = root;
		this.canvasEl = canvas;
		this.toggleBtnEl = toggleBtn;
		this.applyCollapsedState();
	}

	public bindMind(mind: MindElixir): void {
		this.unbindMind();
		if (typeof ResizeObserver !== "undefined" && mind.container) {
			this.resizeObserver = new ResizeObserver(() => {
				this.scheduleRender();
			});
			this.resizeObserver.observe(mind.container);
		}
		this.scheduleRender();
	}

	public unbindMind(): void {
		if (this.rafId !== null) {
			window.cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		this.lastLayout = null;
		this.isDragging = false;
		this.activePointerId = null;
	}

	public detach(): void {
		this.unbindMind();
		if (this.rootEl) {
			this.rootEl.remove();
			this.rootEl = null;
		}
		this.canvasEl = null;
		this.toggleBtnEl = null;
	}

	public scheduleRender(): void {
		if (this.isCollapsed || !this.canvasEl) return;
		if (this.rafId !== null) return;
		this.rafId = window.requestAnimationFrame(() => {
			this.rafId = null;
			this.renderNow();
		});
	}

	private setCollapsed(collapsed: boolean): void {
		this.isCollapsed = collapsed;
		this.applyCollapsedState();
		if (!collapsed) {
			this.scheduleRender();
		}
	}

	private applyCollapsedState(): void {
		if (!this.rootEl || !this.toggleBtnEl) return;
		this.rootEl.toggleClass("is-collapsed", this.isCollapsed);
		setIcon(this.toggleBtnEl, this.isCollapsed ? "map" : "chevron-down");
		const title = this.isCollapsed ? "展开缩略图" : "收起缩略图";
		this.toggleBtnEl.setAttribute("title", title);
		this.toggleBtnEl.setAttribute("aria-label", title);
	}

	private handleCanvasPointerDown(evt: PointerEvent): void {
		if (evt.button !== 0 || !this.canvasEl) return;
		evt.preventDefault();
		evt.stopPropagation();
		this.isDragging = true;
		this.activePointerId = evt.pointerId;
		this.canvasEl.addClass("is-dragging");
		try {
			this.canvasEl.setPointerCapture(evt.pointerId);
		} catch {
			// Ignore synthetic pointer capture errors
		}
		this.panToPointer(evt);
	}

	private handleCanvasPointerMove(evt: PointerEvent): void {
		if (!this.isDragging || evt.pointerId !== this.activePointerId) return;
		evt.preventDefault();
		evt.stopPropagation();
		this.panToPointer(evt);
	}

	private handleCanvasPointerUp(evt: PointerEvent): void {
		if (!this.isDragging || evt.pointerId !== this.activePointerId) return;
		evt.preventDefault();
		evt.stopPropagation();
		this.isDragging = false;
		this.activePointerId = null;
		this.canvasEl?.removeClass("is-dragging");
		try {
			this.canvasEl?.releasePointerCapture(evt.pointerId);
		} catch {
			// Ignore release errors
		}
	}

	private panToPointer(evt: PointerEvent): void {
		const mind = this.host.getMind();
		const canvas = this.canvasEl;
		if (!mind || !canvas) return;

		if (!this.lastLayout) {
			this.renderNow();
		}
		const layout = this.lastLayout;
		if (!layout) return;

		const canvasRect = canvas.getBoundingClientRect();
		if (canvasRect.width <= 0 || canvasRect.height <= 0) return;

		const mx = ((evt.clientX - canvasRect.left) / canvasRect.width) * MINIMAP_WIDTH;
		const my = ((evt.clientY - canvasRect.top) / canvasRect.height) * MINIMAP_HEIGHT;
		const viewRect = this.readViewRect(mind);
		if (!viewRect) return;

		const { dx, dy } = minimapPointToPanDelta(layout, viewRect, mx, my);
		if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) {
			mind.move(dx, dy);
			this.renderNow();
		}
	}

	private readViewRect(mind: MindElixir): RectLike | null {
		if (!mind.container?.isConnected) return null;
		const rect = mind.container.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		return {
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
		};
	}

	private renderNow(): void {
		const mind = this.host.getMind();
		const canvas = this.canvasEl;
		if (this.isCollapsed || !mind || !canvas || !mind.nodes?.isConnected) {
			this.lastLayout = null;
			return;
		}

		const viewRect = this.readViewRect(mind);
		if (!viewRect) {
			this.lastLayout = null;
			return;
		}

		const { nodes, edges } = this.collectVisibleScene(mind);
		const layout = computeMinimapLayout(
			nodes,
			edges,
			viewRect,
			MINIMAP_WIDTH,
			MINIMAP_HEIGHT,
			MINIMAP_PADDING
		);
		this.lastLayout = layout;

		const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
		const pixelW = Math.round(MINIMAP_WIDTH * dpr);
		const pixelH = Math.round(MINIMAP_HEIGHT * dpr);
		if (canvas.width !== pixelW || canvas.height !== pixelH) {
			canvas.width = pixelW;
			canvas.height = pixelH;
		}

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
		if (!layout) return;

		const styles = getComputedStyle(this.rootEl ?? canvas);
		const accent =
			styles.getPropertyValue("--interactive-accent").trim() || "#7c6af7";
		const muted = styles.getPropertyValue("--text-muted").trim() || "#8a8f98";
		const faint = styles.getPropertyValue("--text-faint").trim() || "#9ca3af";

		// 1. Draw parent-child edges
		ctx.lineWidth = 1;
		ctx.lineCap = "round";
		for (const edge of layout.edges) {
			ctx.save();
			ctx.strokeStyle = edge.color || faint;
			ctx.globalAlpha = edge.color ? 0.55 : 0.45;
			ctx.beginPath();
			ctx.moveTo(edge.x1, edge.y1);
			ctx.lineTo(edge.x2, edge.y2);
			ctx.stroke();
			ctx.restore();
		}

		// 2. Draw visible nodes
		for (const node of layout.nodes) {
			ctx.save();
			const radius = Math.min(2.5, node.h / 2, node.w / 2);
			if (node.isRoot) {
				ctx.fillStyle = accent;
				ctx.globalAlpha = 0.95;
			} else if (node.isSelected) {
				ctx.fillStyle = accent;
				ctx.globalAlpha = 0.85;
			} else if (node.color) {
				ctx.fillStyle = node.color;
				ctx.globalAlpha = 0.65;
			} else {
				ctx.fillStyle = muted;
				ctx.globalAlpha = 0.55;
			}
			this.drawRoundedRect(ctx, node.x, node.y, node.w, node.h, radius);
			ctx.fill();

			if (node.isSelected) {
				ctx.globalAlpha = 1;
				ctx.strokeStyle = accent;
				ctx.lineWidth = 1.25;
				this.drawRoundedRect(
					ctx,
					node.x - 1,
					node.y - 1,
					node.w + 2,
					node.h + 2,
					radius + 0.5
				);
				ctx.stroke();
			}
			ctx.restore();
		}

		// 3. Draw current viewport rectangle
		const vp = layout.viewport;
		ctx.save();
		ctx.fillStyle = accent;
		ctx.globalAlpha = 0.06;
		this.drawRoundedRect(ctx, vp.left, vp.top, vp.width, vp.height, 3);
		ctx.fill();

		ctx.strokeStyle = accent;
		ctx.globalAlpha = 0.72;
		ctx.lineWidth = 1;
		this.drawRoundedRect(ctx, vp.left, vp.top, vp.width, vp.height, 3);
		ctx.stroke();
		ctx.restore();
	}

	private collectVisibleScene(mind: MindElixir): {
		nodes: MinimapNodeInput[];
		edges: MinimapEdgeInput[];
	} {
		const isRootCollapsed = mind.nodes.classList.contains("mm-root-collapsed");
		const branchColors = new Map<string, string>();
		const walkColors = (node: NodeObj, inheritedColor?: string) => {
			const effective = node.branchColor || inheritedColor;
			if (effective) {
				branchColors.set(node.id, effective);
			}
			for (const child of node.children ?? []) {
				walkColors(child, effective);
			}
		};
		if (mind.nodeData) {
			walkColors(mind.nodeData);
		}

		const tpcList = isRootCollapsed
			? mind.nodes.querySelectorAll<Topic>(".me-root > .me-tpc")
			: mind.nodes.querySelectorAll<Topic>(".me-tpc");

		const nodes: MinimapNodeInput[] = [];
		const rectById = new Map<string, RectLike>();

		tpcList.forEach((tpc) => {
			const rect = tpc.getBoundingClientRect();
			if (rect.width <= 0 && rect.height <= 0) return;
			const nodeId = tpc.nodeObj?.id;
			const box: RectLike = {
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height,
			};
			if (nodeId) {
				rectById.set(nodeId, box);
			}
			nodes.push({
				...box,
				isRoot: Boolean(tpc.parentElement?.classList.contains("me-root")),
				isSelected: tpc.classList.contains("selected"),
				color: nodeId ? branchColors.get(nodeId) : undefined,
			});
		});

		const edges: MinimapEdgeInput[] = [];
		if (!isRootCollapsed && mind.nodeData) {
			const walkEdges = (parent: NodeObj) => {
				const parentRect = rectById.get(parent.id);
				for (const child of parent.children ?? []) {
					const childRect = rectById.get(child.id);
					if (parentRect && childRect) {
						edges.push({
							x1: parentRect.left + parentRect.width / 2,
							y1: parentRect.top + parentRect.height / 2,
							x2: childRect.left + childRect.width / 2,
							y2: childRect.top + childRect.height / 2,
							color: branchColors.get(child.id),
						});
					}
					walkEdges(child);
				}
			};
			walkEdges(mind.nodeData);
		}

		return { nodes, edges };
	}

	private drawRoundedRect(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		w: number,
		h: number,
		r: number
	): void {
		const radius = Math.max(0, Math.min(r, w / 2, h / 2));
		ctx.beginPath();
		ctx.moveTo(x + radius, y);
		ctx.lineTo(x + w - radius, y);
		ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
		ctx.lineTo(x + w, y + h - radius);
		ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
		ctx.lineTo(x + radius, y + h);
		ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
		ctx.lineTo(x, y + radius);
		ctx.quadraticCurveTo(x, y, x + radius, y);
		ctx.closePath();
	}
}
