import * as d3force from "d3-force";
import * as d3sel from "d3-selection";
import * as d3zoom from "d3-zoom";
import * as d3drag from "d3-drag";

export interface GraphNode extends d3force.SimulationNodeDatum {
  id: string;
  label: string;
  path: string;
  group: string;
  degree: number;
  title: string | null;
}

export interface GraphEdge extends d3force.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphOptions {
  onNodeClick?: (node: GraphNode) => void;
}

/**
 * Render a force-directed knowledge graph into the given SVG element.
 *
 * Visual tweaks tuned for a "premium" feel:
 *   - subtle link stroke on the base, bright highlight on hover
 *   - node radius proportional to sqrt(degree), minimum 5px
 *   - drop-shadow glow on hovered node
 *   - dim-unrelated hover mode: everything not connected to the hovered node fades
 *   - labels only appear on hover / for big nodes
 */
export function renderGraph(
  svgEl: SVGSVGElement,
  data: GraphData,
  opts: GraphOptions = {},
): () => void {
  const svg = d3sel.select(svgEl);
  svg.selectAll("*").remove();

  const width = svgEl.clientWidth || 1200;
  const height = svgEl.clientHeight || 800;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  // Root group for zoom/pan.
  const root = svg.append("g").attr("class", "graph-root");

  // Layers.
  const linkLayer = root.append("g").attr("class", "links");
  const nodeLayer = root.append("g").attr("class", "nodes");

  // Copy edges so d3 can mutate source/target into references.
  const links: GraphEdge[] = data.edges.map((e) => ({ ...e }));
  const nodes: GraphNode[] = data.nodes.map((n) => ({ ...n }));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Adjacency for hover highlighting.
  const adjacency = new Map<string, Set<string>>();
  for (const n of nodes) adjacency.set(n.id, new Set());
  for (const e of data.edges) {
    const s = typeof e.source === "string" ? e.source : e.source.id;
    const t = typeof e.target === "string" ? e.target : e.target.id;
    adjacency.get(s)?.add(t);
    adjacency.get(t)?.add(s);
  }

  const radius = (n: GraphNode) => 5 + Math.sqrt(n.degree) * 2.4;

  // Simulation.
  const sim = d3force
    .forceSimulation<GraphNode>(nodes)
    .force(
      "link",
      d3force
        .forceLink<GraphNode, GraphEdge>(links)
        .id((d) => d.id)
        .distance(90)
        .strength(0.35),
    )
    .force("charge", d3force.forceManyBody<GraphNode>().strength(-320).distanceMax(520))
    .force("center", d3force.forceCenter(width / 2, height / 2))
    .force(
      "collision",
      d3force.forceCollide<GraphNode>().radius((d) => radius(d) + 6),
    )
    .force("x", d3force.forceX(width / 2).strength(0.04))
    .force("y", d3force.forceY(height / 2).strength(0.04));

  // Links.
  const linkSel = linkLayer
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("class", "link")
    .attr("stroke-linecap", "round");

  // Nodes.
  const nodeSel = nodeLayer
    .selectAll("g")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", (d) => `node group-${sanitizeGroup(d.group)}${d.degree >= 5 ? " big" : ""}`);

  nodeSel
    .append("circle")
    .attr("r", radius);

  nodeSel
    .append("text")
    .attr("dy", (d) => -radius(d) - 6)
    .attr("text-anchor", "middle")
    .text((d) => d.title || d.label);

  // Drag behavior.
  const dragBehavior = d3drag
    .drag<SVGGElement, GraphNode>()
    .on("start", (event, d) => {
      if (!event.active) sim.alphaTarget(0.25).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on("end", (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
  nodeSel.call(dragBehavior);

  // Zoom / pan.
  const zoomBehavior = d3zoom
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 4])
    .on("zoom", (event) => {
      root.attr("transform", event.transform.toString());
    });
  svg.call(zoomBehavior);

  // Hover highlighting.
  nodeSel
    .on("mouseenter", function (_event, d) {
      const neighbors = adjacency.get(d.id) ?? new Set();
      nodeSel.classed("dim", (n) => n.id !== d.id && !neighbors.has(n.id));
      nodeSel.classed("highlight", (n) => n.id === d.id);
      linkSel.classed("dim", (l) => {
        const s = (l.source as GraphNode).id ?? (l.source as string);
        const t = (l.target as GraphNode).id ?? (l.target as string);
        return s !== d.id && t !== d.id;
      });
      linkSel.classed("highlight", (l) => {
        const s = (l.source as GraphNode).id ?? (l.source as string);
        const t = (l.target as GraphNode).id ?? (l.target as string);
        return s === d.id || t === d.id;
      });
    })
    .on("mouseleave", () => {
      nodeSel.classed("dim", false).classed("highlight", false);
      linkSel.classed("dim", false).classed("highlight", false);
    })
    .on("click", (_event, d) => {
      opts.onNodeClick?.(d);
    });

  // Tick.
  sim.on("tick", () => {
    linkSel
      .attr("x1", (d) => (d.source as GraphNode).x!)
      .attr("y1", (d) => (d.source as GraphNode).y!)
      .attr("x2", (d) => (d.target as GraphNode).x!)
      .attr("y2", (d) => (d.target as GraphNode).y!);

    nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  // Teardown fn — stops the simulation and clears the SVG.
  return () => {
    sim.stop();
    svg.selectAll("*").remove();
  };
}

function sanitizeGroup(g: string): string {
  if (g === "concepts" || g === "entities" || g === "summaries") return g;
  return "other";
}
