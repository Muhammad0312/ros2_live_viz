#ifndef ROS2_LIVE_VIZ__WEBSOCKET_SERVER_HPP_
#define ROS2_LIVE_VIZ__WEBSOCKET_SERVER_HPP_

// ----------------------------------------------------------------------------
// Hybrid HTTP + WebSocket Server
//
// Boost.Beast based server that:
//   1. Serves static files from a configurable web root (HTTP GET).
//   2. Accepts WebSocket upgrades for real-time data streaming.
//   3. Supports port 0 (OS-assigned ephemeral port) with query.
//
// Ported from ros2_viz_suite and extended for ros2_live_viz.
// ----------------------------------------------------------------------------

#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/strand.hpp>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace beast     = boost::beast;
namespace http      = beast::http;
namespace websocket = beast::websocket;
namespace net       = boost::asio;
using tcp           = boost::asio::ip::tcp;

namespace ros2_live_viz {

// MIME type helper
inline std::string mime_type(const std::string& path)
{
    auto const ext = [&path]{
        auto const pos = path.rfind('.');
        if (pos == std::string::npos) return std::string{};
        return path.substr(pos);
    }();
    if (ext == ".html" || ext == ".htm") return "text/html";
    if (ext == ".css")  return "text/css";
    if (ext == ".js")   return "application/javascript";
    if (ext == ".json") return "application/json";
    if (ext == ".png")  return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".svg")  return "image/svg+xml";
    if (ext == ".ico")  return "image/x-icon";
    if (ext == ".woff2") return "font/woff2";
    if (ext == ".woff") return "font/woff";
    return "application/octet-stream";
}

// WebSocket Session
class WsSession : public std::enable_shared_from_this<WsSession> {
    websocket::stream<beast::tcp_stream> ws_;
    beast::flat_buffer buffer_;
    std::mutex queue_mutex_;
    std::queue<std::string> message_queue_;
    bool is_writing_{false};
    std::function<void(const std::string&)> message_handler_;
    std::string current_message_;

public:
    explicit WsSession(tcp::socket&& socket,
                       std::function<void(const std::string&)> handler)
        : ws_(std::move(socket)), message_handler_(handler) {}

    void run(http::request<http::string_body> req) {
        ws_.set_option(websocket::stream_base::timeout::suggested(
            beast::role_type::server));
        ws_.set_option(websocket::stream_base::decorator(
            [](websocket::response_type& res) {
                res.set(http::field::server,
                    std::string(BOOST_BEAST_VERSION_STRING) +
                    " ros2-live-viz");
            }));
        ws_.async_accept(
            req,
            beast::bind_front_handler(
                &WsSession::on_accept, shared_from_this()));
    }

    void on_accept(beast::error_code ec) {
        if (ec) {
            std::cerr << "[WsSession] Accept error: " << ec.message() << std::endl;
            return;
        }
        std::cerr << "[WsSession] Accepted, starting read loop" << std::endl;
        do_read();
    }

    void do_read() {
        ws_.async_read(buffer_,
            beast::bind_front_handler(
                &WsSession::on_read, shared_from_this()));
    }

    void on_read(beast::error_code ec, std::size_t /*bytes*/) {
        if (ec == websocket::error::closed) return;
        if (ec) return;

        if (message_handler_) {
            message_handler_(beast::buffers_to_string(buffer_.data()));
        }
        buffer_.consume(buffer_.size());
        do_read();
    }

    // Thread-safe send invoked from the ROS domain thread.
    void send_message(const std::string& message) {
        auto self = shared_from_this();
        std::lock_guard<std::mutex> lock(queue_mutex_);
        message_queue_.push(message);
        if (!is_writing_) {
            is_writing_ = true;
            net::post(ws_.get_executor(),
                [self]() { self->do_write(); });
        }
    }

private:
    void do_write() {
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            if (message_queue_.empty()) {
                is_writing_ = false;
                return;
            }
            current_message_ = message_queue_.front();
        }
        ws_.text(true);
        ws_.async_write(
            net::buffer(current_message_),
            beast::bind_front_handler(
                &WsSession::on_write, shared_from_this()));
    }

    void on_write(beast::error_code ec, std::size_t /*bytes*/) {
        if (ec) return;
        std::lock_guard<std::mutex> lock(queue_mutex_);
        message_queue_.pop();
        if (!message_queue_.empty()) {
            net::post(ws_.get_executor(),
                beast::bind_front_handler(
                    &WsSession::do_write, shared_from_this()));
        } else {
            is_writing_ = false;
        }
    }
};

