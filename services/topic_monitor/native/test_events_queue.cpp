// SPDX-License-Identifier: Apache-2.0
#include "coalescing_events_queue.hpp"
#include <cassert>
#include <thread>
#include <vector>
#include <iostream>
using namespace std::chrono_literals;
using namespace rclcpp::experimental::executors;
using Q = kairos_monitor::CoalescingEventsQueue;
ExecutorEvent ev(const void *key, size_t count = 1) {
  ExecutorEvent e{};
  e.entity_key = key;
  e.type = ExecutorEventType::SUBSCRIPTION_EVENT;
  e.num_events = count;
  return e;
}
int main() {
  int keys[4]{};
  Q q;
  ExecutorEvent out{};
  assert(!q.dequeue(out, 2ms));
  q.enqueue(ev(keys, 1000000));
  assert(q.size() == 1000000 && q.storage_size() == 1);
  q.enqueue(ev(keys + 1));
  assert(q.dequeue(out, 0ns) && out.entity_key == keys);
  assert(q.dequeue(out, 0ns) && out.entity_key == keys + 1);
  for (size_t i = 1; i < 1000000; ++i)
    assert(q.dequeue(out, 0ns) && out.entity_key == keys && out.num_events == 1);
  assert(q.empty() && q.storage_size() == 0);
  auto a = ev(keys); auto b = a; auto c = a;
  b.waitable_data = 1; c.type = ExecutorEventType::WAITABLE_EVENT;
  q.enqueue(a); q.enqueue(b); q.enqueue(c);
  assert(q.storage_size() == 3);
  for (int i = 0; i < 3; ++i) assert(q.dequeue(out, 0ns));
  auto payload = std::make_shared<int>(42);
  std::weak_ptr<int> weak = payload;
  a.data = payload; q.enqueue(a); a.data.reset(); payload.reset();
  assert(!weak.expired());
  assert(q.dequeue(out, 0ns)); assert(*std::static_pointer_cast<int>(out.data) == 42);
  out.data.reset(); assert(weak.expired());
  std::thread wake([&] { std::this_thread::sleep_for(10ms); q.enqueue(ev(keys)); });
  assert(q.dequeue(out, 1s)); wake.join();
  constexpr size_t each = 100000;
  std::vector<std::thread> producers;
  for (int i = 0; i < 4; ++i) producers.emplace_back([&, i] {
    for (size_t n = 0; n < each; ++n) q.enqueue(ev(keys + i));
  });
  size_t counts[4]{};
  for (size_t n = 0; n < each * 4; ++n) {
    assert(q.dequeue(out, 5s));
    auto index = static_cast<const int *>(out.entity_key) - keys;
    assert(index >= 0 && index < 4); ++counts[index];
    assert(q.storage_size() <= 4);
  }
  for (auto &t : producers) t.join();
  for (auto count : counts) assert(count == each);
  assert(q.empty());
  q.enqueue(ev(keys, std::numeric_limits<size_t>::max()));
  bool overflow = false;
  try { q.enqueue(ev(keys + 1)); } catch (const std::overflow_error &) { overflow = true; }
  assert(overflow && q.storage_size() == 1 && q.size() == std::numeric_limits<size_t>::max());
  std::cout << "PASS: million-event bounded storage; fairness; key separation; payload ownership; timeout/wakeup; 400000 concurrent notifications; overflow\n";
}
