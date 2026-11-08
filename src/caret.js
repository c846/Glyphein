// A thicker text cursor. Chromium can't widen its own caret, so the native one
// is made transparent (see .ProseMirror in style.css) and this draws a bar in
// its place. The bar lives inside the scrolling desk, so it scrolls with the
// page without being moved.

import { Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';

class CaretView {
  constructor(view) {
    this.view = view;
    this.desk = view.dom.closest('#desk');
    this.caret = document.createElement('div');
    this.caret.className = 'text-caret';
    this.caret.hidden = true;
    this.desk.append(this.caret);

    this.refresh = () => this.update(this.view);
    for (const target of [view.dom, window]) {
      target.addEventListener('focus', this.refresh);
      target.addEventListener('blur', this.refresh);
    }
    window.addEventListener('resize', this.refresh);
    // Images loading, the reference panel opening and so on move the text
    // without a transaction.
    this.resizeObserver = new ResizeObserver(this.refresh);
    this.resizeObserver.observe(view.dom);
    this.resizeObserver.observe(this.desk);
  }

  update(view) {
    this.view = view;
    const { selection } = view.state;
    const show =
      selection instanceof TextSelection && selection.empty && view.hasFocus() && document.hasFocus() && view.editable;
    if (!show) {
      this.caret.hidden = true;
      return;
    }

    let coords;
    try {
      coords = view.coordsAtPos(selection.head);
    } catch {
      this.caret.hidden = true;
      return;
    }
    const desk = this.desk.getBoundingClientRect();
    const left = coords.left - desk.left + this.desk.scrollLeft;
    const top = coords.top - desk.top + this.desk.scrollTop;
    const height = coords.bottom - coords.top;

    const style = this.caret.style;
    const moved = style.left !== `${left}px` || style.top !== `${top}px` || style.height !== `${height}px`;
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.height = `${height}px`;
    const wasHidden = this.caret.hidden;
    this.caret.hidden = false;

    // Stay solid while typing or moving; blink only once the cursor rests.
    if (moved || wasHidden) {
      this.caret.classList.remove('blinking');
      void this.caret.offsetWidth; // Restarts the blink from "on".
      this.caret.classList.add('blinking');
    }
  }

  destroy() {
    for (const target of [this.view.dom, window]) {
      target.removeEventListener('focus', this.refresh);
      target.removeEventListener('blur', this.refresh);
    }
    window.removeEventListener('resize', this.refresh);
    this.resizeObserver.disconnect();
    this.caret.remove();
  }
}

export const ThickCaret = Extension.create({
  name: 'thickCaret',

  addProseMirrorPlugins() {
    return [new Plugin({ view: (view) => new CaretView(view) })];
  },
});
