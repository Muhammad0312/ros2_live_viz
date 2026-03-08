// Copyright 2026
//
// live_viz_backend — High-performance C++ backend for ros2_live_viz.
//
// Architecture:
//   - MultiThreadedExecutor with a ROS node
//   - Safety daemon thread: monitors parent PID liveness
//   - Graph Poller: 2Hz timer that queries the node graph, computes deltas,
//     and pushes JSON updates to connected WebSocket clients
//   - Hz Monitor: lock-free EMA-based topic frequency measurement using
//     GenericSubscription in a MutuallyExclusive callback group
//   - Hybrid HTTP+WebSocket server serving the web frontend

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <signal.h>    // kill()
#include <sys/types.h> // pid_t

#include "ament_index_cpp/get_package_share_directory.hpp"
#include "rclcpp/generic_subscription.hpp"
#include "rclcpp/rclcpp.hpp"
#include "ros2_live_viz/websocket_server.hpp"
#include <rclcpp/parameter_client.hpp>

using namespace std::chrono_literals;

// CLI Argument Parser
struct CliArgs {
  int port = 0;
  pid_t ppid = 0;
};

static CliArgs parse_cli(int argc, char *argv[]) {
  CliArgs args;
  for (int i = 1; i < argc; ++i) {
    std::string arg(argv[i]);
    if (arg == "--port" && i + 1 < argc) {
      args.port = std::stoi(argv[++i]);
    } else if (arg == "--ppid" && i + 1 < argc) {
      args.ppid = static_cast<pid_t>(std::stol(argv[++i]));
    }
  }
  return args;
}

// LiveVizBackendNode
class LiveVizBackendNode : public rclcpp::Node {
public:
  LiveVizBackendNode(const CliArgs &cli, const std::string &web_root)
      : Node("live_viz_backend"), ws_server_(cli.port, web_root),
        ppid_(cli.ppid) {
    // ── Callback group for Hz subscriptions (isolated from graph poller) ──
    hz_callback_group_ = this->create_callback_group(
        rclcpp::CallbackGroupType::MutuallyExclusive);

    // ── WebSocket message handler (client → backend) ──
    ws_server_.set_message_handler(std::bind(&LiveVizBackendNode::on_ws_message,
                                             this, std::placeholders::_1));
    ws_server_.start();

    const auto actual_port = ws_server_.actual_port();
    RCLCPP_INFO(this->get_logger(),
                "live_viz_backend started | port=%u | ppid=%d", actual_port,
                static_cast<int>(ppid_));

    // Print the port to stdout so the Python launcher can capture it.
    std::cout << "LIVE_VIZ_PORT=" << actual_port << std::endl;

    // ── Graph Poller at 2 Hz ──
    graph_timer_ = this->create_wall_timer(
        500ms, std::bind(&LiveVizBackendNode::poll_graph, this));

    // ── Hz metrics push at 1 Hz ──
    hz_timer_ = this->create_wall_timer(
        1000ms, std::bind(&LiveVizBackendNode::push_hz_metrics, this));

    // ── Safety Daemon ──
    if (ppid_ > 0) {
      safety_thread_ = std::thread([this]() { safety_daemon(); });
    }
  }

  ~LiveVizBackendNode() {
    safety_running_.store(false, std::memory_order_relaxed);
    if (safety_thread_.joinable())
      safety_thread_.join();
    ws_server_.stop();
  }

private:
  // ── Server ──
  ros2_live_viz::WebSocketServer ws_server_;

  // ── Safety Daemon ──
  pid_t ppid_;
  std::atomic<bool> safety_running_{true};
  std::thread safety_thread_;

  // ── Graph Poller ──
  rclcpp::TimerBase::SharedPtr graph_timer_;

  // Previous graph state for delta computation
  struct GraphState {
    std::set<std::string> nodes;
    std::set<std::string> topics;
    std::set<std::pair<std::string, std::string>> edges; // {source, target}
  };
  GraphState prev_state_;
  int force_full_send_counter_{0};
  static constexpr int FORCE_FULL_SEND_INTERVAL =
      10; // Every 10 ticks = 5s at 2Hz