// HTTP Session — serves static files OR upgrades to WebSocket
class HttpSession : public std::enable_shared_from_this<HttpSession> {
    beast::tcp_stream stream_;
    beast::flat_buffer buffer_;
    http::request<http::string_body> req_;
    std::string web_root_;
    std::function<void(const std::string&)> ws_handler_;
    std::function<void(std::shared_ptr<WsSession>)> ws_register_;

public:
    HttpSession(tcp::socket&& socket,
                std::string web_root,
                std::function<void(const std::string&)> ws_handler,
                std::function<void(std::shared_ptr<WsSession>)> ws_register)
        : stream_(std::move(socket))
        , web_root_(std::move(web_root))
        , ws_handler_(ws_handler)
        , ws_register_(ws_register) {}

    void run() { do_read(); }

private:
    void do_read() {
        req_ = {};
        stream_.expires_after(std::chrono::seconds(30));
        http::async_read(stream_, buffer_, req_,
            beast::bind_front_handler(
                &HttpSession::on_read, shared_from_this()));
    }

    void on_read(beast::error_code ec, std::size_t /*bytes*/) {
        if (ec == http::error::end_of_stream) return;
        if (ec) return;

        // WebSocket upgrade?
        if (websocket::is_upgrade(req_)) {
            auto ws = std::make_shared<WsSession>(
                stream_.release_socket(), ws_handler_);
            ws_register_(ws);
            ws->run(std::move(req_));
            return;
        }

        // Static file serving
        handle_http_request();
    }

    void handle_http_request() {
        std::string target(req_.target());

        // Default to index.html
        if (target == "/") target = "/index.html";

        // Security: reject path traversal
        if (target.find("..") != std::string::npos) {
            send_error(http::status::forbidden, "Forbidden");
            return;
        }

        std::string full_path = web_root_ + target;
        std::ifstream file(full_path, std::ios::binary);
        if (!file) {
            send_error(http::status::not_found, "Not Found");
            return;
        }

        std::ostringstream oss;
        oss << file.rdbuf();
        std::string body = oss.str();

        http::response<http::string_body> res{
            http::status::ok, req_.version()};
        res.set(http::field::server, "ros2-live-viz");
        res.set(http::field::content_type, mime_type(full_path));
        res.set(http::field::access_control_allow_origin, "*");
        res.keep_alive(req_.keep_alive());
        res.body() = std::move(body);
        res.prepare_payload();

        auto sp = std::make_shared<http::response<http::string_body>>(
            std::move(res));
        http::async_write(stream_, *sp,
            [self = shared_from_this(), sp](
                beast::error_code ec, std::size_t) {
                if (ec) return;
                if (!sp->keep_alive()) {
                    self->stream_.socket().shutdown(
                        tcp::socket::shutdown_send, ec);
                    return;
                }
                self->do_read();
            });
    }

    void send_error(http::status status, const std::string& msg) {
        http::response<http::string_body> res{status, req_.version()};
        res.set(http::field::server, "ros2-live-viz");
        res.set(http::field::content_type, "text/plain");
        res.keep_alive(req_.keep_alive());
        res.body() = msg;
        res.prepare_payload();

        auto sp = std::make_shared<http::response<http::string_body>>(
            std::move(res));
        http::async_write(stream_, *sp,
            [self = shared_from_this(), sp](
                beast::error_code ec, std::size_t) {
                self->stream_.socket().shutdown(
                    tcp::socket::shutdown_send, ec);
            });
    }
};

