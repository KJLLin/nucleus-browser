'use strict';
/**
 * 类型化 RPC（typert）。
 *
 * 核与渲染层之间的每一个请求都是一条「通道」。以前通道只有名字，
 * 参数长什么样、返回值该是什么，全靠调用方记性。这一层补上三件事：
 *
 *   1. 契约：每条通道可以用 schema 声明参数与结果
 *   2. 校验：进入处理器之前校验参数，返回之前校验结果，失败给出字段路径
 *   3. 观测：每条通道的调用数、失败数、耗时、最近一次错误
 *
 * schema 是纯对象、可 JSON 序列化 —— 自省页因此能把「这台浏览器到底暴露了
 * 哪些能力、每个能力要什么参数」直接摊开给人看。
 *
 * 刻意不做的事：不做类型转换（不做 coerce）。传错类型就是错，不猜。
 */

const T = {
  any: () => ({ kind: 'any' }),
  string: (o = {}) => ({ kind: 'string', ...o }),
  number: (o = {}) => ({ kind: 'number', ...o }),
  boolean: () => ({ kind: 'boolean' }),
  literal: (value) => ({ kind: 'literal', value }),
  enum: (values) => ({ kind: 'enum', values }),
  array: (item, o = {}) => ({ kind: 'array', item, ...o }),
  object: (shape, o = {}) => ({ kind: 'object', shape, ...o }),
  record: (value) => ({ kind: 'record', value }),
  union: (options) => ({ kind: 'union', options }),
  optional: (inner) => ({ kind: 'optional', inner }),
  nullable: (inner) => ({ kind: 'nullable', inner }),
};

class ValidationError extends Error {
  constructor(channel, errors) {
    const first = errors[0];
    super(`参数校验失败（${channel}）：${first.path} ${first.message}`);
    this.name = 'ValidationError';
    this.code = 'EPROTO';
    this.channel = channel;
    this.details = errors;
  }
}

/** @returns {{ok:boolean, errors:Array<{path:string,message:string}>}} */
function validate(schema, value, path = '$') {
  const errors = [];
  walk(schema, value, path, errors);
  return { ok: errors.length === 0, errors };
}

function walk(schema, value, path, errors) {
  if (!schema || schema.kind === 'any') return;

  switch (schema.kind) {
    case 'optional': {
      if (value !== undefined && value !== null) walk(schema.inner, value, path, errors);
      return;
    }
    case 'nullable': {
      if (value !== null) walk(schema.inner, value, path, errors);
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push({ path, message: `应为字符串，实际是 ${typeName(value)}` });
        return;
      }
      if (schema.min != null && value.length < schema.min) {
        errors.push({ path, message: `长度至少 ${schema.min}` });
      }
      if (schema.max != null && value.length > schema.max) {
        errors.push({ path, message: `长度最多 ${schema.max}` });
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push({ path, message: `应为 ${schema.enum.join(' / ')} 之一` });
      }
      if (schema.pattern) {
        const re = schema.pattern instanceof RegExp ? schema.pattern : new RegExp(schema.pattern);
        if (!re.test(value)) errors.push({ path, message: '格式不匹配' });
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push({ path, message: `应为数字，实际是 ${typeName(value)}` });
        return;
      }
      if (schema.int && !Number.isInteger(value)) errors.push({ path, message: '应为整数' });
      if (schema.min != null && value < schema.min) errors.push({ path, message: `不得小于 ${schema.min}` });
      if (schema.max != null && value > schema.max) errors.push({ path, message: `不得大于 ${schema.max}` });
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push({ path, message: `应为布尔值，实际是 ${typeName(value)}` });
      return;
    }
    case 'literal': {
      if (value !== schema.value) errors.push({ path, message: `应为 ${JSON.stringify(schema.value)}` });
      return;
    }
    case 'enum': {
      if (!schema.values.includes(value)) {
        errors.push({ path, message: `应为 ${schema.values.map((v) => JSON.stringify(v)).join(' / ')} 之一` });
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push({ path, message: `应为数组，实际是 ${typeName(value)}` });
        return;
      }
      if (schema.max != null && value.length > schema.max) {
        errors.push({ path, message: `最多 ${schema.max} 项` });
      }
      if (schema.item) {
        value.forEach((v, i) => walk(schema.item, v, `${path}[${i}]`, errors));
      }
      return;
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ path, message: `应为对象，实际是 ${typeName(value)}` });
        return;
      }
      for (const [key, sub] of Object.entries(schema.shape || {})) {
        walk(sub, value[key], `${path}.${key}`, errors);
      }
      if (schema.strict) {
        for (const key of Object.keys(value)) {
          if (!(key in (schema.shape || {}))) {
            errors.push({ path: `${path}.${key}`, message: '未知字段' });
          }
        }
      }
      return;
    }
    case 'record': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ path, message: `应为对象，实际是 ${typeName(value)}` });
        return;
      }
      for (const [key, v] of Object.entries(value)) {
        walk(schema.value, v, `${path}.${key}`, errors);
      }
      return;
    }
    case 'union': {
      const results = schema.options.map((o) => validate(o, value, path));
      if (!results.some((r) => r.ok)) {
        errors.push({ path, message: `不匹配任何允许的形状（${schema.options.length} 种）` });
      }
      return;
    }
    default:
      return;
  }
}

