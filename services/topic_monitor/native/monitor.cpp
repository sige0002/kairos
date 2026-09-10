// SPDX-License-Identifier: Apache-2.0
#include <rclcpp/rclcpp.hpp>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <exception>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

namespace {
double now_s() {
  return std::chrono::duration<double>(
    std::chrono::steady_clock::now().time_since_epoch()).count();
}
struct Observation { double t; uint64_t bytes; };
struct Window {
  std::mutex mutex;
  std::deque<Observation> observations;
  uint64_t total = 0, lost = 0;
  double last = -1;
};
struct Engine {
  double horizon;
  std::shared_ptr<rclcpp::Context> context;
  rclcpp::Node::SharedPtr node;
  std::shared_ptr<rclcpp::executors::SingleThreadedExecutor> executor;
  std::thread thread;
  std::atomic<bool> alive{false}, paused{false}, stopping{false};
  std::mutex mutex;
  std::map<std::string, std::shared_ptr<Window>> windows;
  std::map<std::string, rclcpp::GenericSubscription::SharedPtr> subscriptions;
  explicit Engine(double h): horizon(h) {
    if (!std::isfinite(h) || h <= 0) throw std::invalid_argument("invalid horizon");
  }
  void stop() {
    // Retain windows/counters, but release every DDS entity before returning.
    // Bounded spin_once also exits if both cancellation mechanisms fail.
    stopping = true;
    std::exception_ptr failure;
    try { if (executor) executor->cancel(); }
    catch (...) { failure = std::current_exception(); }
    try { if (context) context->shutdown("native monitor stop"); }
    catch (...) { if (!failure) failure = std::current_exception(); }
    if (thread.joinable()) thread.join();
    alive = false;
    subscriptions.clear();
    executor.reset();
    node.reset();
    context.reset();
    if (failure) std::rethrow_exception(failure);
  }
  void start() {
    if (thread.joinable()) throw std::runtime_error("already started");
    try {
      stopping = false;
      context = std::make_shared<rclcpp::Context>();
      context->init(0, nullptr);
      node = std::make_shared<rclcpp::Node>("topic_monitor_native",
        rclcpp::NodeOptions().context(context));
      rclcpp::ExecutorOptions options;
      options.context = context;
      executor = std::make_shared<rclcpp::executors::SingleThreadedExecutor>(options);
      executor->add_node(node);
      alive = true;
      thread = std::thread([this] {
        try {
          while (!stopping && context->is_valid()) {
            executor->spin_once(std::chrono::milliseconds(100));
          }
        } catch (const std::exception &ex) {
          std::fprintf(stderr, "native executor failed: %s\n", ex.what());
        } catch (...) {
          std::fprintf(stderr, "native executor failed: unknown exception\n");
        }
        alive = false;
      });
    } catch (...) {
      auto failure = std::current_exception();
      try { stop(); }
      catch (...) { std::fprintf(stderr, "native startup cleanup failed\n"); }
      std::rethrow_exception(failure);
    }
  }
  std::shared_ptr<Window> window(const std::string &name) {
    std::lock_guard<std::mutex> guard(mutex);
    auto &w = windows[name];
    if (!w) w = std::make_shared<Window>();
    return w;
  }
  void add(const std::shared_ptr<Window> &w, double t, uint64_t bytes) {
    if (paused) return;
    std::lock_guard<std::mutex> guard(w->mutex);
    w->observations.push_back({t, bytes});
    ++w->total;
    w->last = t;
    while (!w->observations.empty() && w->observations.front().t < t - horizon)
      w->observations.pop_front();
  }
  // km_destroy calls stop before delete. Never destroy a joinable thread.
  ~Engine() noexcept = default;
};
thread_local char error[1024] = {};
template<class F> int checked(F f) noexcept {
  try { f(); error[0] = '\0'; return 0; }
  catch (const std::exception &e) {
    std::snprintf(error, sizeof(error), "%s", e.what()); return -1;
  }
  catch (...) {
    std::snprintf(error, sizeof(error), "unknown native failure"); return -1;
  }
}
void require_engine(Engine *e) {
  if (!e) throw std::invalid_argument("null engine");
}
double percentile(const std::vector<double> &v, double q) {
  if (v.empty()) return -1;
  double pos = (v.size() - 1) * q;
  auto lo = static_cast<size_t>(pos);
  auto hi = std::min(lo + 1, v.size() - 1);
  return (v[lo] + (v[hi] - v[lo]) * (pos - lo)) * 1000;
}
}
extern "C" {
struct Snapshot {
  uint64_t count, bytes, total, lost, late;
  double last, gap_max_ms, p50_ms, p95_ms;
};
uint32_t km_abi_version() noexcept { return 1; }
size_t km_snapshot_size() noexcept { return sizeof(Snapshot); }
const char *km_error() noexcept { return error; }
void *km_create(double horizon) noexcept {
  Engine *p = nullptr;
  checked([&] { p = new Engine(horizon); });
  return p;
}
int km_destroy(Engine *e) noexcept {
  return checked([&] {
    if (!e) return;
    // On cleanup failure ownership stays with the caller for a safe retry.
    e->stop();
    delete e;
  });
}
int km_start(Engine *e) noexcept {
  return checked([&] { require_engine(e); e->start(); });
}
int km_stop(Engine *e) noexcept {
  return checked([&] { require_engine(e); e->stop(); });
}
int km_alive(Engine *e) noexcept { return e && e->alive; }
int km_pause(Engine *e, int paused) noexcept {
  return checked([&] { require_engine(e); e->paused = paused != 0; });
}
int km_remove(Engine *e, const char *name) noexcept {
  return checked([&] {
    require_engine(e);
    if (!name) throw std::invalid_argument("null topic");
    std::lock_guard<std::mutex> guard(e->mutex);
    e->subscriptions.erase(name);
  });
}
int km_subscribe(Engine *e, const char *name, const char *type,
                 int reliable, int transient, int depth) noexcept {
  return checked([&] {
    require_engine(e);
    if (!name || !type) throw std::invalid_argument("null topic/type");
    if (!e->node || !e->alive) throw std::runtime_error("native executor is stopped");
    auto w = e->window(name);
    auto qos = rclcpp::QoS(rclcpp::KeepLast(std::max(1, depth)));
    if (reliable) qos.reliable(); else qos.best_effort();
    if (transient) qos.transient_local(); else qos.durability_volatile();
    rclcpp::SubscriptionOptions options;
    options.event_callbacks.message_lost_callback = [w](rclcpp::QOSMessageLostInfo &info) {
      std::lock_guard<std::mutex> guard(w->mutex);
      if (info.total_count_change > 0) w->lost += info.total_count_change;
    };
    auto sub = e->node->create_generic_subscription(name, type, qos,
      [e, w](std::shared_ptr<rclcpp::SerializedMessage> raw) {
        e->add(w, now_s(), raw->size());
      }, options);
    std::lock_guard<std::mutex> guard(e->mutex);
    e->subscriptions[name] = std::move(sub);
  });
}
int km_snapshot(Engine *e, const char *name, double window, double now,
                double late_threshold, Snapshot *out) noexcept {
  return checked([&] {
    require_engine(e);
    if (!name || !out) throw std::invalid_argument("null topic/output");
    if (!(window > 0) || window > e->horizon || !std::isfinite(now))
      throw std::invalid_argument("invalid snapshot time/window");
    auto w = e->window(name);
    std::vector<Observation> observations;
    *out = {};
    {
      std::lock_guard<std::mutex> guard(w->mutex);
      while (!w->observations.empty() && w->observations.front().t < now - e->horizon)
        w->observations.pop_front();
      out->total = w->total; out->lost = w->lost; out->last = w->last;
      for (auto &o : w->observations)
        if (o.t >= now - window) observations.push_back(o);
    }
    std::vector<double> gaps;
    for (size_t i = 0; i < observations.size(); ++i) {
      ++out->count; out->bytes += observations[i].bytes;
      if (i) {
        double gap = observations[i].t - observations[i-1].t;
        gaps.push_back(gap);
        if (late_threshold > 0 && gap > late_threshold) ++out->late;
      }
    }
    std::sort(gaps.begin(), gaps.end());
    out->gap_max_ms = gaps.empty() ? -1 : gaps.back() * 1000;
    out->p50_ms = percentile(gaps, .5); out->p95_ms = percentile(gaps, .95);
  });
}
int km_metadata(Engine *e, const char *name, Snapshot *out) noexcept {
  return checked([&] {
    require_engine(e);
    if (!name || !out) throw std::invalid_argument("null topic/output");
    auto w = e->window(name);
    std::lock_guard<std::mutex> guard(w->mutex);
    *out = {};
    out->total = w->total; out->lost = w->lost; out->last = w->last;
  });
}
// Deterministic test seam: no fabricated observations are used in production.
int km_test_add(Engine *e, const char *name, double t, uint64_t bytes) noexcept {
  return checked([&] {
    require_engine(e);
    if (!name || !std::isfinite(t)) throw std::invalid_argument("invalid test sample");
    e->add(e->window(name), t, bytes);
  });
}
int km_test_lost(Engine *e, const char *name, int delta) noexcept {
  return checked([&] {
    require_engine(e);
    if (!name) throw std::invalid_argument("null topic");
    auto w = e->window(name);
    std::lock_guard<std::mutex> guard(w->mutex);
    if (delta > 0) w->lost += delta;
  });
}
}
