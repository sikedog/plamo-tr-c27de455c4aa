// PFML3 prompt format helpers for PLaMo 3 Translate.
// Format reference: the model card on Hugging Face (pfnet/plamo-3-translate-*).

const TAG = '<|plamo:tag|>';
const MSG = '<|plamo:msg|>';
const KEY = '<|plamo:key|>';
const VAL = '<|plamo:val|>';
const INDEX = '<|plamo:index|>';
const ITEM = '<|plamo:item|>';

export const STOP_STRINGS = ['<|plamo:tag|>', '<|plamo:bos|>'];

// "source = target" per line. Separators: "=", "＝", "->", "→", tab.
export function parseGlossary(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.+?)\s*(?:=|＝|->|→|\t)\s*(.+)$/);
    if (m) out.push({ source: m[1].trim(), target: m[2].trim() });
  }
  return out;
}

// Remove control tokens so they never leak into the UI.
function sanitize(s) {
  return String(s).replace(/<\|plamo:[a-z_]+\|>/g, '');
}

export function buildPrompt({ text, target, source, form, context, glossary }) {
  let p = `${TAG}dataset${MSG}translation`;
  const ctx = sanitize(context || '').trim();
  if (ctx) p += `${TAG}context${MSG}${ctx}`;
  if (glossary && glossary.length) {
    p += `${TAG}glossary`;
    for (const g of glossary) p += `${INDEX}${sanitize(g.source)}${ITEM}${sanitize(g.target)}`;
  }
  p += `${TAG}input`;
  if (source) p += `${KEY}lang${VAL}${source}`;
  p += `${MSG}${sanitize(text)}`;
  p += `${TAG}output${KEY}lang${VAL}${target}`;
  if (form && target === 'ja') p += `${KEY}form${VAL}${form}`;
  p += MSG;
  return p;
}

// Cut at the first control token, then trim.
export function cleanOutput(s) {
  const i = String(s).indexOf('<|plamo:');
  return (i >= 0 ? String(s).slice(0, i) : String(s)).trim();
}
