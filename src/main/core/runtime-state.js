'use strict';
/**
 * 运行期共享状态（诊断用）。
 *
 * 有些东西天生不属于任何服务，却要被自省页看到：
 * 渲染层上报的槽位快照、配置层叠的结果、最近的 RPC 调用。
 * 这里只做「放」和「取」，不做业务逻辑；所有数据都是只读快照，
 * 写入方负责控制频率（槽位 400ms 节流、事件环形缓冲 200 条）。
 */
const runtime = {
  /** 渲染层上报的槽位树快照 */
  slots: null,
  /** 最近一次解析出的配置层叠 */
  config: null,
  /** 最近一次启动的 profile 名 */
  profile: null,
  /** 页面启动完成的时间戳，用于算启动耗时 */
  bootedAt: 0,
};

/** 事件环形缓冲：只记事件名与来源，不记负载（可能很大，也可能含隐私） */
const eventLog = [];
const EVENT_LIMIT = 200;

function recordEvent(event, owner, extra) {
  eventLog.push({
    event: String(event),
    owner: owner || null,
    at: Date.now(),
    extra: extra || null,
  });
  if (eventLog.length > EVENT_LIMIT) eventLog.splice(0, eventLog.length - EVENT_LIMIT);
}

function recentEvents(limit = 50) {
  return eventLog.slice(-limit).reverse();
}

function eventStats() {
  const counts = new Map();
  for (const e of eventLog) counts.set(e.event, (counts.get(e.event) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([event, count]) => ({ event, count }));
}

module.exports = { runtime, recordEvent, recentEvents, eventStats };