  // ── Hz Monitor ──
  rclcpp::TimerBase::SharedPtr hz_timer_;
  rclcpp::CallbackGroupType hz_cb_type_ = rclcpp::CallbackGroupType::Reentrant;
  rclcpp::CallbackGroup::SharedPtr hz_callback_group_;

  struct TopicMetrics {
    rclcpp::GenericSubscription::SharedPtr sub;
    std::atomic<uint64_t> msg_count{0};
    int64_t last_check_ns{0};
    double hz_ema{0.0};
    uint32_t tick_count{0}; // Warm-up counter for adaptive alpha
  };

  std::mutex metrics_mutex_;
  std::map<std::string, std::shared_ptr<TopicMetrics>> monitored_topics_;

  // Safety Daemon — checks parent liveness every 2 seconds

  void safety_daemon() {
    while (safety_running_.load(std::memory_order_relaxed)) {
      std::this_thread::sleep_for(2s);
      // kill(pid, 0) returns -1 with errno=ESRCH if process is dead
      if (kill(ppid_, 0) != 0) {
        RCLCPP_WARN(this->get_logger(),
                    "Parent process (PID %d) is dead. Shutting down.",
                    static_cast<int>(ppid_));
        std::exit(0);
      }
    }
  }

  // Graph Poller — queries node graph, computes delta, pushes JSON

  void poll_graph() {
    auto names_namespaces =
        this->get_node_graph_interface()->get_node_names_and_namespaces();

    RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                         "[poll] Discovered %zu nodes",
                         names_namespaces.size());

    if (names_namespaces.empty())
      return;

    GraphState current;
    std::vector<std::pair<std::string, std::string>> edge_list;

    for (const auto &nn : names_namespaces) {
      const std::string &node_name = nn.first;
      const std::string &node_ns = nn.second;

      // Canonical full name
      std::string fqn =
          node_ns + (node_ns.back() == '/' ? "" : "/") + node_name;
      if (fqn == "/")
        fqn = "root";
      current.nodes.insert(fqn);

      // Publishers
      auto pubs =
          this->get_node_graph_interface()
              ->get_publisher_names_and_types_by_node(node_name, node_ns);
      for (const auto &pub : pubs) {
        current.topics.insert(pub.first);
        current.edges.insert({fqn, pub.first});
        edge_list.emplace_back(fqn, pub.first);
      }

      // Subscribers
      auto subs =
          this->get_node_graph_interface()
              ->get_subscriber_names_and_types_by_node(node_name, node_ns);
      for (const auto &sub : subs) {
        current.topics.insert(sub.first);
        current.edges.insert({sub.first, fqn});
        edge_list.emplace_back(sub.first, fqn);
      }
    }

    // ── Delta Computation ──────────────────────────────────────────
    std::vector<std::string> added_nodes, removed_nodes;
    std::vector<std::string> added_topics, removed_topics;
    std::vector<std::pair<std::string, std::string>> added_edges, removed_edges;

    // Nodes
    for (const auto &n : current.nodes) {
      if (prev_state_.nodes.find(n) == prev_state_.nodes.end())
        added_nodes.push_back(n);
    }
    for (const auto &n : prev_state_.nodes) {
      if (current.nodes.find(n) == current.nodes.end())
        removed_nodes.push_back(n);
    }

    // Topics
    for (const auto &t : current.topics) {
      if (prev_state_.topics.find(t) == prev_state_.topics.end())
        added_topics.push_back(t);
    }
    for (const auto &t : prev_state_.topics) {
      if (current.topics.find(t) == current.topics.end())
        removed_topics.push_back(t);
    }

    // Edges
    for (const auto &e : current.edges) {
      if (prev_state_.edges.find(e) == prev_state_.edges.end())
        added_edges.push_back(e);
    }
    for (const auto &e : prev_state_.edges) {
      if (current.edges.find(e) == current.edges.end())
        removed_edges.push_back(e);
    }

    prev_state_ = current;

