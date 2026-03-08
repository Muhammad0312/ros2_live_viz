# Copyright 2026

"""CLI extension for ros2 launch: --tree-live flag.

This module implements an OptionExtension that intercepts the
``ros2 launch`` CLI to:
  1. Spawn the compiled C++ ``live_viz_backend`` binary as a subprocess.
  2. Register an ``atexit`` hook to ensure the backend is terminated
     when the launch process exits.

The C++ backend is passed:
  --port 0       → bind to an OS-assigned ephemeral port
  --ppid <pid>   → parent PID for the safety daemon
"""

import atexit
import os
import signal
import subprocess
import sys
import threading
from typing import Any, Text, Tuple

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from ros2launch.option import OptionExtension


class LiveVizOption(OptionExtension):
    """Extension to 'ros2 launch' for live visualization."""

    NAME = 'tree_live'
    EXTENSION_POINT_VERSION = '0.1'

    def __init__(self) -> None:
        """Create a LiveVizOption."""
        super().__init__()
        self._backend_proc = None

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
          1. Spawn the C++ live_viz_backend as a background subprocess.
          2. Register an atexit hook to kill the subprocess on exit.

        :param launch_description: The launch description to process.
        :param args: The parsed CLI arguments.
        :return: A tuple containing the (unmodified) launch description.
        """
        if not getattr(args, 'tree_live', False):
            return (launch_description,)

        print(
            '\n[ros2_live_viz] --tree-live active. '
            'Starting live visualization backend...',
            file=sys.stderr
        )

        # ── 1. Locate the compiled C++ backend ───────────────────────────
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

        # ── 2. Spawn the C++ backend ─────────────────────────────────────
        cmd = [
            backend_exe,
            '--port', '0',
            '--ppid', str(os.getpid()),
        ]

        self._backend_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )

        # ── 3. Read the ephemeral port from stdout ───────────────────────
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

        # ── 4. Drain remaining stdout to a log file in background ────────
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

        # ── 5. Register atexit hook ──────────────────────────────────────
        atexit.register(self._cleanup)

        print(
            f'[ros2_live_viz] Backend running (PID {self._backend_proc.pid}). '
            f'Continuing with normal launch...',
            file=sys.stderr
        )

        # Do NOT exit — let the launch proceed normally.
        return (launch_description,)

    def _cleanup(self) -> None:
        """Terminate the C++ backend subprocess."""
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
