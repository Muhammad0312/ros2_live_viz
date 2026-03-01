cmake_minimum_required(VERSION 3.8)
project(ros2_live_viz)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# =============================================================================
# Dependencies
# =============================================================================
find_package(ament_cmake REQUIRED)
find_package(ament_cmake_python REQUIRED)
find_package(rclcpp REQUIRED)
find_package(std_msgs REQUIRED)
find_package(ament_index_cpp REQUIRED)

# System: Boost Beast/ASIO for the WebSocket server
find_package(Boost REQUIRED COMPONENTS system thread)

# =============================================================================
# Include Directories
# =============================================================================
include_directories(
  include
  ${Boost_INCLUDE_DIRS}
)

# -----------------------------------------------------------------------------
# C++ Core Backend Engine (Phase 3)
# -----------------------------------------------------------------------------
add_executable(live_viz_backend src/backend_node.cpp)
target_include_directories(live_viz_backend PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
target_link_libraries(live_viz_backend ${Boost_LIBRARIES} pthread)
ament_target_dependencies(live_viz_backend
  rclcpp
  std_msgs
  ament_index_cpp
)


# =============================================================================
# Install: C++ Executables
# =============================================================================
install(TARGETS
  live_viz_backend
  DESTINATION lib/${PROJECT_NAME}
)

# =============================================================================
# Install: C++ Headers
# =============================================================================
install(DIRECTORY include/
  DESTINATION include
)

# =============================================================================
# Install: Python Module
# =============================================================================
ament_python_install_package(${PROJECT_NAME})

# =============================================================================
# Install: Web Frontend Assets (served by the C++ backend at runtime)
# =============================================================================
install(DIRECTORY web/
  DESTINATION share/${PROJECT_NAME}/web
)

# =============================================================================
# Testing
# =============================================================================
if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  set(ament_cmake_copyright_FOUND TRUE)
  set(ament_cmake_cpplint_FOUND TRUE)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