    // ── JSON Serialization (manual ostringstream — zero allocation) ──
    // Format: {"type":"graph","elements":[...],"delta":{...}}
    // On first message (prev was empty), send full state instead of delta.
    const bool is_initial =
        added_nodes.size() == current.nodes.size() && removed_nodes.empty();
    const bool has_changes = !added_nodes.empty() || !removed_nodes.empty() ||
                             !added_topics.empty() || !removed_topics.empty() ||
                             !added_edges.empty() || !removed_edges.empty();

    // Force a full resend every N ticks so new clients get current state
    force_full_send_counter_++;
    const bool force_resend =
        (force_full_send_counter_ >= FORCE_FULL_SEND_INTERVAL);
    if (force_resend)
      force_full_send_counter_ = 0;

    if (!has_changes && !is_initial && !force_resend)
      return;

    RCLCPP_INFO_THROTTLE(
        this->get_logger(), *this->get_clock(), 5000,
        "[poll] Broadcasting: %zu nodes, %zu topics, %zu edges (initial=%s)",
        current.nodes.size(), current.topics.size(), edge_list.size(),
        is_initial ? "true" : "false");

    std::ostringstream ss;
    ss << "{\"type\":\"graph\",";

    // Full elements array (for client reconciliation)
    ss << "\"elements\":[";
    bool first = true;

    // Nodes
    for (const auto &node : current.nodes) {
      if (!first)
        ss << ",";
      ss << "{\"data\":{\"id\":\"" << node << "\",\"name\":\"" << node
         << "\",\"type\":\"node\"}}";
      first = false;
    }

    // Topics
    for (const auto &topic : current.topics) {
      if (!first)
        ss << ",";
      ss << "{\"data\":{\"id\":\"" << topic << "\",\"name\":\"" << topic
         << "\",\"type\":\"topic\"}}";
      first = false;
    }

    // Edges
    for (const auto &edge : edge_list) {
      if (!first)
        ss << ",";
      std::string edge_id = edge.first + "_to_" + edge.second;
      ss << "{\"data\":{\"id\":\"" << edge_id << "\",\"source\":\""
         << edge.first << "\",\"target\":\"" << edge.second << "\"}}";
      first = false;
    }

    ss << "],";

    // Delta info
    ss << "\"delta\":{";
    ss << "\"added_nodes\":" << added_nodes.size()
       << ",\"removed_nodes\":" << removed_nodes.size()
       << ",\"added_topics\":" << added_topics.size()
       << ",\"removed_topics\":" << removed_topics.size()
       << ",\"added_edges\":" << added_edges.size()
       << ",\"removed_edges\":" << removed_edges.size();
    ss << "}";

    ss << "}";

