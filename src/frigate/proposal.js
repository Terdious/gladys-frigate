// -----------------------------------------------------------------------------
// "Propose a camera to the catalog": a pre-filled GitHub "new issue" URL on
// the integration repository, which the user opens and submits themselves.
//
// The integration has no outbound access to GitHub and sends nothing: the
// link carries a title and a body the user reviews in GitHub's form before
// submitting. The body holds the brand, the model, the source type, the
// user's notes and the versions; never a host, a password nor a token. The
// notes are free text, so what looks like a credential or an IP address in
// them is masked (best effort: the user still reviews the text).
//
// GitHub refuses URLs beyond ~8 KB: the notes are shortened to fit.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { redactSecrets } from './debugBuffer.js';

export const PROPOSAL_REPOSITORY = 'https://github.com/Terdious/gladys-frigate';
export const PROPOSAL_LABEL = 'cameras';
export const SOURCE_TYPES = Object.freeze(['rtsp', 'tapo', 'onvif', 'mjpeg', 'custom']);
export const MAX_PROPOSAL_URL_LENGTH = 8000;
const MAX_NAME_LENGTH = 80;
const MAX_NOTES_LENGTH = 4000;

// Private and loopback IPv4 addresses anywhere, any IPv4 after `://` or
// `@` (a URL): a firmware version such as 1.0.2.30 stays readable.
const PRIVATE_IPV4 =
  /\b(?:10|127|192\.168|169\.254|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}(?::\d+)?\b/g;
const URL_IPV4 = /(:\/\/|@)(?:\d{1,3}\.){3}\d{1,3}/g;
// A bracketed IPv6 (URLs) or a long colon group: never a camera model.
const IPV6 = /\[[0-9a-f:]+\](?::\d+)?|\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi;

/** Mask credentials and addresses in a user text. */
export function anonymize(value) {
  return redactSecrets(String(value ?? ''))
    .replace(URL_IPV4, '$1<address>')
    .replace(PRIVATE_IPV4, '<address>')
    .replace(IPV6, '<address>');
}

/**
 * The first `length` characters, never half of a surrogate pair (an emoji):
 * encodeURIComponent throws on a lone one.
 */
function cut(value, length) {
  const kept = value.slice(0, length);
  return /[\ud800-\udbff]$/.test(kept) ? kept.slice(0, -1) : kept;
}

/** One line, trimmed, at most `max` characters. */
function oneLine(value, max) {
  const line = anonymize(value).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${cut(line, max - 1)}…` : line;
}

function body({ brand, model, sourceType, notes, frigateVersion, integrationVersion, mode }) {
  return [
    '### Camera',
    '',
    `- Brand: ${brand}`,
    `- Model: ${model}`,
    `- Source type: ${sourceType}`,
    '',
    '### Notes',
    '',
    notes || '_None._',
    '',
    '### Environment',
    '',
    `- Frigate: ${frigateVersion || 'unknown'}`,
    `- Integration: ${integrationVersion || 'unknown'} (${mode} mode)`,
    '',
    '_Prepared by the "Propose a camera to the catalog" button of the Gladys Frigate integration. Check that no password or address remains before submitting._',
  ].join('\n');
}

/**
 * @param {object} options
 * @param {string} options.brand
 * @param {string} options.model
 * @param {string} [options.sourceType] one of SOURCE_TYPES (unknown -> custom)
 * @param {string} [options.notes]
 * @param {string} [options.frigateVersion]
 * @param {string} [options.integrationVersion]
 * @param {string} [options.mode] remote | managed
 * @returns {{ url: string, title: string, body: string, shortened: boolean }}
 */
export function buildProposal({
  brand,
  model,
  sourceType,
  notes = '',
  frigateVersion = '',
  integrationVersion = '',
  mode = 'remote',
}) {
  const fields = {
    brand: oneLine(brand, MAX_NAME_LENGTH),
    model: oneLine(model, MAX_NAME_LENGTH),
    sourceType: SOURCE_TYPES.includes(sourceType) ? sourceType : 'custom',
    frigateVersion: oneLine(frigateVersion, 40),
    integrationVersion: oneLine(integrationVersion, 40),
    mode: mode === 'managed' ? 'managed' : 'remote',
  };
  const title = `Frigate camera catalog: ${fields.brand} ${fields.model}`.trim();
  const anonymized = anonymize(notes).trim();
  const text = cut(anonymized, MAX_NOTES_LENGTH);
  let shortened = text.length < anonymized.length;
  const urlOf = (content) =>
    `${PROPOSAL_REPOSITORY}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(content)}&labels=${PROPOSAL_LABEL}`;
  let content = body({ ...fields, notes: text });
  let url = urlOf(content);
  if (url.length > MAX_PROPOSAL_URL_LENGTH) {
    // The longest prefix of the notes that fits (an encoded character takes
    // 1 to 9 characters of the URL: searched, not computed).
    shortened = true;
    const fitting = (length) => {
      const notesText = length > 0 ? `${cut(text, length)}…` : '';
      const candidate = body({ ...fields, notes: notesText });
      return { candidate, link: urlOf(candidate) };
    };
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fitting(middle).link.length <= MAX_PROPOSAL_URL_LENGTH) low = middle;
      else high = middle - 1;
    }
    ({ candidate: content, link: url } = fitting(low));
  }
  return { url, title, body: content, shortened };
}