// Listener — accepts connections, dispatches to HTTP or WS
class Listener : public std::enable_shared_from_this<Listener> {
    net::io_context& ioc_;
    tcp::acceptor acceptor_;
    std::string web_root_;
    std::function<void(const std::string&)> ws_handler_;

    std::mutex sessions_mutex_;
    std::vector<std::weak_ptr<WsSession>> active_sessions_;

public:
    Listener(net::io_context& ioc, tcp::endpoint endpoint,
             std::string web_root,
             std::function<void(const std::string&)> ws_handler)
        : ioc_(ioc)
        , acceptor_(ioc)
        , web_root_(std::move(web_root))
        , ws_handler_(ws_handler)
    {
        beast::error_code ec;
        acceptor_.open(endpoint.protocol(), ec);
        if (ec) return;
        acceptor_.set_option(net::socket_base::reuse_address(true), ec);
        if (ec) return;
        acceptor_.bind(endpoint, ec);
        if (ec) return;
        acceptor_.listen(net::socket_base::max_listen_connections, ec);
        if (ec) return;
    }

    void run() { do_accept(); }

    /// Get the actual port the server is listening on (resolves port 0).
    unsigned short port() const {
        return acceptor_.local_endpoint().port();
    }

    /// Broadcast to all connected WebSocket clients.
    void broadcast(const std::string& message) {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = active_sessions_.begin();
        while (it != active_sessions_.end()) {
            if (auto s = it->lock()) {
                s->send_message(message);
                ++it;
            } else {
                it = active_sessions_.erase(it);
            }
        }
    }

private:
    void do_accept() {
        acceptor_.async_accept(
            net::make_strand(ioc_),
            beast::bind_front_handler(
                &Listener::on_accept, shared_from_this()));
    }

    void on_accept(beast::error_code ec, tcp::socket socket) {
        if (!ec) {
            auto session = std::make_shared<HttpSession>(
                std::move(socket),
                web_root_,
                ws_handler_,
                [this](std::shared_ptr<WsSession> ws) {
                    std::lock_guard<std::mutex> lock(sessions_mutex_);
                    active_sessions_.push_back(std::weak_ptr<WsSession>(ws));
                });
            session->run();
        }
        do_accept();
    }
};

// WebSocketServer — top-level interface
class WebSocketServer {
public:
    explicit WebSocketServer(int port, std::string web_root = "")
        : port_(port)
        , web_root_(std::move(web_root))
        , work_guard_(net::make_work_guard(ioc_)) {}

    void set_message_handler(
        std::function<void(const std::string&)> handler) {
        message_handler_ = handler;
    }

    void start() {
        if (running_) return;

        auto const address = net::ip::make_address("0.0.0.0");
        listener_ = std::make_shared<Listener>(
            ioc_,
            tcp::endpoint{address, static_cast<unsigned short>(port_)},
            web_root_,
            message_handler_);
        listener_->run();

        // Resolve the actual port after bind (important for port 0).
        actual_port_ = listener_->port();

        server_thread_ = std::thread([this]() { ioc_.run(); });
        running_ = true;
    }

    void stop() {
        if (!running_) return;
        ioc_.stop();
        if (server_thread_.joinable()) server_thread_.join();
        running_ = false;
    }

    void broadcast(const std::string& message) {
        if (listener_) listener_->broadcast(message);
    }

    /// Actual port the server is listening on (valid after start()).
    unsigned short actual_port() const { return actual_port_; }

    ~WebSocketServer() { stop(); }

private:
    int port_;
    std::string web_root_;
    net::io_context ioc_;
    net::executor_work_guard<net::io_context::executor_type> work_guard_;
    std::shared_ptr<Listener> listener_;
    std::thread server_thread_;
    bool running_ = false;
    unsigned short actual_port_ = 0;
    std::function<void(const std::string&)> message_handler_;
};

}  // namespace ros2_live_viz

#endif  // ROS2_LIVE_VIZ__WEBSOCKET_SERVER_HPP_
