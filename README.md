# ros2_live_viz

High-performance ROS 2 live observability tool that merges **static launch-tree introspection** with **real-time graph polling** and **zero-copy Hz telemetry**. Unlike traditional visualizers that only show you the current state of the network, `ros2_live_viz` reconciles *what you intended to launch* (the Intent Tree) with *what is actually running* (the Live Graph), giving you instant visibility into missing, extra, or misbehaving nodes.

## Features

- **Intent vs. Live Reconciliation**: Compares your launch file's declared nodes against the actual ROS 2 computation graph in real time.
- **Real-Time Graph Polling**: A compiled C++ backend polls the ROS 2 graph at 2 Hz via `rclcpp`, detecting node additions and removals with sub-millisecond latency.
- **Zero-Copy Hz Telemetry**: Monitor topic publish rates in real time using `rclcpp::GenericSubscription` without deserializing messages — only atomic byte/message counters are incremented.
- **Parameter Inspection**: Click any node in the dashboard to fetch and display its active parameters via the ROS 2 parameter service.
- **WebSocket Push Architecture**: All data (graph deltas, Hz metrics, parameters) is pushed to the browser over a low-latency WebSocket — no polling from the frontend.
- **Offline Dashboard**: The web frontend ships with all dependencies (D3.js, Alpine.js) vendored locally. No internet connection required.
- **Safety Daemon**: A background thread monitors the parent Python process. If the launch exits or crashes, the C++ backend automatically shuts down — no orphan processes.
- **Namespace-Aware Layout**: Nodes are automatically grouped and separated by their ROS 2 namespace, with proportional column allocation.
- **`ros2 launch` Integration**: Seamlessly hooks into the standard `ros2 launch` command via the `--tree-live` flag.

## Architecture

```
ros2 launch <pkg> <file> --tree-live
        │
        ▼
┌──────────────────────────┐
│  Python CLI Extension    │  (ros2_live_viz/command/live_viz.py)
│  • Scans launch file     │
│  • Writes Intent Tree    │
│  • Spawns C++ backend    │
│  • Registers atexit hook │
└──────────┬───────────────┘
           │ subprocess.Popen
           ▼
┌──────────────────────────┐
│  C++ Backend             │  (src/backend_node.cpp)
│  • MultiThreadedExecutor │
│  • Graph Poller (2 Hz)   │
│  • WebSocket Server      │
│  • GenericSubscription   │
│    Hz Monitor            │
│  • Safety Daemon Thread  │
└──────────┬───────────────┘
           │ WebSocket (JSON)
           ▼
┌──────────────────────────┐
│  Web Dashboard           │  (web/index.html + app.js)
│  • D3.js Force Layout    │
│  • Alpine.js Reactivity  │
│  • Intent/Live Diffing   │
│  • Topic Hz Display      │
│  • Node Inspector Panel  │
└──────────────────────────┘
```

The package depends on [`ros2_launch_viz_core`](https://github.com/Muhammad0312/ros2_launch_viz_core) for the shared `LaunchTreeScanner` and `Wrappers` modules used to parse launch files into the Intent Tree.

## Installation

### Prerequisites

- ROS 2 Humble (or later)
- C++17 compiler
- `colcon` build tool

### Build

1. Clone the required repositories into your ROS 2 workspace:
   ```bash
   cd ~/ros2_ws/src
   git clone https://github.com/Muhammad0312/ros2_launch_viz_core.git
   git clone https://github.com/Muhammad0312/ros2_live_viz.git
   ```

2. Build all packages:
   ```bash
   cd ~/ros2_ws
   colcon build --packages-select ros2_launch_viz_core ros2_live_viz
   ```

3. Source your workspace:
   ```bash
   source install/setup.bash
   ```

## Usage

### Launch with Live Visualization

Add the `--tree-live` flag to any `ros2 launch` command:

```bash
ros2 launch <package_name> <launch_file> --tree-live
```

The terminal will print a clickable URL to the live dashboard:

```
[ros2_live_viz] Dashboard ready at http://localhost:<port>
```

Open that URL in any browser. The dashboard works fully offline — no CDN dependencies.

### Dashboard Controls

- **Zoom & Pan**: Scroll to zoom, click-and-drag on the background to pan.
- **Click a Node**: Opens the Inspector panel showing the node's publishers, subscribers, and parameters.
- **Search**: Use the top-left search bar to filter and highlight nodes by name.
- **Namespace Filtering**: Toggle namespaces on/off to focus on specific subsystems.
- **Fit View**: Press the fit-view button to auto-zoom to show all nodes.

### Node Status Indicators

| Visual | Meaning |
|--------|---------|
| Solid node | **Live** — Node is running and detected in the ROS 2 graph |
| Dashed, faded node | **Waiting** — Node was declared in the launch file but hasn't appeared yet |

## Package Structure

```
ros2_live_viz/
├── CMakeLists.txt                  # Hybrid ament_cmake_python build
├── package.xml                     # Package manifest
├── LICENSE                         # Apache-2.0
├── include/ros2_live_viz/
│   └── websocket_server.hpp        # Header-only WebSocket + HTTP server
├── src/
│   └── backend_node.cpp            # C++ backend (graph poller, Hz monitor, WS server)
├── ros2_live_viz/
│   ├── __init__.py
│   └── command/
│       ├── __init__.py
│       └── live_viz.py             # Python CLI extension (--tree-live)
├── web/
│   ├── index.html                  # Dashboard HTML + CSS
│   ├── app.js                      # D3.js graph renderer + Alpine.js state
│   └── vendor/
│       ├── alpine.min.js           # Vendored Alpine.js
│       └── d3.v7.min.js            # Vendored D3.js v7
├── setup.cfg                       # Python entry point registration
└── resource/
    └── ros2_live_viz               # ament resource index marker
```

## How It Works

1. **Prelaunch Hook** (`live_viz.py`): When `--tree-live` is passed, the Python extension scans the launch description using `LaunchTreeScanner` (from `ros2_launch_viz_core`) and produces the **Intent Tree** — a JSON representation of every node, group, and include declared in the launch file. This tree is written to a temp file.

2. **C++ Backend** (`backend_node.cpp`): The Python hook spawns the compiled C++ binary, passing the Intent Tree path and parent PID. The backend:
   - Starts a WebSocket + HTTP server on an ephemeral port.
   - Polls the ROS 2 graph every 500ms, computing deltas (added/removed nodes/topics/edges).
   - Pushes full graph state or deltas to all connected WebSocket clients.
   - Listens for `monitor` commands from the frontend to dynamically subscribe to topics and report Hz rates.
   - Runs a safety daemon that exits cleanly if the parent process dies.

3. **Web Dashboard** (`app.js`): The browser receives JSON graph payloads over the WebSocket and renders them using D3.js force-directed layout. The reconciler compares declared (Intent) nodes against discovered (Live) nodes and applies visual styling to indicate status.

## Dependencies

| Dependency | Type | Purpose |
|-----------|------|---------|
| `ros2_launch_viz_core` | Python (exec) | Shared launch file scanning logic |
| `rclcpp` | C++ | ROS 2 client library for graph queries |
| `std_msgs` | C++ | Standard message types |
| `ament_index_cpp` | C++ | Locating package share directories |
| `launch` / `launch_ros` | Python (exec) | Launch description processing |
| `ament_index_python` | Python (exec) | Locating package share directories |
| `ros2launch` | Python (exec) | CLI extension point |

## License

This project is licensed under the [Apache License 2.0](LICENSE).
