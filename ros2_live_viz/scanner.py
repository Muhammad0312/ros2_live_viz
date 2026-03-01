# Copyright 2026

"""Module for LaunchTreeScanner class."""

import os
import sys
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Text

from launch import LaunchContext
from launch import LaunchDescription
from launch.action import Action
from launch.actions import (
    AppendEnvironmentVariable, DeclareLaunchArgument, ExecuteProcess,
    GroupAction, IncludeLaunchDescription, OpaqueFunction,
    PopEnvironment, PopLaunchConfigurations, PushEnvironment,
    PushLaunchConfigurations, ResetEnvironment,
    ResetLaunchConfigurations, SetEnvironmentVariable, SetLaunchConfiguration
)
from launch_ros.actions import (
    LoadComposableNodes, Node, PushRosNamespace, SetParameter,
    SetParametersFromFile, SetRemap
)
from launch_ros.descriptions import ComposableNode
from launch.utilities import normalize_to_list_of_substitutions
from launch.utilities import perform_substitutions
from launch_ros.utilities import evaluate_parameters
from launch_ros.utilities import make_namespace_absolute
from launch_ros.utilities import prefix_namespace

from .wrappers import (
    ExecuteProcessWrapper, GenericWrapper, GroupWrapper,
    IncludeWrapper, LoadComposableNodesWrapper, NodeWrapper,
    OpaqueFunctionWrapper, PushNamespaceWrapper, SkippedWrapper,
    StateMutationWrapper
)


class LaunchTreeScanner:
    """Core logic for simulating and scanning a ROS 2 Launch hierarchy."""

    def __init__(
        self,
        context: Optional[LaunchContext] = None,
        verbose: bool = False
    ) -> None:
        """
        Create a LaunchTreeScanner.

        :param context: The launch context to use for substitutions.
        :param verbose: If True, print debug information to stderr.
        """
        self.context = context or LaunchContext()
        # Default namespace for ROS 2
        self.context.launch_configurations.setdefault('ros_namespace', '/')
        self.depth = 0
        self.verbose = verbose

        # Canonical Data Structure for the tree
        self.tree_data: Dict[Text, Any] = {
            "name": "Launch Root",
            "type": "root",
            "children": [],
            "info": {}
        }
        self.current_stack: List[Dict[Text, Any]] = [self.tree_data]

    def log(self, msg: Text, symbol: Text = "├── ") -> None:
        """
        Log a message to stderr if verbose mode is enabled.

        :param msg: The message to log.
        :param symbol: The symbol to use for the tree structure.
        """
        if self.verbose:
            print(f"{'    ' * self.depth}{symbol}{msg}", file=sys.stderr)

    def format_sub(self, sub: Any) -> Text:
        """
        Safely perform substitutions on launch objects.

        :param sub: The object to perform substitutions on.
        :return: The substituted text.
        """
        if sub is None:
            return ""
        if isinstance(sub, str):
            return sub
        try:
            return perform_substitutions(self.context, normalize_to_list_of_substitutions(sub))
        except Exception as e:
            try:
                # Fallback to description if evaluation fails
                parts = []
                for s in normalize_to_list_of_substitutions(sub):
                    desc = s.describe()
                    if "object at 0x" in desc:
                        if hasattr(s, 'text'):
                            desc = f"'{s.text}'"
                        elif hasattr(s, 'variable_name'):
                            desc = f"$(var {self.format_sub(s.variable_name)})"
                        elif hasattr(s, 'package'):
                            desc = f"$(find-pkg-share {self.format_sub(s.package)})"
                    parts.append(desc)
                return "".join(parts)
            except Exception as e2:
                self.log(f"Sub-evaluation failed: {e} -> {e2}")
                return str(sub)

    def scan(self, ld: LaunchDescription) -> Dict[Text, Any]:
        """
        The entry point to scan a launch description.

        :param ld: The launch description to scan.
        :return: The generated tree data dictionary.
        """
        for entity in ld.entities:
            self.process_entity(entity)
        return self.tree_data

    def process_entity(self, entity: Action) -> None:
        """
        Dispatches an entity to its specific wrapper for processing.

        :param entity: The entity to process.
        """
        if not isinstance(entity, Action):
            return

        # Condition Check
        if hasattr(entity, 'condition') and entity.condition and not entity.condition.evaluate(self.context):
            wrapper = SkippedWrapper(entity, self.context, self)
        elif isinstance(entity, IncludeLaunchDescription):
            wrapper = IncludeWrapper(entity, self.context, self)
        elif isinstance(entity, GroupAction):
            wrapper = GroupWrapper(entity, self.context, self)
        elif isinstance(entity, Node):
            wrapper = NodeWrapper(entity, self.context, self)
        elif isinstance(entity, LoadComposableNodes):
            wrapper = LoadComposableNodesWrapper(entity, self.context, self)
        elif isinstance(entity, OpaqueFunction):
            wrapper = OpaqueFunctionWrapper(entity, self.context, self)
        elif isinstance(entity, PushRosNamespace):
            wrapper = PushNamespaceWrapper(entity, self.context, self)
        elif isinstance(entity, (SetEnvironmentVariable, AppendEnvironmentVariable, DeclareLaunchArgument,
                                 SetLaunchConfiguration, PushLaunchConfigurations, PopLaunchConfigurations,
                                 PushEnvironment, PopEnvironment, ResetEnvironment, ResetLaunchConfigurations,
                                 SetRemap, SetParameter, SetParametersFromFile)):
            wrapper = StateMutationWrapper(entity, self.context, self)
        elif isinstance(entity, ExecuteProcess):
            wrapper = ExecuteProcessWrapper(entity, self.context, self)
        else:
            wrapper = GenericWrapper(entity, self.context, self)

        wrapper.process()

    def handle_composable_node(self, cn: ComposableNode, ns: Text) -> None:
        """
        Special handler for composable nodes inside containers.

        :param cn: The composable node description.
        :param ns: The current namespace.
        """
        pkg, plugin = self.format_sub(cn.package), self.format_sub(cn.node_plugin)
        node_ns = self.format_sub(cn.node_namespace) if cn.node_namespace else None
        if node_ns:
            ns = make_namespace_absolute(prefix_namespace(ns, node_ns))

        node_name = self.format_sub(cn.node_name) if cn.node_name else "<default>"
        name = make_namespace_absolute(prefix_namespace(ns, node_name))

        self.log(f"ComposableNode: {pkg}/{plugin} (name={name})", symbol="│   ├── ")

        node_info: Dict[Text, Any] = {
            "Package": pkg,
            "Plugin": plugin,
            "Full Name": name,
            "Namespace": ns,
            "Parameters": []
        }

        try:
            for p in evaluate_parameters(self.context, cn.parameters or []):
                if isinstance(p, dict):
                    for k, v in p.items():
                        node_info["Parameters"].append(f"{k}: {v}")
                else:
                    node_info["Parameters"].append(str(p))
        except Exception as e:
            self.log(f"Param evaluation failed for {name}: {e}")

        self.current_stack[-1]["children"].append({
            "name": os.path.basename(name),
            "type": "composable_node",
            "children": [],
            "info": node_info
        })
