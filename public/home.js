(() => {
  'use strict';

  const ui = window.ui;
  document.getElementById('year').textContent = new Date().getFullYear();

  // Accepts a full link (https://site/q/k7m2p9xq), a path (/q/k7m2p9xq) or just the code.
  const form = document.getElementById('join-form');
  const error = document.getElementById('join-error');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = form.elements.code.value.trim();
    const m = /\/q\/([a-z0-9]+)/i.exec(raw) || /^([a-z0-9]{4,32})$/i.exec(raw);
    if (!m) {
      error.textContent = 'Enter the quiz link or the 8-character code from your teacher.';
      ui.shake(form.elements.code);
      return;
    }
    error.textContent = '';
    location.href = `/q/${m[1].toLowerCase()}`;
  });

  // ---------- motion ----------
  // Hero: the copy settles in line by line, then the join card.
  ui.enter('.hero-copy [data-enter]', { y: 18, stagger: 0.08, duration: 0.7, blur: true });
  ui.enter('#join-form', { y: 24, delay: 0.35, duration: 0.8 });

  // Grids reveal as they scroll in, each card a beat after its neighbour.
  document.querySelectorAll('.steps, .features').forEach((grid) => {
    Array.from(grid.children).forEach((el, i) => { el.dataset.i = i; });
  });
  ui.reveal('[data-reveal]', { y: 16, stagger: 0.07, duration: 0.6 });

  // Header picks up a hairline and backdrop once the page moves.
  const head = document.getElementById('site-head');
  const onScroll = () => head.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // "Online quizzes for your …": the last word cycles through where the platform is used.
  const WORDS = ['classroom', 'college', 'quiz club', 'tech fest', 'coaching centre', 'school'];
  const rot = document.getElementById('rot');
  if (ui.on && rot) {
    let i = 0;
    const word = rot.querySelector('.rot-word');
    setInterval(async () => {
      if (document.hidden) return;
      i = (i + 1) % WORDS.length;
      // Same element throughout, so the line never empties and nothing below it jumps.
      await ui.animate(word, { opacity: 0, y: -14, filter: 'blur(4px)' }, { duration: 0.28, ease: [0.4, 0, 1, 1] });
      word.textContent = WORDS[i];
      ui.animate(word, { opacity: [0, 1], y: [14, 0], filter: ['blur(4px)', 'blur(0px)'] }, { duration: 0.45, ease: [0.22, 1, 0.36, 1] });
    }, 2600);
  }

  // How it works: a line runs across the steps as the section scrolls through the screen.
  const progress = document.getElementById('steps-progress');
  if (ui.on && progress) {
    window.Motion.scroll(
      window.Motion.animate(progress, { scaleX: [0, 1] }, { ease: 'linear' }),
      { target: document.getElementById('how'), offset: ['start 0.85', 'end 0.6'] },
    );
  }
})();
