// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <chrono>
#include <iterator>
#include <rclcpp/experimental/executors/events_executor/events_queue.hpp>
#include <condition_variable>
#include <cstdint>
#include <limits>
#include <list>
#include <map>
#include <mutex>
#include <stdexcept>
#include <tuple>

namespace kairos_monitor {
// The monitor has no timers or payload-bearing executor events. Repeated
// notifications retain a count per entity, not one allocation per sample.
// Data-bearing events remain distinct so their ownership is never discarded.
class CoalescingEventsQueue : public rclcpp::experimental::executors::EventsQueue {
  using Event = rclcpp::experimental::executors::ExecutorEvent;
  using Key = std::tuple<std::uintptr_t, int, int>;
  using Queue = std::list<Event>;
  static Key key(const Event &event) {
    return {reinterpret_cast<std::uintptr_t>(event.entity_key),
            static_cast<int>(event.type), event.waitable_data};
  }
  mutable std::mutex mutex_;
  std::condition_variable ready_;
  Queue queue_;
  std::map<Key, Queue::iterator> indexed_;
  size_t pending_ = 0;
public:
  void enqueue(const Event &event) override {
    if (!event.num_events) return;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (event.num_events > std::numeric_limits<size_t>::max() - pending_)
        throw std::overflow_error("executor event count overflow");
      auto found = indexed_.find(key(event));
      if (!event.data && found != indexed_.end()) {
        found->second->num_events += event.num_events;
      } else {
        queue_.push_back(event);
        if (!event.data) {
          try { indexed_.emplace(key(event), std::prev(queue_.end())); }
          catch (...) { queue_.pop_back(); throw; }
        }
      }
      pending_ += event.num_events;
    }
    ready_.notify_one();
  }
  bool dequeue(Event &event,
      std::chrono::nanoseconds timeout = std::chrono::nanoseconds::max()) override {
    std::unique_lock<std::mutex> lock(mutex_);
    auto available = [this] { return pending_ != 0; };
    if (timeout == std::chrono::nanoseconds::max()) ready_.wait(lock, available);
    else if (!ready_.wait_for(lock, timeout, available)) return false;
    event = queue_.front();
    event.num_events = 1;
    --pending_;
    if (--queue_.front().num_events == 0) {
      if (!event.data) indexed_.erase(key(event));
      queue_.pop_front();
    } else {
      // Preserve order within each subscription without allowing a burst on
      // one topic to starve the others or delay the bounded shutdown check.
      queue_.splice(queue_.end(), queue_, queue_.begin());
    }
    return true;
  }
  bool empty() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return pending_ == 0;
  }
  size_t size() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return pending_;
  }
  size_t storage_size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return queue_.size();
  }
};
}
