# Copyright 2026

"""Module for entity wrapper classes."""

import os
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Text
from typing import TYPE_CHECKING

from launch import LaunchContext
from launch import LaunchDescription
from launch.action import Action
from launch.actions import (
    DeclareLaunchArgument, ExecuteProcess, GroupAction, IncludeLaunchDescription,
    OpaqueFunction, SetEnvironmentVariable, SetLaunchConfiguration
)
from launch_ros.actions import (
    ComposableNodeContainer, LoadComposableNodes, Node, PushRosNamespace
)
from launch_ros.utilities import evaluate_parameters
from launch_ros.utilities import make_namespace_absolute
from launch_ros.utilities import prefix_namespace

if TYPE_CHECKING:
    from .scanner import LaunchTreeScanner


class EntityWrapper:
    """Base wrapper defining the structure for processing and visualizing launch entities."""

    def __init__(self, entity: Action, context: LaunchContext, scanner: 'LaunchTreeScanner') -> None:
        """
        Create an EntityWrapper.

        :param entity: The launch entity to wrap.
        :param context: The launch context to use for substitutions.
        :param scanner: The scanner instance to use for processing sub-entities.
        """
        self.entity = entity
        self.context = context
        self.scanner = scanner
        self.info: Dict[Text, Any] = {}
        self.children: List[Dict[Text, Any]] = []
        self.name: Text = self.entity.__class__.__name__
        self.node_type: Text = "unknown"

    def display(self) -> Dict[Text, Any]:
        """
        Defines how the entity should be visualized in the tree dictionary.

        :return: A dictionary representing the entity in the tree.
        """
        return {"name": self.name, "type": self.node_type, "children": self.children, "info": self.info}

    def process(self) -> None:
        """Extracts data, mutates state, or handles sub-entities."""
        pass


class GenericWrapper(EntityWrapper):
    """Wrapper for generic launch entities."""

    def process(self) -> None:
        """Process generic sub-entities."""
        if hasattr(self.entity, 'get_sub_entities'):
            for sub in self.entity.get_sub_entities():
                if isinstance(sub, LaunchDescription):
                    self.scanner.scan(sub)
                else:
                    self.scanner.process_entity(sub)


class SkippedWrapper(EntityWrapper):
    """Wrapper for entities that are skipped due to conditions."""

    def process(self) -> None:
        """Extract information about why the entity was skipped."""
        cond = self.entity.condition
        # Get raw expression string if possible
        expr_attr = next((a for a in dir(cond) if 'predicate_expression' in a or 'expression' in a), None)
        raw_expr = self.scanner.format_sub(getattr(cond, expr_attr)) if expr_attr else "Unknown"

        self.info["Reason"] = f"{cond.__class__.__name__}: {raw_expr}"

        desc = ""
        short_name = self.entity.__class__.__name__
        if isinstance(self.entity, Node):
            desc = self.scanner.format_sub(self.entity.node_executable)
            short_name = "Node"
        elif isinstance(self.entity, IncludeLaunchDescription):
            loc = getattr(self.entity.launch_description_source, '_LaunchDescriptionSource__location',
                          self.entity.launch_description_source.location)
            desc = os.path.basename(self.scanner.format_sub(loc))
            short_name = "Include"

        self.name = short_name
        self.node_type = "skipped"
        self.info["Skipped Details"] = desc

        self.scanner.current_stack[-1]["children"].append(self.display())


class IncludeWrapper(EntityWrapper):
    """Wrapper for IncludeLaunchDescription actions."""

    def process(self) -> None:
        """Simulate an include action and scan its description."""
        self.context._push_locals()
        self.context._push_launch_configurations()

        src = self.entity.launch_description_source
        display_loc = self.scanner.format_sub(getattr(src, '_LaunchDescriptionSource__location', src.location))

        # Capture arguments passed to the include
        resolved_args = []
        for k, v in self.entity.launch_arguments:
            k_str = self.scanner.format_sub(k)
            v_str = self.scanner.format_sub(v)
            resolved_args.append(f"{k_str} := {v_str}")
            # Mutate context so child scan can see them
            try:
                self.context.launch_configurations[k_str] = v_str
            except Exception as e:
                self.scanner.log(f"Failed to set launch config {k_str} in include: {e}")

        self.name = os.path.basename(display_loc)
        self.node_type = "include"
        self.info.update({"Full Path": display_loc, "Passed Arguments": resolved_args})

        node = self.display()
        self.scanner.current_stack[-1]["children"].append(node)
        self.scanner.current_stack.append(node)
        self.scanner.depth += 1

        try:
            ld = src.get_launch_description(self.context)
            self.scanner.scan(ld)
        except Exception as e:
            self.scanner.log(f"Error: {e}")

        self.scanner.depth -= 1
        self.scanner.current_stack.pop()
        self.context._pop_launch_configurations()
        self.context._pop_locals()


class GroupWrapper(EntityWrapper):
    """Wrapper for GroupAction actions."""

    def process(self) -> None:
        """Process entities within a group."""
        self.name = "Group"
        self.node_type = "group"
        node = self.display()
        self.scanner.current_stack[-1]["children"].append(node)
        self.scanner.current_stack.append(node)
        self.scanner.depth += 1

        for sub in self.entity.get_sub_entities():
            if isinstance(sub, LaunchDescription):
                self.scanner.scan(sub)
            else:
                self.scanner.process_entity(sub)

        self.scanner.depth -= 1
        self.scanner.current_stack.pop()


