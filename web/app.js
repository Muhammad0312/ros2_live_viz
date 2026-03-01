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
        nsLayout: new Map(), // Cached namespace layouts
        selectedNodeParams: {}, // Store parameters for the selected node

        // Namespace Filtering State
        allNamespaces: [],
        ignoredNamespaces: [],
        showFilterMenu: false,
        lastPayload: null,
        firstGraphLoad: true,

        toggleNamespace(ns) {
            if (this.ignoredNamespaces.includes(ns)) {
                this.ignoredNamespaces = this.ignoredNamespaces.filter(n => n !== ns);
            } else {
                this.ignoredNamespaces.push(ns);
            }
            this._lastFingerprint = null; // force rebuild
            if (this.lastPayload) {
                this.reconcileGraph(this.lastPayload);
            }
        },

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
            window.addEventListener("message", (e) => { if (e.data && e.data.type === "mock_ws") { const payload = JSON.parse(e.data.data); if (payload.type === "graph") this.reconcileGraph(payload); } });
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
                if (window.TEST_MODE) return;
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
                } else if (payload.type === 'parameters') {
                    if (this.selectedNode && this.selectedNode.id === payload.node) {
                        this.selectedNodeParams = payload.parameters;
                    }
                }
            };
        },

        // --------------------------------------------------------------------
        // RECONCILER (Implicit Edges)
        // --------------------------------------------------------------------
        reconcileGraph(payload) {
            this.lastPayload = payload;
            const elements = payload.elements || [];

            // Build a fingerprint of the incoming graph to detect actual structural changes
            const incomingFingerprint = elements
                .filter(el => !el.data.source && el.data.type === 'node' && !el.data.id.includes('live_viz_backend'))
                .map(el => el.data.id)
                .sort()
                .join('|');

            if (this._lastFingerprint && this._lastFingerprint === incomingFingerprint) {
                return; // Graph is structurally identical — skip the entire rebuild
            }
            this._lastFingerprint = incomingFingerprint;

            const topicCount = new Set();
            const incomingNodeIds = new Set();
            const ignoredTopics = ['/rosout', '/parameter_events'];

            // First pass: Construct or clear Nodes
            const discoveredNamespaces = new Set();
            elements.forEach(el => {
                const d = el.data;
                if (!d.source && d.type === 'node') {
                    if (d.id.includes('live_viz_backend')) return;

                    const parts = d.id.split('/');
                    const ns = parts.slice(0, -1).join('/') || '/';
                    discoveredNamespaces.add(ns);

                    if (this.ignoredNamespaces.includes(ns)) return;

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

            // Update global namespace list
            this.allNamespaces = Array.from(discoveredNamespaces).sort();

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

                    // Ensure neither side of the edge is in an ignored namespace (i.e., not in nodeMap)
                    if (!this.nodeMap.has(d.source) && !this.nodeMap.has(d.target)) return;

                    if (this.nodeMap.has(d.source)) {
                        this.nodeMap.get(d.source).pubs.push(d.target);
                        topicCount.add(d.target);
                    }
                    if (this.nodeMap.has(d.target)) {
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

            if (this.firstGraphLoad && this.graphData.nodes.length > 0) {
                this.firstGraphLoad = false;
                setTimeout(() => this.fitView(), 100);
            }
        },

        recalculateColumnAllocations() {
            const totalNodes = Math.max(1, this.graphData.nodes.length);

            // Determine which nodes actually have active connections
            const connectedSet = new Set();
            this.graphData.links.forEach(l => {
                connectedSet.add(typeof l.source === 'object' ? l.source.id : l.source);
                connectedSet.add(typeof l.target === 'object' ? l.target.id : l.target);
            });

            // Extract namespace, classify pub/sub/mix globally
            const nsNodes = new Map();
            let popPub = 0, popSub = 0, popMix = 0;
            this.graphData.nodes.forEach(n => {
                n.isOrphan = !connectedSet.has(n.id);
                const parts = n.id.split('/').filter(p => p.length > 0);
                n.namespace = parts.length > 1 ? parts[0] : '(root)';
                if (!nsNodes.has(n.namespace)) nsNodes.set(n.namespace, []);
                nsNodes.get(n.namespace).push(n);

                const hash = n.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                if ((n.pubs.length > 0 && n.subs.length === 0 && !n.isOrphan) || (n.isOrphan && hash % 2 === 0)) popPub++;
                else if ((n.subs.length > 0 && n.pubs.length === 0 && !n.isOrphan) || (n.isOrphan && hash % 2 !== 0)) popSub++;
                else popMix++;
            });

            // Build cross-namespace edge adjacency for ordering
            const nsEdges = new Map();
            const nodeNsMap = new Map();
            this.graphData.nodes.forEach(n => nodeNsMap.set(n.id, n.namespace));
            this.graphData.links.forEach(l => {
                const srcId = typeof l.source === 'object' ? l.source.id : l.source;
                const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
                const nsA = nodeNsMap.get(srcId), nsB = nodeNsMap.get(tgtId);
                if (nsA && nsB && nsA !== nsB) {
                    const key = [nsA, nsB].sort().join('|');
                    nsEdges.set(key, (nsEdges.get(key) || 0) + 1);
                }
            });

            // Greedy namespace ordering: minimize cross-namespace edge distance
            const allNs = [...nsNodes.keys()];
            const placed = [];
            const remaining = new Set(allNs);

            // Start with the namespace that has the most total cross-namespace edges
            const nsTotalEdges = new Map();
            allNs.forEach(ns => nsTotalEdges.set(ns, 0));
            for (const [key, count] of nsEdges) {
                const [a, b] = key.split('|');
                nsTotalEdges.set(a, (nsTotalEdges.get(a) || 0) + count);
                nsTotalEdges.set(b, (nsTotalEdges.get(b) || 0) + count);
            }
            const startNs = allNs.reduce((best, ns) =>
                (nsTotalEdges.get(ns) > nsTotalEdges.get(best)) ? ns : best, allNs[0]);
            placed.push(startNs);
            remaining.delete(startNs);

            while (remaining.size > 0) {
                let bestNs = null, bestScore = -1;
                for (const candidate of remaining) {
                    let score = 0;
                    for (const p of placed) {
                        const key = [candidate, p].sort().join('|');
                        score += nsEdges.get(key) || 0;
                    }
                    // Heavily weight adjacency to the most recently placed namespace
                    const lastPlaced = placed[placed.length - 1];
                    const adjKey = [candidate, lastPlaced].sort().join('|');
                    score += (nsEdges.get(adjKey) || 0) * 3;

                    if (score > bestScore) {
                        bestScore = score;
                        bestNs = candidate;
                    }
                }
                placed.push(bestNs);
                remaining.delete(bestNs);
            }

            // === TWO-COLUMN LAYOUT ===
            // Large namespaces stack vertically (main column)
            // Small namespaces stack vertically offset to the right
            const colWidth = 300;
            const nodesPerCol = 8;
            const smallThreshold = 8; // Namespaces with fewer nodes go to the right column
            const pxPerNode = 50;
            const minBandHeight = 400;

            // Split into Top 3 Center, and Remaining 4 Quadrants
            const sortedByCount = [...placed].sort((a, b) => nsNodes.get(b).length - nsNodes.get(a).length);
            const top3 = sortedByCount.slice(0, 3);
            const others = placed.filter(ns => !top3.includes(ns));

            const bottomLeft = [];
            const bottomRight = [];
            const topLeft = [];
            const topRight = [];
            others.forEach((ns, i) => {
                if (i % 4 === 0) bottomLeft.push(ns);
                else if (i % 4 === 1) bottomRight.push(ns);
                else if (i % 4 === 2) topLeft.push(ns);
                else topRight.push(ns);
            });

            // Global X grid for column width calculations
            const totalCols = Math.max(4, Math.ceil(totalNodes / nodesPerCol));
            let cPub = Math.max(popPub > 0 ? 1 : 0, Math.round((popPub / totalNodes) * totalCols));
            let cSub = Math.max(popSub > 0 ? 1 : 0, Math.round((popSub / totalNodes) * totalCols));
            let cMix = Math.max(popMix > 0 ? 1 : 0, Math.round((popMix / totalNodes) * totalCols));
            const diff = totalCols - (cPub + cSub + cMix);
            if (diff !== 0) {
                if (cMix >= cPub && cMix >= cSub) cMix += diff;
                else if (cPub >= cSub) cPub += diff;
                else cSub += diff;
            }
            cPub = Math.max(0, cPub); cSub = Math.max(0, cSub); cMix = Math.max(0, cMix);
            const mainWidth = totalCols * colWidth;

            this.layoutAllocations = { cPub, cMix, cSub, totalCols };
            this.namespaceBands = new Map();
            this.nsXOffset = new Map();
            this.nsAllocations = new Map();

            // Calculate per-namespace allocations for tighter grouping
            placed.forEach(ns => {
                const nodes = nsNodes.get(ns);
                const count = nodes.length;
                if (top3.includes(ns)) {
                    this.nsAllocations.set(ns, { cPub, cMix, cSub, totalCols, mainWidth });
                } else {
                    const nsCols = Math.max(2, Math.floor(totalCols / 2));
                    let nsPub = 0, nsSub = 0, nsMix = 0;
                    nodes.forEach(n => {
                        const hash = n.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                        if ((n.pubs.length > 0 && n.subs.length === 0 && !n.isOrphan) || (n.isOrphan && hash % 2 === 0)) nsPub++;
                        else if ((n.subs.length > 0 && n.pubs.length === 0 && !n.isOrphan) || (n.isOrphan && hash % 2 !== 0)) nsSub++;
                        else nsMix++;
                    });

                    let ncPub = Math.max(nsPub > 0 ? 1 : 0, Math.round((nsPub / count) * nsCols));
                    let ncSub = Math.max(nsSub > 0 ? 1 : 0, Math.round((nsSub / count) * nsCols));
                    let ncMix = Math.max(nsMix > 0 ? 1 : 0, Math.round((nsMix / count) * nsCols));
                    const nDiff = nsCols - (ncPub + ncSub + ncMix);
                    if (nDiff !== 0) {
                        if (ncMix >= ncPub && ncMix >= ncSub) ncMix += nDiff;
                        else if (ncPub >= ncSub) ncPub += nDiff;
                        else ncSub += nDiff;
                    }
                    ncPub = Math.max(0, ncPub); ncSub = Math.max(0, ncSub); ncMix = Math.max(0, ncMix);

                    // Give quadrants a bounding box spanning exactly half the center width (minus some padding)
                    const quadWidth = (mainWidth / 2) - 100;
                    this.nsAllocations.set(ns, { cPub: ncPub, cMix: ncMix, cSub: ncSub, totalCols: nsCols, mainWidth: quadWidth });
                }
            });

            // 1. Layout Center (Top 3)
            // Center namespaces span the full width (totalCols), so they need much less vertical space per node
            const centerHeights = top3.map(ns => {
                const count = nsNodes.get(ns).length;
                // Roughly group into rows using totalCols, adding a base height + row height
                const estimatedRows = Math.ceil(count / (totalCols / 2));
                return Math.max(300, estimatedRows * pxPerNode * 4);
            });
            const totalCenterHeight = centerHeights.reduce((a, b) => a + b, 0);

            let currentY = -totalCenterHeight / 2;
            top3.forEach((ns, i) => {
                this.namespaceBands.set(ns, currentY + centerHeights[i] / 2);
                this.nsXOffset.set(ns, 0); // Full width, center
                currentY += centerHeights[i];
            });

            const centerTopEdge = -totalCenterHeight / 2;
            const centerBottomEdge = totalCenterHeight / 2;
            const rowGap = 150;

            // The left and right quadrants perfectly span the left and right halves of the center block
            const quadXOffsetLeft = -mainWidth / 4 - 25;
            const quadXOffsetRight = mainWidth / 4 + 25;

            // 2. Layout Bottom Quadrants (Growing downwards from center Bottom)
            let bottomY = centerBottomEdge + rowGap;
            const maxBottomRows = Math.max(bottomLeft.length, bottomRight.length);
            for (let i = 0; i < maxBottomRows; i++) {
                const nsL = bottomLeft[i];
                const nsR = bottomRight[i];
                const hL = nsL ? Math.max(minBandHeight, nsNodes.get(nsL).length * pxPerNode) : 0;
                const hR = nsR ? Math.max(minBandHeight, nsNodes.get(nsR).length * pxPerNode) : 0;
                const rowH = Math.max(hL, hR);

                if (nsL) {
                    this.namespaceBands.set(nsL, bottomY + rowH / 2);
                    this.nsXOffset.set(nsL, quadXOffsetLeft);
                }
                if (nsR) {
                    this.namespaceBands.set(nsR, bottomY + rowH / 2);
                    this.nsXOffset.set(nsR, quadXOffsetRight);
                }
                bottomY += rowH + rowGap;
            }

            // 3. Layout Top Quadrants (Growing upwards from center Top)
            let topY = centerTopEdge - rowGap;
            const maxTopRows = Math.max(topLeft.length, topRight.length);
            for (let i = 0; i < maxTopRows; i++) {
                const nsL = topLeft[i];
                const nsR = topRight[i];
                const hL = nsL ? Math.max(minBandHeight, nsNodes.get(nsL).length * pxPerNode) : 0;
                const hR = nsR ? Math.max(minBandHeight, nsNodes.get(nsR).length * pxPerNode) : 0;
                const rowH = Math.max(hL, hR);

                if (nsL) {
                    this.namespaceBands.set(nsL, topY - rowH / 2);
                    this.nsXOffset.set(nsL, quadXOffsetLeft);
                }
                if (nsR) {
                    this.namespaceBands.set(nsR, topY - rowH / 2);
                    this.nsXOffset.set(nsR, quadXOffsetRight);
                }
                topY -= (rowH + rowGap);
            }

            // Save layout center bounds for separator rendering
            this.layoutCenterBounds = { top: centerTopEdge, bottom: centerBottomEdge };
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
                    stroke: #80deea !important;
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

            this._currentZoomScale = 1;
            this.zoom = d3.zoom()
                .scaleExtent([0.05, 8])
                .on("zoom", (event) => {
                    this.g.attr("transform", event.transform);
                    this._currentZoomScale = event.transform.k;
                    const targetScreenPx = 11;
                    const scaledSize = targetScreenPx / event.transform.k;
                    this.g.selectAll(".ns-label")
                        .attr("font-size", scaledSize + "px");
                });

            this.svg = d3.select("#viz").call(this.zoom);
            this.g = this.svg.append("g");

            // Define arrow marker for directed edges
            this.svg.append("defs").append("marker")
                .attr("id", "arrowhead")
                .attr("viewBox", "-0 -5 10 10")
                .attr("refX", 0)
                .attr("refY", 0)
                .attr("orient", "auto")
                .attr("markerWidth", 5)
                .attr("markerHeight", 5)
                .attr("xoverflow", "visible")
                .append("svg:path")
                .attr("d", "M 0,-5 L 10 ,0 L 0,5")
                .attr("fill", "rgba(255,255,255,0.2)")
                .style("stroke", "none");

            // Global X grid + per-namespace offset
            this._getTargetX = (d) => {
                const alloc = (this.nsAllocations && this.nsAllocations.get(d.namespace)) || this.layoutAllocations || { cPub: 3, cMix: 10, cSub: 3, totalCols: 16 };
                const { cPub, cMix, cSub, totalCols } = alloc;
                const colWidth = 300;
                const maxWidth = String(alloc.mainWidth) !== 'undefined' ? alloc.mainWidth : totalCols * colWidth;
                const leftBoundary = -maxWidth / 2;
                const rightBoundary = maxWidth / 2;
                const hash = d.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                const xOffset = (this.nsXOffset && this.nsXOffset.get(d.namespace)) || 0;

                let baseX;
                if ((d.pubs.length > 0 && d.subs.length === 0 && !d.isOrphan) || (d.isOrphan && hash % 2 === 0)) {
                    baseX = cPub === 0 ? leftBoundary : leftBoundary + ((hash % cPub) * colWidth);
                } else if ((d.subs.length > 0 && d.pubs.length === 0 && !d.isOrphan) || (d.isOrphan && hash % 2 !== 0)) {
                    baseX = cSub === 0 ? rightBoundary : rightBoundary - ((hash % cSub) * colWidth);
                } else {
                    baseX = cMix === 0 ? leftBoundary + (cPub * colWidth) : leftBoundary + (cPub * colWidth) + ((hash % cMix) * colWidth);
                }
                return baseX + xOffset;
            };

            // Namespace Y-band calculator
            this._getTargetY = (d) => {
                if (!this.namespaceBands || !d.namespace) return 0;
                return this.namespaceBands.get(d.namespace) || 0;
            };

            this.simulation = d3.forceSimulation()
                .alphaDecay(0.1)
                .force("link", d3.forceLink().id(d => d.id).distance(2200).strength(0.05))
                .force("x", d3.forceX(d => this._getTargetX(d)).strength(1.8))
                .force("y", d3.forceY(d => this._getTargetY(d)).strength(1.2))
                .force("collide", d3.forceCollide().radius(250).iterations(1))
                .stop(); // Do NOT auto-run — we compute positions synchronously

            // Background click clears selection
            this.svg.on('click', (event) => {
                if (event.target.tagName === 'svg') {
                    this.clearSelection();
                }
            });
        },

        calculateNodeWidth(id) {
            const parts = id.split('/');
            const name = parts[parts.length - 1] || id;
            return Math.max(160, (name.length * 8) + 50);
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

            // Detect if the layout changed
            const currentLayoutKey = this.nsLayout ?
                [...this.nsLayout.entries()].map(([ns, l]) => `${ns}:${l.cols}:${Math.round(l.xStart)}`).join(',') : '';
            const layoutChanged = this._prevLayoutKey !== currentLayoutKey;

            // Warm-start: assign positions from per-namespace grid and band
            this.graphData.nodes.forEach(d => {
                if (d.x == null || layoutChanged) {
                    d.x = this._getTargetX(d);
                    d.y = this._getTargetY(d);
                    d.fx = null;
                    d.fy = null;
                }
            });

            this._prevLayoutKey = currentLayoutKey;

            // Update Simulation Data
            this.simulation.nodes(this.graphData.nodes);
            this.simulation.force("link").links(this.graphData.links);

            // Re-compute layout whenever the graph structure changed
            const nodeCountChanged = this._lastNodeCount !== this.graphData.nodes.length;
            if (nodeCountChanged) {
                this.simulation.alpha(1);
                this.simulation.tick(300);
                this._lastNodeCount = this.graphData.nodes.length;
                this._lastEdgeCount = this.graphData.links.length;

                // Auto-fit viewport on first render
                if (!this._hasAutoFit) {
                    this._hasAutoFit = true;
                    setTimeout(() => this.fitView(), 50);
                }
            }
            // Render namespace separator lines per vertical column
            if (this.namespaceBands && this.namespaceBands.size > 1 && this.nsXOffset) {
                // Group namespaces into logical columns: Left, Center, Right
                const cols = new Map([
                    ['left', []],
                    ['center', []],
                    ['right', []]
                ]);
                const logicalExtents = new Map([
                    ['left', { minX: Infinity, maxX: 0 }],
                    ['center', { minX: Infinity, maxX: -Infinity }],
                    ['right', { minX: 0, maxX: -Infinity }]
                ]);

                // Determine bounding X per logical column
                this.graphData.nodes.forEach(d => {
                    const xOffset = this.nsXOffset.get(d.namespace) || 0;
                    const colKey = xOffset === 0 ? 'center' : (xOffset < 0 ? 'left' : 'right');
                    const ext = logicalExtents.get(colKey);
                    const w = this.calculateNodeWidth(d.id);
                    if (d.x - w / 2 < ext.minX) ext.minX = d.x - w / 2;
                    if (d.x + w / 2 > ext.maxX) ext.maxX = d.x + w / 2;
                });

                for (const [ns, xOffset] of this.nsXOffset.entries()) {
                    const colKey = xOffset === 0 ? 'center' : (xOffset < 0 ? 'left' : 'right');
                    cols.get(colKey).push({ ns, y: this.namespaceBands.get(ns) });
                }

                const padX = 200;
                const separators = []; // Horizontal lines
                const vSeparators = []; // Vertical central lines

                // Vertical axes (Top and Bottom only, do not cut through Center)
                const allYs = [...this.namespaceBands.values()];
                const minY = Math.min(...allYs) - 300;
                const maxY = Math.max(...allYs) + 300;

                if (this.layoutCenterBounds) {
                    if (minY < this.layoutCenterBounds.top) {
                        vSeparators.push({ id: 'v-axis-top', x: 0, y1: minY, y2: this.layoutCenterBounds.top });
                    }
                    if (maxY < this.layoutCenterBounds.bottom) { // Changed condition to check if maxY is below center bottom
                        vSeparators.push({ id: 'v-axis-bot', x: 0, y1: this.layoutCenterBounds.bottom, y2: maxY });
                    }
                }

                for (const [colKey, nsList] of cols.entries()) {
                    nsList.sort((a, b) => a.y - b.y);
                    const ext = logicalExtents.get(colKey);
                    const isLeft = colKey === 'left';
                    const isCenter = colKey === 'center';

                    for (let i = 0; i < nsList.length - 1; i++) {
                        const midY = (nsList[i].y + nsList[i + 1].y) / 2;
                        if (isCenter) {
                            separators.push({
                                id: `c-${i}`, y: midY,
                                x1: ext.minX - padX, x2: ext.maxX + padX
                            });
                        } else {
                            if (ext.minX === Infinity) continue;
                            separators.push({
                                id: `${colKey}-${i}`, y: midY,
                                // Draw from central axis outward to the edge of the nodes
                                x1: isLeft ? ext.minX - padX : 0,
                                x2: isLeft ? 0 : ext.maxX + padX
                            });
                        }
                    }
                }

                // Horizontal Separator lines
                let sepLine = this.g.selectAll(".ns-separator").data(separators, d => d.id);
                sepLine.exit().remove();
                const sepEnter = sepLine.enter().insert("line", ".link")
                    .attr("class", "ns-separator");
                sepLine = sepEnter.merge(sepLine);
                sepLine
                    .attr("x1", d => d.x1).attr("x2", d => d.x2)
                    .attr("y1", d => d.y).attr("y2", d => d.y);

                // Vertical Separator line
                let vSepLine = this.g.selectAll(".ns-v-separator").data(vSeparators, d => d.id);
                vSepLine.exit().remove();
                const vSepEnter = vSepLine.enter().insert("line", ".link")
                    .attr("class", "ns-v-separator");
                vSepLine = vSepEnter.merge(vSepLine);
                vSepLine
                    .attr("x1", d => d.x).attr("x2", d => d.x)
                    .attr("y1", d => d.y1).attr("y2", d => d.y2);

                // Namespace labels
                const labelData = [...this.namespaceBands.entries()].map(([ns, y]) => {
                    const xOffset = this.nsXOffset.get(ns) || 0;
                    const colKey = xOffset === 0 ? 'center' : (xOffset < 0 ? 'left' : 'right');
                    const ext = logicalExtents.get(colKey);
                    const isLeft = colKey === 'left';
                    const isCenter = colKey === 'center';

                    if (!ext || ext.minX === Infinity) return null;

                    return {
                        ns, y,
                        xPos: isLeft || isCenter ? ext.minX - padX - 20 : ext.maxX + padX + 20,
                        anchor: isLeft || isCenter ? "end" : "start"
                    };
                }).filter(Boolean);
                let nsLabel = this.g.selectAll(".ns-label").data(labelData, d => d.ns);
                nsLabel.exit().remove();
                const labelEnter = nsLabel.enter().insert("text", ".link")
                    .attr("class", "ns-label");
                nsLabel = labelEnter.merge(nsLabel);
                nsLabel
                    .attr("x", d => d.xPos)
                    .attr("y", d => d.y + 5)
                    .attr("text-anchor", d => d.anchor)
                    .text(d => `/${d.ns}`);
            }
            link.attr("d", d => {
                const wS = this.calculateNodeWidth(d.source.id);
                const wT = this.calculateNodeWidth(d.target.id);
                const sx = d.source.x + (wS / 2);
                const sy = d.source.y;
                const tx = d.target.x - (wT / 2) - 8;
                const ty = d.target.y;
                const dx = tx - sx;
                return `M${sx},${sy} C${sx + Math.max(100, Math.abs(dx) / 2)},${sy} ${tx - Math.max(100, Math.abs(dx) / 2)},${ty} ${tx},${ty}`;
            });
            link.attr("marker-end", "url(#arrowhead)");
            node.attr("transform", d => `translate(${d.x},${d.y})`);

            // Re-apply highlighting if there's an active selection
            this.applyHighlighting();
        },

        // --- Drag Callbacks (no simulation re-heat, direct position update) ---
        dragstarted(event, d) {
            d.fx = d.x;
            d.fy = d.y;
        },
        dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
            d.x = event.x;
            d.y = event.y;
            // Re-render this node and its connected edges immediately
            this.g.selectAll(".node").filter(n => n.id === d.id)
                .attr("transform", `translate(${d.x},${d.y})`);
            this.g.selectAll(".link").filter(l => l.source.id === d.id || l.target.id === d.id)
                .attr("d", l => {
                    const wS = this.calculateNodeWidth(l.source.id);
                    const wT = this.calculateNodeWidth(l.target.id);
                    const sx = l.source.x + (wS / 2);
                    const sy = l.source.y;
                    const tx = l.target.x - (wT / 2) - 8;
                    const ty = l.target.y;
                    const dx = tx - sx;
                    return `M${sx},${sy} C${sx + Math.max(100, Math.abs(dx) / 2)},${sy} ${tx - Math.max(100, Math.abs(dx) / 2)},${ty} ${tx},${ty}`;
                });
        },
        dragended(event, d) {
            // Pin the node where the user dropped it — no snap-back
            d.fx = event.x;
            d.fy = event.y;
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

                if (this.selectedNode && this.selectedNode.id === d.id) {
                    const remainingNodeId = Array.from(this.selectedChain).pop();
                    this.selectedNode = this.graphData.nodes.find(n => n.id === remainingNodeId);
                    this.selectedNodeParams = {};
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
            this.recomputeChainLinks();

            this.selectedNode = d;
            this.selectedNodeParams = {};
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
            this.inspectorOpen = false;
            this.selectedNode = null;
        },

        fitView() {
            if (!this.svg || this.graphData.nodes.length === 0) return;

            // Compute bounds from NODES ONLY (ignoring separators and labels)
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            this.graphData.nodes.forEach(d => {
                const w = this.calculateNodeWidth(d.id);
                if (d.x - w / 2 < minX) minX = d.x - w / 2;
                if (d.x + w / 2 > maxX) maxX = d.x + w / 2;
                if (d.y - 30 < minY) minY = d.y - 30;
                if (d.y + 30 > maxY) maxY = d.y + 30;
            });

            const boundsWidth = maxX - minX;
            const boundsHeight = maxY - minY;
            if (boundsWidth === 0 || boundsHeight === 0) return;

            const parent = this.svg.node().parentElement;
            const fullWidth = parent.clientWidth;
            const fullHeight = parent.clientHeight;

            const padding = 100;
            const scale = Math.min(
                fullWidth / (boundsWidth + padding * 2),
                fullHeight / (boundsHeight + padding * 2)
            );
            const clampedScale = Math.max(0.05, Math.min(scale, 2));

            const midX = minX + boundsWidth / 2;
            const midY = minY + boundsHeight / 2;

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
            this.topicHz = {}; // Clear old metrics
            this.selectedNodeParams = {}; // Clear old parameters

            // Request parameters
            if (this.ws && this.connected) {
                this.ws.send(JSON.stringify({
                    action: 'get_parameters',
                    node: nodeObj.id
                }));
            }

            const topicsToMonitor = [...nodeObj.pubs, ...nodeObj.subs].filter(t => !t.includes('parameter'));
            if (topicsToMonitor.length === 0) return;

            if (this.ws && this.connected && this.monitorHz) {
                this.ws.send(JSON.stringify({
                    action: 'monitor',
                    topics: topicsToMonitor
                }));
            }
        },
    }));
});

