/**
 * ros2_live_viz V2 App - D3.js Force Layout & SVG Rendering
 */

document.addEventListener('alpine:init', () => {
    Alpine.data('DashboardApp', () => ({
        connected: false,
        port: window.location.port || '8080',
        ws: null,
        metrics: { nodes: 0, topics: 0, edges: 0 },
        monitorHz: false,
        topicHz: {},
        searchQuery: '',

        // Reconciler State
        graphData: { nodes: [], links: [] },
        nodeMap: new Map(), // Keep track of node metadata
        linkMap: new Map(),

        // D3 State
        svg: null,
        g: null,
        simulation: null,
        zoom: null,

        // Interaction State
        inspectorOpen: false,
        selectedNode: null,
        selectedChain: new Set(), // Set of node IDs in the current selection chain
        activeLinkIds: new Set(), // Set of "source->target" link IDs strictly between chain nodes
        neighborLinkIds: new Set(), // Links touching a chain node's neighbors but not the chain itself

        init() {
            this.initD3();
            this.connectWs();
        },

        connectWs() {
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            this.ws = new WebSocket(`${proto}//${window.location.hostname}:${this.port}`);

            this.ws.onopen = () => {
                this.connected = true;
                console.log('[WS] Connected');
            };

            this.ws.onclose = () => {
                this.connected = false;
                this.topicHz = {};
                console.log('[WS] Disconnected, retrying in 2s...');
                setTimeout(() => this.connectWs(), 2000);
            };

            this.ws.onmessage = (event) => {
                const payload = JSON.parse(event.data);
                if (payload.type === 'graph') {
                    this.reconcileGraph(payload);
                } else if (payload.type === 'hz') {
                    // Update Alpine state without breaking object reference
                    const newHz = { ...this.topicHz };
                    for (const [topic, hz] of Object.entries(payload.rates || {})) {
                        newHz[topic] = hz;
                    }
                    this.topicHz = newHz;
                }
            };
        },

        // --------------------------------------------------------------------
        // RECONCILER (Implicit Edges)
        // --------------------------------------------------------------------
        reconcileGraph(payload) {
            const elements = payload.elements || [];

            // If it's a delta update with no changes, we can skip rebuild
            // UNLESS we currently have 0 nodes, which means we just connected and this is our baseline send!
            if (!payload.initial && this.graphData.nodes.length > 0 &&
                (payload.delta?.added_nodes === 0 &&
                    payload.delta?.removed_nodes === 0 &&
                    payload.delta?.added_edges === 0 &&
                    payload.delta?.removed_edges === 0)) {
                return;
            }

            const topicCount = new Set();
            const incomingNodeIds = new Set();
            const ignoredTopics = ['/rosout', '/parameter_events'];

            // First pass: Construct or clear Nodes
            elements.forEach(el => {
                const d = el.data;
                if (!d.source && d.type === 'node') {
                    if (d.id.includes('live_viz_backend')) return;
                    incomingNodeIds.add(d.id);
                    if (!this.nodeMap.has(d.id)) {
                        this.nodeMap.set(d.id, { id: d.id, pubs: [], subs: [] });
                    } else {
                        // Clear them so we completely rebuild the edges cleanly
                        const node = this.nodeMap.get(d.id);
                        node.pubs = [];
                        node.subs = [];
                    }
                }
            });

            // Remove stale nodes (so D3 simulation drops them gracefully)
            for (const [id, node] of this.nodeMap.entries()) {
                if (!incomingNodeIds.has(id)) {
                    this.nodeMap.delete(id);
                }
            }

            // Second pass: Populate Node edges (Pubs/Subs)
            elements.forEach(el => {
                const d = el.data;
                if (d.source) {
                    if (ignoredTopics.includes(d.target) || ignoredTopics.includes(d.source)) return;

                    if (this.nodeMap.has(d.source)) {
                        this.nodeMap.get(d.source).pubs.push(d.target);
                        topicCount.add(d.target);
                    } else if (this.nodeMap.has(d.target)) {
                        this.nodeMap.get(d.target).subs.push(d.source);
                        topicCount.add(d.source);
                    }
                }
            });

            // Deduplicate pubs and subs to avoid Alpine x-for key collisions
            for (const node of this.nodeMap.values()) {
                node.pubs = [...new Set(node.pubs)];
                node.subs = [...new Set(node.subs)];
            }

            // Rebuild D3 array from map while preserving object references!
            this.graphData.nodes = Array.from(this.nodeMap.values());
            this.graphData.links = [];
            this.linkMap.clear();

            // Direct edges: If A publishes topic X, and B subscribes to X -> Draw A to B
            const pubMap = new Map(); // topic -> [Node IDs]
            const subMap = new Map(); // topic -> [Node IDs]

            this.graphData.nodes.forEach(n => {
                n.pubs.forEach(topic => {
                    if (!pubMap.has(topic)) pubMap.set(topic, []);
                    pubMap.get(topic).push(n.id);
                });
                n.subs.forEach(topic => {
                    if (!subMap.has(topic)) subMap.set(topic, []);
                    subMap.get(topic).push(n.id);
                });
            });

            // Synthesize Links
            for (const [topic, publishers] of pubMap.entries()) {
                if (subMap.has(topic)) {
                    const subscribers = subMap.get(topic);
                    publishers.forEach(pub => {
                        subscribers.forEach(sub => {
                            if (pub !== sub) { // Avoid self loops for cleanliness
                                const linkId = `${pub}->${sub}`;
                                if (!this.linkMap.has(linkId)) {
                                    const link = { source: pub, target: sub, id: linkId, topics: [topic] };
                                    this.linkMap.set(linkId, link);
                                    this.graphData.links.push(link);
                                } else {
                                    this.linkMap.get(linkId).topics.push(topic);
                                }
                            }
                        });
                    });
                }
            }

            this.metrics.nodes = this.graphData.nodes.length;
            this.metrics.topics = topicCount.size;
            this.metrics.edges = this.graphData.links.length;

            // Recalculate Proportional Column Allocations (Max 16 Columns)
            this.recalculateColumnAllocations();

            this.updateD3();
        },

        recalculateColumnAllocations() {
            const totalCols = 16;
            const totalNodes = Math.max(1, this.graphData.nodes.length);

            // Determine which nodes actually have active connections in the graph
            const connectedSet = new Set();
            this.graphData.links.forEach(l => {
                connectedSet.add(typeof l.source === 'object' ? l.source.id : l.source);
                connectedSet.add(typeof l.target === 'object' ? l.target.id : l.target);
            });

            let popPub = 0, popSub = 0, popMix = 0;
            this.graphData.nodes.forEach(n => {
                n.isOrphan = !connectedSet.has(n.id);
                const hash = n.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

                if ((n.pubs.length > 0 && n.subs.length === 0 && !n.isOrphan) || (n.isOrphan && hash % 2 === 0)) popPub++;
                else if ((n.subs.length > 0 && n.pubs.length === 0 && !n.isOrphan) || (n.isOrphan && hash % 2 !== 0)) popSub++;
                else popMix++;
            });

            // Distribute proportionally, minimum 1 column if nodes exist
            let cPub = Math.max(popPub > 0 ? 1 : 0, Math.round((popPub / totalNodes) * totalCols));
            let cSub = Math.max(popSub > 0 ? 1 : 0, Math.round((popSub / totalNodes) * totalCols));
            let cMix = Math.max(popMix > 0 ? 1 : 0, Math.round((popMix / totalNodes) * totalCols));

            // Ensure exactly 16 columns used
            const diff = totalCols - (cPub + cSub + cMix);
            if (diff !== 0) {
                // Adjust the largest bucket to absorb rounding error
                if (cMix >= cPub && cMix >= cSub) cMix += diff;
                else if (cPub >= cSub) cPub += diff;
                else cSub += diff;
            }

            // Ensure we don't drop below 0 due to extreme diff adjustments
            cPub = Math.max(0, cPub);
            cSub = Math.max(0, cSub);
            cMix = Math.max(0, cMix);

            this.layoutAllocations = { cPub, cMix, cSub, totalCols };
        },

        // --------------------------------------------------------------------
        // D3.js RENDERING
        // --------------------------------------------------------------------
        initD3() {
            // Add custom styles for animated data flow and ports
            const style = document.createElement('style');
            style.innerHTML = `
                .flow-line {
                    stroke-dasharray: 6 6;
                    animation: dashFlow 0.8s linear infinite;
                    opacity: 0.6;
                }
                .flow-line.highlight {
                    opacity: 1.0 !important;
                    stroke: #80deea !important; /* Softer Cyan/Teal glow */
                    stroke-width: 3px !important;
                }
                @keyframes dashFlow {
                    from { stroke-dashoffset: 12; }
                    to { stroke-dashoffset: 0; }
                }
            `;
            document.head.appendChild(style);

            const width = window.innerWidth;
            const height = window.innerHeight;

            this.zoom = d3.zoom()
                .scaleExtent([0.1, 8])
                .on("zoom", (event) => {
                    this.g.attr("transform", event.transform);
                });

            this.svg = d3.select("#viz").call(this.zoom);
            this.g = this.svg.append("g");

            // Define arrow marker for directed edges
            this.svg.append("defs").append("marker")
                .attr("id", "arrowhead")
                .attr("viewBox", "-0 -5 10 10")
                .attr("refX", 0) // Adjusted dynamically in tick function
                .attr("refY", 0)
                .attr("orient", "auto")
                .attr("markerWidth", 5)
                .attr("markerHeight", 5)
                .attr("xoverflow", "visible")
                .append("svg:path")
                .attr("d", "M 0,-5 L 10 ,0 L 0,5")
                .attr("fill", "rgba(255,255,255,0.2)")
                .style("stroke", "none");

            this.simulation = d3.forceSimulation()
                .alphaDecay(0.04) // Slower decay for extreme domain
                .force("link", d3.forceLink().id(d => d.id).distance(2200).strength(0.05))
                .force("x", d3.forceX(d => {
                    const maxWidth = 8000;
                    const leftBoundary = -maxWidth / 2;
                    const rightBoundary = maxWidth / 2;

                    // Fallback in case init is called before parse
                    const { cPub, cMix, cSub, totalCols } = this.layoutAllocations || { cPub: 3, cMix: 10, cSub: 3, totalCols: 16 };
                    const colStep = maxWidth / totalCols;

                    const hash = d.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

                    // 1. Publisher-like (and half of isolated/disconnected)
                    if ((d.pubs.length > 0 && d.subs.length === 0 && !d.isOrphan) || (d.isOrphan && hash % 2 === 0)) {
                        if (cPub === 0) return leftBoundary;
                        const col = (hash % cPub);
                        return leftBoundary + (col * colStep);
                    }

                    // 2. Subscriber-like (and half of isolated/disconnected)
                    if ((d.subs.length > 0 && d.pubs.length === 0 && !d.isOrphan) || (d.isOrphan && hash % 2 !== 0)) {
                        if (cSub === 0) return rightBoundary;
                        const col = (hash % cSub);
                        return rightBoundary - (col * colStep);
                    }

                    // 3. Mixed/Processing
                    if (cMix === 0) return leftBoundary + (cPub * colStep);
                    const col = (hash % cMix);
                    return leftBoundary + (cPub * colStep) + (col * colStep);
                }).strength(1.8))
                .force("y", d3.forceY(0).strength(0.005)) // Near-zero vertical pull
                .force("center", d3.forceCenter(width / 2, height / 2))
                .force("collide", d3.forceCollide().radius(250).iterations(3));

            // Window resize handler
            window.addEventListener('resize', () => {
                this.simulation.force("center", d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2));
                this.simulation.alpha(0.3).restart();
            });

            // Background click clears selection
            this.svg.on('click', (event) => {
                if (event.target.tagName === 'svg') {
                    this.clearSelection();
                }
            });
        },

        calculateNodeWidth(id) {
            return Math.max(160, (id.length * 7) + 40);
        },

        updateD3() {
            const headerH = 24;
            const bodyH = 32;

            // --- LINKS ---
            let link = this.g.selectAll(".link")
                .data(this.graphData.links, d => d.id);

            link.exit().remove();

            const linkEnter = link.enter().insert("path", ".node") // Insert paths before nodes so they draw underneath
                .attr("class", "link")
                .attr("marker-end", "url(#arrowhead)");

            link = linkEnter.merge(link);

            // --- NODES ---
            let node = this.g.selectAll(".node")
                .data(this.graphData.nodes, d => d.id);

            node.exit().remove();

            const nodeEnter = node.enter().append("g")
                .attr("class", "node")
                .call(d3.drag()
                    .on("start", (event, d) => this.dragstarted(event, d))
                    .on("drag", (event, d) => this.dragged(event, d))
                    .on("end", (event, d) => this.dragended(event, d)))
                .on("click", (event, d) => {
                    event.stopPropagation();
                    this.handleNodeClick(d);
                });

            // Node Body Background
            nodeEnter.append('rect')
                .attr('class', 'node-body-bg')
                .attr('x', d => -this.calculateNodeWidth(d.id) / 2)
                .attr('y', -(headerH + bodyH) / 2)
                .attr('width', d => this.calculateNodeWidth(d.id))
                .attr('height', headerH + bodyH);

            // Node Header Background
            nodeEnter.append('rect')
                .attr('class', 'node-header-bg')
                .attr('x', d => -this.calculateNodeWidth(d.id) / 2)
                .attr('y', -(headerH + bodyH) / 2)
                .attr('width', d => this.calculateNodeWidth(d.id))
                .attr('height', headerH);

            // Type Indicator Dot (Top Left)
            nodeEnter.append('circle')
                .attr('class', 'type-indicator')
                .attr('cx', d => -this.calculateNodeWidth(d.id) / 2 + 12)
                .attr('cy', (-(headerH + bodyH) / 2) + 12)
                .attr('r', 4)
                .style("fill", "var(--node-node)");

            // Type Label (Top Header)
            nodeEnter.append('text')
                .attr('class', 'node-type-label')
                .attr("x", d => -this.calculateNodeWidth(d.id) / 2 + 22)
                .attr("y", (-(headerH + bodyH) / 2) + 16)
                .text("NODE");

            // Name Text (Centered in Body)
            nodeEnter.append('text')
                .attr('class', 'node-name')
                .attr("x", d => -this.calculateNodeWidth(d.id) / 2 + 12)
                .attr("y", (-(headerH + bodyH) / 2) + headerH + 20)
                .text(d => {
                    const parts = d.id.split('/');
                    return parts[parts.length - 1]; // Just show the basename
                });

            node = nodeEnter.merge(node);

            // Update Simulation Data
            this.simulation.nodes(this.graphData.nodes).on("tick", () => {
                // Curved Bezier Links from Right Edge to Left Edge
                link.attr("d", d => {
                    const wS = this.calculateNodeWidth(d.source.id);
                    const wT = this.calculateNodeWidth(d.target.id);
                    const sx = d.source.x + (wS / 2); // Right edge of source
                    const sy = d.source.y;
                    const tx = d.target.x - (wT / 2) - 8; // Left edge of target (offset for arrowhead)
                    const ty = d.target.y;

                    const dx = tx - sx;
                    // Horizontal Cubic Bezier for modern Node-Graph aesthetic
                    return `M${sx},${sy} C${sx + Math.max(100, Math.abs(dx) / 2)},${sy} ${tx - Math.max(100, Math.abs(dx) / 2)},${ty} ${tx},${ty}`;
                });

                // Marker is statically assigned
                link.attr("marker-end", "url(#arrowhead)");

                // Move nodes
                node.attr("transform", d => `translate(${d.x},${d.y})`);
            });

            this.simulation.force("link").links(this.graphData.links);

            // Only re-heat physics engine if the graph structure genuinely changed (prevents 5s polling loop jitter)
            if (this._lastNodeCount !== this.graphData.nodes.length || this._lastEdgeCount !== this.graphData.links.length) {
                this.simulation.alpha(0.6).restart();
                this._lastNodeCount = this.graphData.nodes.length;
                this._lastEdgeCount = this.graphData.links.length;
            }

            // Re-apply highlighting if there's an active selection
            this.applyHighlighting();
        },

        // --- Drag Callbacks ---
        dragstarted(event, d) {
            // Dragging should just move the node locally without waking up whole physics simulator
            d.fx = d.x;
            d.fy = d.y;
        },
        dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        },
        dragended(event, d) {
            if (!event.active) this.simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        },

        // --------------------------------------------------------------------
        // CHAINED SELECTION & INTERACTION
        // --------------------------------------------------------------------
        handleNodeClick(d) {
            // Toggle removal: If node is already in the chain, remove it
            if (this.selectedChain.has(d.id)) {
                this.selectedChain.delete(d.id);

                if (this.selectedChain.size === 0) {
                    this.clearSelection();
                    return;
                }

                // If we removed the actively inspected node, shift focus to the last remaining node in the chain
                if (this.selectedNode && this.selectedNode.id === d.id) {
                    const remainingNodeId = Array.from(this.selectedChain).pop();
                    this.selectedNode = this.graphData.nodes.find(n => n.id === remainingNodeId);
                    if (this.selectedNode) {
                        this.requestHzTelemetry(this.selectedNode);
                    } else {
                        this.inspectorOpen = false;
                    }
                }

                this.recomputeChainLinks();
                this.applyHighlighting();
                return;
            }

            // If the user clicks a node NOT in the current chain's immediate neighborhood, reset the chain
            if (this.selectedChain.size > 0 && !this.selectedChain.has(d.id)) {
                // Need to check if 'd' is a neighbor of any node currently in the chain
                let isNeighbor = false;
                for (const link of this.graphData.links) {
                    if ((this.selectedChain.has(link.source.id) && link.target.id === d.id) ||
                        (this.selectedChain.has(link.target.id) && link.source.id === d.id)) {
                        isNeighbor = true;
                        break;
                    }
                }
                if (!isNeighbor) {
                    this.selectedChain.clear();
                    this.activeLinkIds.clear();
                }
            }

            // Add node to chain
            this.selectedChain.add(d.id);

            // Recompute active links (any link between two nodes where at least ONE is in the chain)
            // Wait, standard chained selection highlights the whole chain path.
            this.recomputeChainLinks();

            this.selectedNode = d;
            this.inspectorOpen = true;
            this.applyHighlighting();

            // Fire WebSocket request for telemetry
            this.requestHzTelemetry(d);
        },

        recomputeChainLinks() {
            this.activeLinkIds.clear();
            this.neighborLinkIds.clear();
            const neighbors = new Set();

            // First pass: Find all active links (touching the chain) and identify neighbor nodes
            this.graphData.links.forEach(l => {
                const sId = l.source.id;
                const tId = l.target.id;

                if (this.selectedChain.has(sId) || this.selectedChain.has(tId)) {
                    this.activeLinkIds.add(l.id);
                    neighbors.add(sId);
                    neighbors.add(tId);
                }
            });

            // Second pass: Find links that touch the neighbor nodes (but aren't active links)
            this.graphData.links.forEach(l => {
                if (!this.activeLinkIds.has(l.id)) {
                    if (neighbors.has(l.source.id) || neighbors.has(l.target.id)) {
                        this.neighborLinkIds.add(l.id);
                    }
                }
            });

            // If a node is in the selectedChain but has no connections back to the rest of the chain,
            // we should still mark it as a "neighbor" so it doesn't get dimmed.
            this.selectedChain.forEach(id => neighbors.add(id));

            return neighbors;
        },

        applyHighlighting() {
            const hasSelection = this.selectedChain.size > 0;
            const hasSearch = this.searchQuery.trim().length > 0;
            const searchLower = this.searchQuery.trim().toLowerCase();

            if (!hasSelection && !hasSearch) {
                // Reset all
                this.g.selectAll(".node")
                    .classed("dimmed", false)
                    .classed("highlight", false)
                    .classed("search-match", false);
                this.g.selectAll(".link")
                    .classed("dimmed", false)
                    .classed("highlight", false);
                return;
            }

            const visibleNodes = hasSelection ? this.recomputeChainLinks() : new Set(); // Nodes in chain + immediate neighbors

            this.g.selectAll(".node")
                .classed("dimmed", d => {
                    if (hasSelection) {
                        return !visibleNodes.has(d.id);
                    }
                    if (hasSearch) {
                        return !d.id.toLowerCase().includes(searchLower);
                    }
                    return false;
                })
                .classed("highlight", d => hasSelection && this.selectedNode && this.selectedNode.id === d.id)
                .classed("search-match", d => {
                    if (!hasSearch) return false;
                    // If there's a selection, the search highlight is overridden/secondary
                    return d.id.toLowerCase().includes(searchLower);
                });

            this.g.selectAll(".link")
                .classed("dimmed", d => {
                    if (hasSelection) {
                        return !this.activeLinkIds.has(d.id) && !this.neighborLinkIds.has(d.id);
                    }
                    if (hasSearch) {
                        // Dim links if doing a global search
                        return true;
                    }
                    return false;
                })
                .classed("highlight", d => hasSelection && this.activeLinkIds.has(d.id));
        },

        clearSelection() {
            this.selectedChain.clear();
            this.activeLinkIds.clear();
            this.neighborLinkIds.clear();
            this.selectedNode = null;
            this.inspectorOpen = false;
            this.applyHighlighting();
        },

        closeInspector() {
            this.clearSelection();
        },

        fitView() {
            if (!this.svg || this.graphData.nodes.length === 0) return;

            const bounds = this.g.node().getBBox();
            if (bounds.width === 0 || bounds.height === 0) return;

            const parent = this.svg.node().parentElement;
            const fullWidth = parent.clientWidth;
            const fullHeight = parent.clientHeight;

            const padding = 100; // Increased padding for a better aesthetic frame
            const targetWidth = bounds.width + padding * 2;
            const targetHeight = bounds.height + padding * 2;

            const scale = Math.min(fullWidth / targetWidth, fullHeight / targetHeight);
            const clampedScale = Math.max(0.05, Math.min(scale, 2));

            const midX = bounds.x + bounds.width / 2;
            const midY = bounds.y + bounds.height / 2;

            const translateX = fullWidth / 2 - clampedScale * midX;
            const translateY = fullHeight / 2 - clampedScale * midY;

            this.svg.transition().duration(750).call(
                this.zoom.transform,
                d3.zoomIdentity.translate(translateX, translateY).scale(clampedScale)
            );
        },

        // --------------------------------------------------------------------
        // HZ TELEMETRY (WebSocket)
        // --------------------------------------------------------------------
        toggleHz() {
            this.monitorHz = !this.monitorHz;
            if (this.monitorHz && this.selectedNode) {
                this.requestHzTelemetry(this.selectedNode);
            }
        },

        requestHzTelemetry(nodeObj) {
            if (!this.monitorHz || !this.connected) return;

            // Assemble all active topics in the chain
            const allTopics = new Set();

            // Just request for the currently selected node to avoid overwhelming the C++ backend
            nodeObj.pubs.forEach(t => allTopics.add(t));
            nodeObj.subs.forEach(t => allTopics.add(t));

            if (allTopics.size > 0) {
                this.ws.send(JSON.stringify({
                    action: 'monitor',
                    topics: Array.from(allTopics)
                }));
            }
        }
    }));
});
