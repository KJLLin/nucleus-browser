'use strict';
/**
 * 全局快捷键分发。
 *
 * 网页内的按键不会冒泡到浏览器 UI（webview 是独立渲染进程），所以匹配必须
 * 在主进程用 before-input-event 完成；命中后发命令给 UI，由 UI 执行。
 * 这样无论焦点在地址栏还是网页里，Ctrl+L / F5 / Ctrl+T 行为一致。
 */
const ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

function normalizePart(p) {
  const s = p.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (['ctrl', 'control', 'cmdorctrl', 'commandorcontrol'].includes(lower)) return 'Ctrl';
  if (['alt', 'option'].includes(lower)) return 'Alt';
  if (['shift'].includes(lower)) return 'Shift';
  if (['meta', 'cmd', 'command', 'win', 'super'].includes(lower)) return 'Meta';
  if (lower === 'space') return 'Space';
  if (lower === 'esc' || lower === 'escape') return 'Escape';
  if (lower === 'enter' || lower === 'return') return 'Enter';
  if (lower === 'del' || lower === 'delete') return 'Delete';
  if (lower === 'ins' || lower === 'insert') return 'Insert';
  if (lower === 'up') return 'ArrowUp';
  if (lower === 'down') return 'ArrowDown';
  if (lower === 'left') return 'ArrowLeft';
  if (lower === 'right') return 'ArrowRight';
  if (lower === 'pageup' || lower === 'pgup') return 'PageUp';
  if (lower === 'pagedown' || lower === 'pgdn') return 'PageDown';
  if (lower === 'plus') return 'Plus';
  if (lower === 'minus') return 'Minus';
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  if (s.length === 1) return s.toUpperCase();
  return s;
}

/** "ctrl + shift + k" -> "Ctrl+Shift+K" */
function normalizeCombo(str) {
  if (!str) return null;
  const parts = String(str).split('+').map(normalizePart).filter(Boolean);
  if (!parts.length) return null;
  const mods = ORDER.filter((m) => parts.includes(m));
  const keys = parts.filter((p) => !ORDER.includes(p));
  if (keys.length !== 1) return null;
  return [...mods, keys[0]].join('+');
}

/** 从 Electron 的 input 事件生成同格式组合键 */
function comboFromInput(input) {
  const mods = [];
  if (input.control) mods.push('Ctrl');
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  if (input.meta) mods.push('Meta');

  let key = input.key;
  if (!key) return null;
  if (key === ' ') key = 'Space';
  else if (key === 'Esc') key = 'Escape';
  else if (key === 'ArrowUp') key = 'ArrowUp';
  else if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  else if (key.length === 1) {
    // Shift 会把 "1" 变成 "!"，用物理键位还原，保证 Ctrl+Shift+1 也能匹配
    const codeMap = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', _: 'Minus', '+': 'Plus', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
    key = codeMap[key] || key.toUpperCase();
  } else if (key === 'Plus') key = 'Plus';
  return [...mods, key].join('+');
}

class ShortcutService {
  constructor({ bus, getChromeWindow, commandSink }) {
    this.bus = bus;
    this.getChromeWindow = getChromeWindow;
    this.commandSink = commandSink; // (commandId, source) => void
    this.bindings = new Map(); // combo -> commandId
    this._attached = new WeakSet();
  }

  /** 由插件贡献点重建绑定表 */
  rebuild(plugins) {
    this.bindings.clear();
    for (const rec of plugins) {
      if (!rec.enabled || !rec.manifest) continue;
      for (const cmd of rec.manifest.contributes.commands) {
        if (!cmd.keybinding) continue;
        const combo = normalizeCombo(cmd.keybinding);
        if (!combo) {
          console.warn(`[shortcuts] 无法解析快捷键 "${cmd.keybinding}" (${cmd.id})`);
          continue;
        }
        if (this.bindings.has(combo)) {
          // 后注册者不覆盖先注册者：内置插件先于用户插件，行为可预测
          console.warn(`[shortcuts] 快捷键冲突 ${combo}：${cmd.id} 未生效`);
          continue;
        }
        this.bindings.set(combo, cmd.id);
      }
    }
    return this.bindings.size;
  }

  attach(webContents) {
    if (!webContents || this._attached.has(webContents)) return;
    this._attached.add(webContents);
    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      // 长按重复触发只放行一次，避免狂开标签
      if (input.isAutoRepeat && !/^F\d+$/.test(input.key)) return;
      const combo = comboFromInput(input);
      if (!combo) return;
      const commandId = this.bindings.get(combo);
      if (!commandId) return;
      event.preventDefault();
      this.dispatch(commandId, combo);
    });
  }

  dispatch(commandId, combo) {
    const win = this.getChromeWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('nucleus:run-command', { id: commandId, via: 'keybinding', combo });
  }

  list() {
    return Array.from(this.bindings.entries()).map(([combo, id]) => ({ combo, id }));
  }
}

module.exports = { ShortcutService, normalizeCombo, comboFromInput };
