// Shared motion vocabulary for every page, built on Motion (motion.dev). One set of timings and easings so
// the whole product moves the same way: short fade-ups, soft springs, nothing that bounces for long.
//
// Loaded in <head>, right after /vendor/motion.js. It adds the "motion" class to <html> when animations will
// run; CSS uses that class to hide [data-enter] / [data-reveal] elements until they animate in. Without
// Motion, or when the visitor asked their device for reduced motion, nothing is hidden and nothing moves.
(() => {
  'use strict';

  const M = window.Motion;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const on = !!M && !reduced;
  if (on) document.documentElement.classList.add('motion');

  const EASE = [0.22, 1, 0.36, 1];            // fast start, long gentle settle
  const SPRING = (bounce = 0.18, visualDuration = 0.4) => ({ type: M?.spring, bounce, visualDuration });
  const list = (t) => (typeof t === 'string' ? Array.from(document.querySelectorAll(t)) : t instanceof Element ? [t] : Array.from(t || [])).filter(Boolean);
  const done = Promise.resolve();
  // Transforms left behind would turn the element into a containing block for position: fixed children
  // (the quiz watermark, for one), so they're cleared once an entrance finishes.
  // The data-enter / data-reveal attribute is dropped at the same time, so the CSS that hid it lets go.
  const tidy = (els) => els.forEach((el) => {
    el.removeAttribute('data-enter');
    el.removeAttribute('data-reveal');
    el.style.transform = ''; el.style.filter = ''; el.style.opacity = '';
  });
  const show = (els) => els.forEach((el) => { el.style.opacity = ''; });

  const ui = {
    on,

    // Fade up into place, one after another.
    enter(targets, { y = 12, delay = 0, stagger = 0.05, duration = 0.5, blur = false } = {}) {
      const els = list(targets);
      if (!els.length) return done;
      if (!on) { show(els); return done; }
      const kf = { opacity: [0, 1], y: [y, 0] };
      if (blur) kf.filter = ['blur(6px)', 'blur(0px)'];
      return M.animate(els, kf, { duration, ease: EASE, delay: M.stagger(stagger, { startDelay: delay }) })
        .then(() => tidy(els));
    },

    // Same entrance, but only when the element scrolls into view (once).
    reveal(targets, opts = {}) {
      const els = list(targets);
      if (!on) { show(els); return; }
      // Elements revealed together (one grid) get the stagger; a lone element just fades up.
      M.inView(els, (el) => { ui.enter(el, { ...opts, stagger: 0, delay: (opts.stagger ?? 0.06) * (Number(el.dataset.i) || 0) }); }, { amount: 0.25 });
    },

    // Dialogs, modals, toasts: a small spring from slightly smaller.
    pop(el, { y = 8, scale = 0.97 } = {}) {
      if (!on || !el) return done;
      return M.animate(el, { opacity: [0, 1], scale: [scale, 1], y: [y, 0] }, SPRING(0.2, 0.35)).then(() => tidy([el]));
    },

    // The way out: quicker than the way in.
    // Resolves on a timer too: whatever waits for it (a dialog closing) must never hang, even when the
    // browser pauses animation frames in a background tab.
    out(el, { y = 6, scale = 0.98 } = {}) {
      if (!on || !el) return done;
      const anim = M.animate(el, { opacity: 0, scale, y }, { duration: 0.16, ease: [0.4, 0, 1, 1] });
      return Promise.race([anim, new Promise((r) => setTimeout(r, 220))]).then(() => { try { anim.complete(); } catch { /* already finished */ } });
    },

    // Content replaced in place (next question, another form): slides in from the side it came from.
    slide(el, dir = 1, distance = 28) {
      if (!on || !el) return done;
      return M.animate(el, { opacity: [0, 1], x: [dir * distance, 0] }, { duration: 0.38, ease: EASE }).then(() => tidy([el]));
    },

    // Gentle "no": wrong code, wrong password.
    shake(el) {
      if (!on || !el) return done;
      return M.animate(el, { x: [0, -7, 6, -4, 3, 0] }, { duration: 0.42, ease: 'easeOut' }).then(() => tidy([el]));
    },

    // A quick confirmation pulse (an option chosen, a value copied).
    bump(el, to = 1.12) {
      if (!on || !el) return done;
      return M.animate(el, { scale: [1, to, 1] }, { duration: 0.32, ease: EASE });
    },

    // Numbers count up to their value.
    count(el, to, { duration = 0.9, decimals = 0 } = {}) {
      const n = Number(to);
      const fmt = (v) => (decimals ? v.toFixed(decimals) : String(Math.round(v)));
      if (!on || !el || !Number.isFinite(n) || n === 0) { if (el) el.textContent = Number.isFinite(n) ? fmt(n) : to; return done; }
      return M.animate(0, n, { duration, ease: EASE, onUpdate: (v) => { el.textContent = fmt(v); } });
    },

    // An SVG stroke drawing itself (the tick after submitting).
    draw(path, { delay = 0.15, duration = 0.5 } = {}) {
      if (!on || !path) return done;
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      return M.animate(path, { strokeDashoffset: [len, 0] }, { duration, delay, ease: EASE });
    },

    // The sliding underline under a row of tabs.
    indicator(bar, active) {
      if (!bar || !active) return;
      let line = bar.querySelector('.tab-indicator');
      if (!line) { line = document.createElement('span'); line.className = 'tab-indicator'; bar.append(line); }
      const target = { x: active.offsetLeft, width: active.offsetWidth };
      if (!on || !line.dataset.placed) {
        line.style.width = `${target.width}px`;
        line.style.transform = `translateX(${target.x}px)`;
        line.dataset.placed = '1';
        return;
      }
      M.animate(line, target, SPRING(0.15, 0.35));
    },

    animate: (...a) => (on ? M.animate(...a) : done),
  };

  window.ui = ui;

  // Safety net: anything still waiting to be revealed after a while is shown, so content is never stuck hidden.
  if (on) {
    window.addEventListener('load', () => setTimeout(() => {
      document.querySelectorAll('[data-enter]').forEach((el) => {
        if (getComputedStyle(el).opacity === '1') return;
        el.removeAttribute('data-enter');
        el.style.opacity = '1'; el.style.filter = 'none'; el.style.transform = 'none';
      });
    }, 2500));
  }
})();
