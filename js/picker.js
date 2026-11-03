// A select-style button that opens a list with icons (native <select> can't show images).

const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) n.append(c);
  return n;
};

export class Picker {
  /** options: { label, onChange } */
  constructor({ label, onChange }) {
    this.label = label;
    this.onChange = onChange;
    this.options = [];
    this.value = null;
    this.icon = el('img', { alt: '', width: 32, height: 32 });
    this.text = el('span', { className: 'picker-text' });
    this.button = el('button', { type: 'button', className: 'picker', 'aria-haspopup': 'listbox' },
      this.icon, this.text, el('span', { className: 'picker-caret', 'aria-hidden': 'true', textContent: '▾' }));
    this.button.setAttribute('aria-label', label);
    this.button.addEventListener('click', () => this.open());
  }

  /** items: [{ value, label, icon }] */
  setOptions(items, value) {
    this.options = items;
    const keep = items.find((o) => o.value === (value ?? this.value)) || items[0];
    this.set(keep?.value, false);
  }

  set(value, notify = true) {
    const item = this.options.find((o) => o.value === value);
    if (!item) return;
    this.value = value;
    this.icon.src = item.icon;
    this.text.textContent = item.label;
    this.button.setAttribute('aria-label', `${this.label}: ${item.label}`);
    if (notify) this.onChange?.(value);
  }

  open() {
    const last = document.activeElement;
    const search = el('input', { type: 'search', className: 'picker-search', placeholder: `Search ${this.label.toLowerCase()}`, 'aria-label': `Search ${this.label.toLowerCase()}` });
    const list = el('ul', { className: 'picker-list', role: 'listbox', 'aria-label': this.label });
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      vv?.removeEventListener('resize', fit);
      vv?.removeEventListener('scroll', fit);
      last?.focus();
    };
    const choose = (v) => { close(); if (v !== this.value) this.set(v); };
    const render = (q = '') => {
      const needle = q.trim().toLowerCase();
      list.replaceChildren(...this.options
        .filter((o) => !needle || o.label.toLowerCase().includes(needle))
        .map((o) => {
          const btn = el('button', { type: 'button', role: 'option', className: 'picker-option' },
            el('img', { src: o.icon, alt: '', width: 40, height: 40, loading: 'lazy' }),
            el('span', { textContent: o.label }));
          btn.setAttribute('aria-selected', String(o.value === this.value));
          btn.addEventListener('click', () => choose(o.value));
          return el('li', {}, btn);
        }));
    };
    search.addEventListener('input', () => render(search.value));
    // While typing, pin the panel to the top of the screen so the matches stay
    // at the top, clear of the keyboard, even if the screen isn't resized.
    search.addEventListener('focus', () => overlay.classList.add('typing'));
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const panel = el('div', { className: 'picker-panel', role: 'dialog', 'aria-label': `Choose ${this.label.toLowerCase()}` },
      el('div', { className: 'picker-head' },
        el('h2', { textContent: this.label }),
        el('button', { type: 'button', className: 'sheet-close', 'aria-label': 'Close', textContent: '×', onclick: close })),
      this.options.length > 8 ? search : null,
      list);
    const overlay = el('div', { className: 'picker-overlay' }, el('div', { className: 'sheet-backdrop', onclick: close }), panel);
    // Keep the list above the on-screen keyboard: size the overlay to the part
    // of the screen that is actually visible, so the panel's bottom edge sits on
    // top of the keyboard and the list scrolls inside what's left.
    const vv = window.visualViewport;
    const fit = () => {
      if (!vv) return;
      overlay.style.top = `${vv.offsetTop}px`;
      overlay.style.height = `${vv.height}px`;
      overlay.style.bottom = 'auto';
    };
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    fit();
    render();
    document.body.append(overlay);
    (list.querySelector('[aria-selected=true]') || list.querySelector('button'))?.scrollIntoView({ block: 'center' });
    // Focus the current choice rather than the search box, so phones don't pop up the keyboard.
    (list.querySelector('[aria-selected=true]') || list.querySelector('button'))?.focus({ preventScroll: true });
  }
}