    ws_server_.broadcast(ss.str());
  }

  // WebSocket Message Handler (client → backend)

  void on_ws_message(const std::string &msg) {
    // Parse: {"action":"monitor","topics":["/t1","/t2"]}
    // Lightweight manual parsing (no JSON library)
    if (msg.find("\"action\":\"monitor\"") != std::string::npos ||
        msg.find("\"action\": \"monitor\"") != std::string::npos) {
      std::vector<std::string> target_topics;
      auto pos = msg.find('[');
      if (pos == std::string::npos)
        return;

      auto end_pos = msg.find(']', pos);
      if (end_pos == std::string::npos)
        return;

      std::string list = msg.substr(pos + 1, end_pos - pos - 1);
      size_t start = 0;
      while ((start = list.find('"', start)) != std::string::npos) {
        size_t stop = list.find('"', start + 1);
        if (stop == std::string::npos)
          break;
        target_topics.push_back(list.substr(start + 1, stop - start - 1));
        start = stop + 1;
      }

      update_subscriptions(target_topics);
    } else if (msg.find("\"action\":\"get_parameters\"") != std::string::npos ||
               msg.find("\"action\": \"get_parameters\"") !=
                   std::string::npos) {
      auto pos = msg.find("\"node\"");
      if (pos != std::string::npos) {
        pos = msg.find('"', pos + 6);
        if (pos != std::string::npos) {
          auto end_pos = msg.find('"', pos + 1);
          if (end_pos != std::string::npos) {
            std::string target_node = msg.substr(pos + 1, end_pos - pos - 1);
            fetch_parameters_and_send(target_node);
          }
        }
      }
    }
  }

  void fetch_parameters_and_send(const std::string &target_node) {
    std::thread([this, target_node]() {
      try {
        auto client =
            std::make_shared<rclcpp::AsyncParametersClient>(this, target_node);
        if (!client->wait_for_service(std::chrono::seconds(2))) {
          RCLCPP_DEBUG(this->get_logger(),
                       "Parameter service not available for %s",
                       target_node.c_str());
          return;
        }
        auto list_future = client->list_parameters({}, 10);
        if (list_future.wait_for(std::chrono::seconds(2)) !=
            std::future_status::ready)
          return;

        auto list = list_future.get();
        if (list.names.empty())
          return;

        auto params_future = client->get_parameters(list.names);
        if (params_future.wait_for(std::chrono::seconds(2)) !=
            std::future_status::ready)
          return;

        auto params = params_future.get();

        std::ostringstream ss;
        ss << "{\"type\":\"parameters\",\"node\":\"" << target_node
           << "\",\"parameters\":{";
        bool first = true;
        for (const auto &p : params) {
          if (!first)
            ss << ",";
          std::string key = p.get_name();
          std::string val = p.value_to_string();

          auto escape_json = [](const std::string &s) {
            std::string res;
            for (char c : s) {
              if (c == '"')
                res += "\\\"";
              else if (c == '\\')
                res += "\\\\";
              else if (c == '\n')
                res += "\\n";
              else
                res += c;
            }
            return res;
          };
          ss << "\"" << escape_json(key) << "\":\"" << escape_json(val) << "\"";
          first = false;
        }
        ss << "}}";
        ws_server_.broadcast(ss.str());
      } catch (const std::exception &e) {
        RCLCPP_DEBUG(this->get_logger(), "Error fetching parameters for %s: %s",
                     target_node.c_str(), e.what());
      }
    }).detach();
  }

  // Hz Monitor — Dynamic GenericSubscription Management

  void update_subscriptions(const std::vector<std::string> &targets) {
    std::lock_guard<std::mutex> lock(metrics_mutex_);

    // Remove topics no longer monitored
    for (auto it = monitored_topics_.begin(); it != monitored_topics_.end();) {
      if (std::find(targets.begin(), targets.end(), it->first) ==
          targets.end()) {
        RCLCPP_INFO(this->get_logger(), "[Hz] Unsubscribing: %s",
                    it->first.c_str());
        it = monitored_topics_.erase(it);
      } else {
        ++it;
      }
    }

    // Add new topics
    auto topic_names_and_types = this->get_topic_names_and_types();
    for (const auto &t : targets) {
      if (monitored_topics_.count(t))
        continue;

      auto it = topic_names_and_types.find(t);
      if (it != topic_names_and_types.end() && !it->second.empty()) {
        auto m = std::make_shared<TopicMetrics>();
        m->last_check_ns =
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now().time_since_epoch())
                .count();

        try {
          rclcpp::SubscriptionOptions sub_opts;
          sub_opts.callback_group = hz_callback_group_;

          // --- QoS Auto-Matching ---
          // Query the publisher's actual QoS and adapt our subscription
          rclcpp::QoS matched_qos = rclcpp::SensorDataQoS().keep_last(1000);
          auto pub_info = this->get_publishers_info_by_topic(t);
          if (!pub_info.empty()) {
            const auto &pub_qos = pub_info[0].qos_profile();
            matched_qos.reliability(pub_qos.reliability());
            matched_qos.durability(pub_qos.durability());
            // If multiple publishers with potentially different QoS,
            // fall back to best-effort (compatible with everything)
            if (pub_info.size() > 1) {
              bool mixed = false;
              for (size_t i = 1; i < pub_info.size(); ++i) {
                if (pub_info[i].qos_profile().reliability() !=
                        pub_qos.reliability() ||
                    pub_info[i].qos_profile().durability() !=
                        pub_qos.durability()) {
                  mixed = true;
                  break;
                }
              }
              if (mixed) {
                matched_qos.best_effort();
                matched_qos.durability_volatile();
              }
            }
            RCLCPP_INFO(
                this->get_logger(),
                "[Hz] Matched QoS for %s: reliability=%s, durability=%s",
                t.c_str(),
                pub_qos.reliability() == rclcpp::ReliabilityPolicy::Reliable
                    ? "reliable"
                    : "best_effort",
                pub_qos.durability() == rclcpp::DurabilityPolicy::TransientLocal
                    ? "transient_local"
                    : "volatile");
          }

          m->sub = this->create_generic_subscription(
              t, it->second[0], matched_qos,
              // Zero deserialization: we only increment a counter
              [m](std::shared_ptr<rclcpp::SerializedMessage>) {
                m->msg_count.fetch_add(1, std::memory_order_relaxed);
              },
              sub_opts);

          monitored_topics_[t] = m;
          RCLCPP_INFO(this->get_logger(), "[Hz] Monitoring: %s  type: %s",
                      t.c_str(), it->second[0].c_str());
        } catch (const std::exception &e) {
          RCLCPP_ERROR(this->get_logger(), "[Hz] Failed to subscribe: %s — %s",
                       t.c_str(), e.what());
        }
      }
    }
  }

  // Hz Metrics Push — EMA drain at 1 Hz

  void push_hz_metrics() {
    std::lock_guard<std::mutex> lock(metrics_mutex_);
    if (monitored_topics_.empty())
      return;

    std::ostringstream ss;
    ss << "{\"type\":\"hz\",\"rates\":{";
    bool first = true;

    for (auto &[topic, m] : monitored_topics_) {
      const int64_t now_ns =
          std::chrono::duration_cast<std::chrono::nanoseconds>(
              std::chrono::steady_clock::now().time_since_epoch())
              .count();

      const double dt_s = (now_ns - m->last_check_ns) / 1e9;
      uint64_t count = m->msg_count.exchange(0, std::memory_order_relaxed);

      double current_hz = 0.0;
      if (dt_s > 0.0) {
        current_hz = count / dt_s;
      }

      // Adaptive EWMA with warm-up:
      // tick 1: α=1.0 (instant lock — accurate from the first second)
      // tick 2: α=0.5 (fast convergence)
      // tick 3+: α=0.3 (smooth steady-state)
      m->tick_count++;
      double alpha = (m->tick_count <= 1)   ? 1.0
                     : (m->tick_count <= 3) ? 0.5
                                            : 0.3;
      m->hz_ema = (alpha * current_hz) + ((1.0 - alpha) * m->hz_ema);
      m->last_check_ns = now_ns;

      // Strict floor if exactly 0 messages arrived in the last tick
      if (count == 0)
        m->hz_ema = 0.0;

      if (!first)
        ss << ",";
      ss << "\"" << topic << "\":";
      ss << std::fixed;
      ss.precision(1);
      ss << m->hz_ema;
      first = false;
    }

    ss << "}}";
    ws_server_.broadcast(ss.str());
  }
};

// Main
int main(int argc, char *argv[]) {
  // Parse our custom args before ROS strips them.
  CliArgs cli = parse_cli(argc, argv);

  rclcpp::init(argc, argv);

  // Resolve the web root securely using ament_index
  std::string web_root;
  try {
    web_root =
        ament_index_cpp::get_package_share_directory("ros2_live_viz") + "/web";
  } catch (const std::exception &e) {
    RCLCPP_ERROR(rclcpp::get_logger("live_viz_backend"),
                 "Failed to find package share directory: %s", e.what());
  }

  auto node = std::make_shared<LiveVizBackendNode>(cli, web_root);

  // MultiThreadedExecutor to handle the MutuallyExclusive Hz callback
  // group on a separate thread from the graph poller timer.
  rclcpp::executors::MultiThreadedExecutor executor;
  executor.add_node(node);

  RCLCPP_INFO(node->get_logger(),
              "MultiThreadedExecutor spinning. Web root: %s", web_root.c_str());

  executor.spin();
  rclcpp::shutdown();
  return 0;
}
