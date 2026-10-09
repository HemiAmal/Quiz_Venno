// Turns a quiz theme (from lib/theme.js) into CSS custom properties on an element. Used by the quiz page
// itself and by the live preview in the organiser app, so both always look the same.
(() => {
  'use strict';

  const FONTS = {
    sans: '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif',
    serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
    rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Segoe UI", system-ui, sans-serif',
    mono: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    condensed: '"Arial Narrow", "Roboto Condensed", "Segoe UI", system-ui, sans-serif',
  };
  const CORNERS = { square: ['3px', '3px', '3px'], rounded: ['14px', '9px', '9px'], pill: ['22px', '14px', '999px'] };

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // Relative luminance (WCAG), used to pick black or white text on the accent colour.
  const luminance = (hex) => {
    const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const onColor = (hex) => (contrast(hex, '#000000') >= contrast(hex, '#ffffff') ? '#000000' : '#ffffff');

  function applyQuizTheme(el, t) {
    const s = el.style;
    const mix = (pct) => `color-mix(in srgb, ${t.text} ${pct}%, ${t.bg})`;
    s.setProperty('--bg', t.bg);
    s.setProperty('--text', t.text);
    s.setProperty('--accent', t.accent);
    s.setProperty('--on-accent', onColor(t.accent));
    s.setProperty('--accent-soft', `color-mix(in srgb, ${t.accent} 12%, transparent)`);
    s.setProperty('--surface', mix(4));
    s.setProperty('--surface-2', mix(8));
    s.setProperty('--border', mix(13));
    s.setProperty('--border-strong', mix(24));
    s.setProperty('--muted', mix(62));
    s.setProperty('--font', FONTS[t.font] || FONTS.sans);
    const [r, rs, rb] = CORNERS[t.corners] || CORNERS.rounded;
    s.setProperty('--radius', r);
    s.setProperty('--radius-sm', rs);
    s.setProperty('--radius-btn', rb);
    // Background picture under a veil of the background colour, so text stays readable on any photo.
    if (t.bgImage) {
      const [R, G, B] = rgb(t.bg);
      const a = (t.bgDim ?? 40) / 100;
      s.setProperty('--page-image', `linear-gradient(rgba(${R},${G},${B},${a}), rgba(${R},${G},${B},${Math.min(1, a + 0.15)})), url("${encodeURI(t.bgImage)}")`);
    } else {
      s.removeProperty('--page-image');
    }
    // Light or dark controls (date pickers, scrollbars) to match.
    s.colorScheme = luminance(t.bg) < 0.4 ? 'dark' : 'light';
  }

  window.applyQuizTheme = applyQuizTheme;
  window.quizThemeContrast = contrast;
})();