function typeName(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 人类可读的 schema 描述，自省页直接显示这个字符串 */
function formatSchema(schema, depth = 0) {
  if (!schema) return 'any';
  switch (schema.kind) {
    case 'any': return 'any';
    case 'string': {
      const bits = [];
      if (schema.enum) bits.push(schema.enum.map((v) => `"${v}"`).join('|'));
      if (schema.min != null || schema.max != null) bits.push(`${schema.min ?? 0}..${schema.max ?? '∞'} 字符`);
      if (schema.pattern) bits.push(`/${schema.pattern}/`);
      return bits.length ? `string(${bits.join(', ')})` : 'string';
    }
    case 'number': {
      const bits = [];
      if (schema.int) bits.push('int');
      if (schema.min != null || schema.max != null) bits.push(`${schema.min ?? '-∞'}..${schema.max ?? '∞'}`);
      return bits.length ? `number(${bits.join(', ')})` : 'number';
    }
    case 'boolean': return 'boolean';
    case 'literal': return JSON.stringify(schema.value);
    case 'enum': return schema.values.map((v) => JSON.stringify(v)).join(' | ');
    case 'array': return `${formatSchema(schema.item, depth)}[]`;
    case 'record': return `Record<string, ${formatSchema(schema.value, depth)}>`;
    case 'optional': return `${formatSchema(schema.inner, depth)}?`;
    case 'nullable': return `${formatSchema(schema.inner, depth)} | null`;
    case 'union': return schema.options.map((o) => formatSchema(o, depth)).join(' | ');
    case 'object': {
      if (depth > 2) return 'object';
      const parts = Object.entries(schema.shape || {})
        .map(([k, v]) => `${k}: ${formatSchema(v, depth + 1)}`);
      return `{ ${parts.join('; ')} }`;
    }
    default: return 'any';
  }
}

class TypeRegistry {
  constructor() {
    /** channel -> spec */
    this.specs = new Map();
    /** channel -> metrics */
    this.metrics = new Map();
  }

  define(channel, spec) {
    this.specs.set(channel, {
      params: spec.params || null,
      result: spec.result || null,
      description: spec.description || '',
      permission: spec.permission || null,
    });
    return this;
  }

  defineAll(map) {
    for (const [channel, spec] of Object.entries(map)) this.define(channel, spec);
    return this;
  }

  _metric(channel) {
    let m = this.metrics.get(channel);
    if (!m) {
      m = {
        channel,
        calls: 0,
        failed: 0,
        validationErrors: 0,
        totalMs: 0,
        lastError: null,
        lastAt: 0,
        typed: this.specs.has(channel),
      };
      this.metrics.set(channel, m);
    }
    return m;
  }

  /** 包装一个处理器：参数校验 → 执行 → 结果校验 → 记账 */
  wrap(channel, fn) {
    const spec = this.specs.get(channel);
    return async (payload, event) => {
      const m = this._metric(channel);
      m.calls += 1;
      m.lastAt = Date.now();
      const started = Date.now();

      if (spec && spec.params) {
        const { ok, errors } = validate(spec.params, payload || {});
        if (!ok) {
          m.failed += 1;
          m.validationErrors += 1;
          m.lastError = { at: Date.now(), message: errors[0].message, path: errors[0].path };
          throw new ValidationError(channel, errors);
        }
      }

      try {
        const result = await fn(payload || {}, event);
        if (spec && spec.result) {
          const { ok, errors } = validate(spec.result, result);
          if (!ok) {
            m.failed += 1;
            m.lastError = { at: Date.now(), message: `返回值不符：${errors[0].path} ${errors[0].message}`, path: errors[0].path };
            const err = new Error(`返回值不符合契约（${channel}）：${errors[0].path} ${errors[0].message}`);
            err.code = 'ERESULT';
            err.details = errors;
            throw err;
          }
        }
        return result;
      } catch (err) {
        m.failed += 1;
        m.lastError = { at: Date.now(), message: err && err.message ? err.message : String(err), path: err && err.path };
        throw err;
      } finally {
        m.totalMs += Date.now() - started;
      }
    };
  }

  describe() {
    const channels = [];
    for (const [channel, m] of this.metrics) {
      const spec = this.specs.get(channel);
      channels.push({
        channel,
        typed: !!spec,
        description: spec ? spec.description : '',
        permission: spec ? spec.permission : null,
        params: spec && spec.params ? formatSchema(spec.params) : null,
        result: spec && spec.result ? formatSchema(spec.result) : null,
        calls: m.calls,
        failed: m.failed,
        validationErrors: m.validationErrors,
        avgMs: m.calls ? +(m.totalMs / m.calls).toFixed(2) : 0,
        lastError: m.lastError,
        lastAt: m.lastAt,
      });
    }
    // 声明了但还没被调用过的通道也要出现在清单里
    for (const [channel, spec] of this.specs) {
      if (this.metrics.has(channel)) continue;
      channels.push({
        channel,
        typed: true,
        description: spec.description,
        permission: spec.permission,
        params: spec.params ? formatSchema(spec.params) : null,
        result: spec.result ? formatSchema(spec.result) : null,
        calls: 0,
        failed: 0,
        validationErrors: 0,
        avgMs: 0,
        lastError: null,
        lastAt: 0,
      });
    }
    channels.sort((a, b) => b.calls - a.calls || a.channel.localeCompare(b.channel));
    const typed = channels.filter((c) => c.typed).length;
    return {
      channels,
      total: channels.length,
      typed,
      untyped: channels.length - typed,
      coverage: channels.length ? Math.round((typed / channels.length) * 100) : 0,
    };
  }
}

module.exports = { T, validate, formatSchema, TypeRegistry, ValidationError };
