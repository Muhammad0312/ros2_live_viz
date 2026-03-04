# Copyright 2026

"""CLI extension for ros2 launch: --tree-live flag.

This module implements an OptionExtension that intercepts the
``ros2 launch`` CLI to:
  1. Run the LaunchTreeScanner to produce the **Intent Tree** (static).
  2. Write the Intent Tree to a temporary JSON file.
  3. Spawn the compiled C++ ``live_viz_backend`` binary as a subprocess.
  4. Register an ``atexit`` hook to ensure the backend is terminated
     when the launch process exits.

The C++ backend is passed:
  --port 0       → bind to an OS-assigned ephemeral port
  --ppid <pid>   → parent PID for the safety daemon
  --intent-file  → path to the temporary Intent Tree JSON
"""

import atexit
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
from typing import Any, Text, Tuple

from ament_index_python.packages import get_package_share_directory
from launch import LaunchContext, LaunchDescription
from ros2launch.api.api import parse_launch_arguments
from ros2launch.option import OptionExtension

from ..scanner import LaunchTreeScanner


class LiveVizOption(OptionExtension):
    """Extension to 'ros2 launch' for live visualization."""

    NAME = 'tree_live'
    EXTENSION_POINT_VERSION = '0.1'

    def __init__(self) -> None:
        """Create a LiveVizOption."""
        super().__init__()
        self._backend_proc = None
        self._intent_file = None

    def add_arguments(self, parser: Any, cli_name: Text) -> None:
        """
        Add command line arguments for live visualization.

        :param parser: The argument parser to add arguments to.
        :param cli_name: The name of the CLI command.
        """
        group = parser.add_argument_group('Live Visualization Options')
        group.add_argument(
            '--tree-live', action='store_true',
            help='Launch the live visualization backend alongside the ROS 2 launch'
        )

    def prelaunch(
        self,
        launch_description: LaunchDescription,
        args: Any
    ) -> Tuple[LaunchDescription]:
        """
        Interact with the launch description before the actual launch.

        When --tree-live is active:
          1. Scan the launch description to extract the Intent Tree.
          2. Write the Intent Tree to a temporary JSON file.
          3. Spawn the C++ live_viz_backend as a background subprocess.
          4. Register an atexit hook to kill the subprocess on exit.

        :param launch_description: The launch description to process.
        :param args: The parsed CLI arguments.
        :return: A tuple containing the (unmodified) launch description.
        """
        if not getattr(args, 'tree_live', False):
            return (launch_description,)

        print(
            '\n[ros2_live_viz] --tree-live active. '
            'Scanning launch hierarchy...',
            file=sys.stderr
        )

        # ── 1. Build simulation context ──────────────────────────────────
        context = LaunchContext(argv=args.launch_arguments)
        try:
            context.launch_configurations.update(
                parse_launch_arguments(args.launch_arguments)
            )
        except Exception:
            pass

        # ── 2. Scan → Intent Tree ────────────────────────────────────────
        scanner = LaunchTreeScanner(context=context, verbose=False)
        tree_data = scanner.scan(launch_description)

        # ── 3. Write Intent Tree to temp JSON ────────────────────────────
        fd, intent_path = tempfile.mkstemp(
            prefix=f'intent_tree_{os.getpid()}_',
            suffix='.json'
        )
        with os.fdopen(fd, 'w') as f:
            json.dump(tree_data, f)
        self._intent_file = intent_path

        print(
            f'[ros2_live_viz] Intent tree written to {intent_path}',
            file=sys.stderr
        )

        # ── 4. Locate the compiled C++ backend ───────────────────────────
        pkg_prefix = get_package_share_directory('ros2_live_viz')
        backend_exe = os.path.join(
            os.path.dirname(pkg_prefix),
            '..', 'lib', 'ros2_live_viz', 'live_viz_backend'
        )
        backend_exe = os.path.normpath(backend_exe)

        if not os.path.isfile(backend_exe):
            print(
                f'[ros2_live_viz] ERROR: Backend executable not found at '
                f'{backend_exe}',
                file=sys.stderr
            )
            return (launch_description,)

        # ── 5. Spawn the C++ backend ─────────────────────────────────────
        cmd = [
            backend_exe,
            '--port', '0',
            '--ppid', str(os.getpid()),
            '--intent-file', intent_path,
        ]

        self._backend_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )

        # ── 6. Read the ephemeral port from stdout ───────────────────────
        port = None
        for line in self._backend_proc.stdout:
            decoded = line.decode('utf-8', errors='replace').strip()
            if decoded.startswith('LIVE_VIZ_PORT='):
                port = decoded.split('=', 1)[1]
                break

        if port:
            print(
                f'\n\033[1;32m[ros2_live_viz]\033[0m Dashboard ready at '
                f'\033[1;4mhttp://localhost:{port}\033[0m\n',
                file=sys.stderr
            )
        else:
            print(
                '[ros2_live_viz] WARNING: Could not determine backend port.',
                file=sys.stderr
            )

        # ── 7. Drain remaining stdout to a log file in background ────────
        def _drain_stdout(proc, log_path):
            try:
                with open(log_path, 'w') as log_f:
                    for line in proc.stdout:
                        log_f.write(line.decode('utf-8', errors='replace'))
                        log_f.flush()
            except Exception:
                pass

        drain_thread = threading.Thread(
            target=_drain_stdout,
            args=(self._backend_proc, '/tmp/live_viz_backend.log'),
            daemon=True
        )
        drain_thread.start()

        # ── 8. Register atexit hook ──────────────────────────────────────
        atexit.register(self._cleanup)

        print(
            f'[ros2_live_viz] Backend running (PID {self._backend_proc.pid}). '
            f'Continuing with normal launch...',
            file=sys.stderr
        )

        # Do NOT exit — let the launch proceed normally.
        return (launch_description,)

    def _cleanup(self) -> None:
        """Terminate the C++ backend subprocess and remove the temp file."""
        if self._backend_proc is not None:
            try:
                # Graceful SIGTERM first
                self._backend_proc.send_signal(signal.SIGTERM)
                try:
                    self._backend_proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    # Force kill if it doesn't respond
                    self._backend_proc.kill()
                    self._backend_proc.wait(timeout=2)
                print(
                    '[ros2_live_viz] Backend terminated.',
                    file=sys.stderr
                )
            except Exception as e:
                print(
                    f'[ros2_live_viz] Backend cleanup error: {e}',
                    file=sys.stderr
                )
            self._backend_proc = None

        if self._intent_file is not None:
            try:
                os.unlink(self._intent_file)
            except OSError:
                pass
            self._intent_file = None
