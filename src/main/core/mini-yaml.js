'use strict';
/**
 * 极小 YAML 子集解析器。
 *
 * 只支持配置文件真正用到的语法，刻意不追求完整：
 *   - 映射（靠缩进嵌套）
 *   - 列表（`- value`，只支持标量项）
 *   - 行内列表 `[a, b, c]`
 *   - 标量：字符串 / 数字 / 布尔 / null，支持单双引号
 *   - `#` 注释（引号内的 # 不算）
 *
 * 不支持锚点、多行字符串、列表套对象 —— 遇到就报错，不猜。
 * 这样出问题时错误信息是明确的，而不是「配置静默失效」。
 */

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const text = raw.trim();
  if (text === '') return '';
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replace(/\\(["'\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
  }

  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitInline(inner).map(parseScalar);
  }

  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function splitInline(text) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * @returns {{ok:true, data:object} | {ok:false, error:string, line:number}}
 */
function parse(source, filename = 'yaml') {
  const rawLines = String(source || '').split(/\r?\n/);
  const root = {};
  // 栈顶是当前容器；indent 表示「这个容器的子项要缩进到这个值之后」
  const stack = [{ indent: -1, node: root, kind: 'map' }];

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const raw = stripComment(rawLines[idx]).replace(/\s+$/, '');
    if (!raw.trim()) continue;
    if (/^\t/.test(raw)) {
      return { ok: false, error: `${filename}:${idx + 1} 不支持 Tab 缩进，请用空格`, line: idx + 1 };
    }

    const indent = raw.match(/^ */)[0].length;
    const line = raw.slice(indent);
    if (indent === 0 && /^---\s*$/.test(line)) continue;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    // 列表项
    if (/^-\s/.test(line) || line === '-') {
      if (top.kind !== 'list') {
        return { ok: false, error: `${filename}:${idx + 1} 这里不该出现列表项（父级不是列表）`, line: idx + 1 };
      }
      const value = line.replace(/^-\s*/, '');
      if (!value) {
        return { ok: false, error: `${filename}:${idx + 1} 列表项必须在同一行给出值`, line: idx + 1 };
      }
      top.node.push(parseScalar(value));
      continue;
    }

    // 键值对（键可以带引号，设置项里常见 "plugin:x:y": value）
    const m = line.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z0-9_.\-\u4e00-\u9fa5]+)\s*:(.*)$/);
    if (!m) {
      return { ok: false, error: `${filename}:${idx + 1} 无法解析：${line.slice(0, 60)}`, line: idx + 1 };
    }
    if (top.kind !== 'map') {
      return { ok: false, error: `${filename}:${idx + 1} 列表里不能直接写键值对`, line: idx + 1 };
    }

    const rawKey = m[1];
    const key = /^["']/.test(rawKey)
      ? rawKey.slice(1, -1).replace(/\\(["'\\])/g, '$1')
      : rawKey;
    const rest = m[2].trim();

    if (rest === '') {
      // 看下一行是列表还是嵌套映射
      let next = idx + 1;
      while (next < rawLines.length && !stripComment(rawLines[next]).trim()) next += 1;
      const nextLine = next < rawLines.length ? stripComment(rawLines[next]) : '';
      const isList = /^\s*-\s/.test(nextLine);
      const child = isList ? [] : {};
      top.node[key] = child;
      stack.push({ indent, node: child, kind: isList ? 'list' : 'map' });
      continue;
    }

    top.node[key] = parseScalar(rest);
  }

  return { ok: true, data: root };
}

module.exports = { parse, parseScalar };
