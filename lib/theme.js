// A quiz's look, chosen by its organiser: three colours, a font, corner style, and optional logo and
// background image. Stored as JSON on the quiz; anything missing or invalid falls back to the default.
const DEFAULT_THEME = {
  bg: '#fbf7ef',
  text: '#2d2a2e',
  accent: '#b31b34',
  font: 'sans',
  corners: 'rounded',
  logo: null,
  bgImage: null,
  bgDim: 40,
};

const FONTS = ['sans', 'serif', 'rounded', 'mono', 'condensed'];
const CORNERS = ['square', 'rounded', 'pill'];

const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : fallback);
// Images are either uploaded here (/uploads/<name>) or on the Blob store (https).
const image = (v) => (typeof v === 'string' && /^\/uploads\/[\w.-]+$|^https:\/\/[^\s"'()<>]+$/.test(v) && v.length <= 400 ? v : null);

function normalizeTheme(input) {
  let t = input;
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = {}; } }
  if (!t || typeof t !== 'object') t = {};
  const dim = Math.round(Number(t.bgDim));
  return {
    bg: hex(t.bg, DEFAULT_THEME.bg),
    text: hex(t.text, DEFAULT_THEME.text),
    accent: hex(t.accent, DEFAULT_THEME.accent),
    font: FONTS.includes(t.font) ? t.font : DEFAULT_THEME.font,
    corners: CORNERS.includes(t.corners) ? t.corners : DEFAULT_THEME.corners,
    logo: image(t.logo),
    bgImage: image(t.bgImage),
    bgDim: Number.isFinite(dim) ? Math.min(90, Math.max(0, dim)) : DEFAULT_THEME.bgDim,
  };
}

module.exports = { DEFAULT_THEME, normalizeTheme };