class NodeWrapper(EntityWrapper):
    """Wrapper for Node actions."""

    def process(self) -> None:
        """Extract node metadata like parameters and remappings."""
        # We try to force evaluation without actual execution
        try:
            self.entity._Node__substitutions_performed = False
            self.entity._perform_substitutions(self.context)
        except Exception as e:
            self.scanner.log(f"Substitutions performance failed for {self.name}: {e}")

        pkg = self.scanner.format_sub(self.entity.node_package)
        exe = self.scanner.format_sub(self.entity.node_executable)

        ns = self.context.launch_configurations.get('ros_namespace', '/')
        node_ns = getattr(self.entity, '_Node__node_namespace', None)
        if node_ns:
            ns = make_namespace_absolute(prefix_namespace(ns, self.scanner.format_sub(node_ns)))

        node_name = getattr(self.entity, '_Node__node_name', None)
        name = make_namespace_absolute(prefix_namespace(ns, self.scanner.format_sub(node_name))) if node_name else f"{ns}/<default>"

        self.name = os.path.basename(name)
        self.node_type = "node"
        self.info.update({
            "Package": pkg, "Executable": exe, "Full Name": name,
            "Namespace": ns, "Parameters": [], "Remappings": []
        })

        # Evaluate parameters
        try:
            params = getattr(self.entity, '_Node__parameters', []) or []
            for p in evaluate_parameters(self.context, params):
                if isinstance(p, dict):
                    for k, v in p.items():
                        self.info["Parameters"].append(f"{k}: {v}")
                else:
                    self.info["Parameters"].append(str(p))
        except Exception as e:
            self.scanner.log(f"Param evaluation failed for node {self.name}: {e}")

        # Expanded remappings
        remaps = getattr(self.entity, '_Node__expanded_remappings', []) or []
        for src, dst in remaps:
            self.info["Remappings"].append(f"{src} -> {dst}")

        node_vis = self.display()
        self.scanner.current_stack[-1]["children"].append(node_vis)

        # Handle Composable Containers
        if isinstance(self.entity, ComposableNodeContainer):
            self.scanner.current_stack.append(node_vis)
            self.scanner.depth += 1
            for cn in getattr(self.entity, '_ComposableNodeContainer__composable_node_descriptions', []) or []:
                self.scanner.handle_composable_node(cn, ns)
            self.scanner.depth -= 1
            self.scanner.current_stack.pop()


class LoadComposableNodesWrapper(EntityWrapper):
    """Wrapper for LoadComposableNodes actions."""

    def process(self) -> None:
        """Process composable nodes loaded into a container."""
        self.name = "LoadComponents"
        self.node_type = "group"
        node = self.display()
        self.scanner.current_stack[-1]["children"].append(node)
        self.scanner.current_stack.append(node)
        self.scanner.depth += 1

        for cn in getattr(self.entity, '_LoadComposableNodes__composable_node_descriptions', []) or []:
            self.scanner.handle_composable_node(cn, self.context.launch_configurations.get('ros_namespace', '/'))

        self.scanner.depth -= 1
        self.scanner.current_stack.pop()


class OpaqueFunctionWrapper(EntityWrapper):
    """Wrapper for OpaqueFunction actions."""

    def process(self) -> None:
        """Execute the opaque function and scan the yielded entities."""
        try:
            sub_entities = self.entity.execute(self.context)
            if sub_entities:
                for sub in sub_entities:
                    if isinstance(sub, LaunchDescription):
                        self.scanner.scan(sub)
                    else:
                        self.scanner.process_entity(sub)
        except Exception as e:
            self.scanner.log(f"OpaqueFunction execution failed: {e}")


class PushNamespaceWrapper(EntityWrapper):
    """Wrapper for PushRosNamespace actions."""

    def process(self) -> None:
        """Execute and log namespace changes."""
        old = self.context.launch_configurations.get('ros_namespace', '/')
        self.entity.execute(self.context)
        new = self.context.launch_configurations.get('ros_namespace', '/')
        self.scanner.tree_data.setdefault("info", {}).setdefault("Namespace Changes", []).append(f"{old} -> {new}")


class StateMutationWrapper(EntityWrapper):
    """Wrapper for actions that mutate launch state (Args, Env, Config)."""

    def process(self) -> None:
        """Execute the state mutation action."""
        try:
            if isinstance(self.entity, DeclareLaunchArgument):
                self.entity.execute(self.context)
            elif isinstance(self.entity, SetLaunchConfiguration):
                self.entity.execute(self.context)
            elif isinstance(self.entity, SetEnvironmentVariable):
                self.entity.execute(self.context)
            else:
                self.entity.execute(self.context)
        except Exception as e:
            self.scanner.log(f"State mutation failed for {self.entity.__class__.__name__}: {e}")


class ExecuteProcessWrapper(EntityWrapper):
    """Wrapper for ExecuteProcess actions."""

    def process(self) -> None:
        """Capture the command line of a process execution."""
        cmd = ' '.join([self.scanner.format_sub(x) for x in self.entity.cmd])
        self.name = os.path.basename(cmd.split(' ')[0])
        self.node_type = "process"
        self.info["Full Command"] = cmd
        self.scanner.current_stack[-1]["children"].append(self.display())
