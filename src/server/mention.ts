/**
 * Detect an @-mention of a named agent (e.g. the Team Lead) inside a free-form
 * chat message. Matching is intentionally forgiving on the *name* side (the
 * user may type `@lead`, `@team-lead`, `@teamlead`, or the full display name)
 * but strict on the *boundary* side: the `@` must sit at the start of the
 * message or right after whitespace/punctuation, so an email address like
 * `user@team-lead.io` or `foo@lead` never counts as a mention.
 */

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the alias set recognised for an agent display name. Always includes the
 * fixed Team-Lead aliases plus a normalized form of the display name (spaces and
 * hyphens made optional so `@team-lead`, `@team lead`, and `@teamlead` all hit).
 */
function aliasPatterns(displayName: string): string[] {
  const aliases = new Set<string>(['team[-\\s]?lead', 'teamlead', 'lead']);
  const name = (displayName ?? '').trim();
  if (name) {
    // Turn runs of spaces/hyphens in the display name into "[-\s]?" so the user
    // can type it with or without the separators.
    const flexible = escapeRegExp(name).replace(/(\\?[-\s])+/g, '[-\\s]?');
    aliases.add(flexible);
  }
  // Longer aliases first so the regex prefers the most specific match.
  return [...aliases].sort((a, b) => b.length - a.length);
}

/**
 * True when `content` contains an @-mention of the agent named `displayName`.
 * Case-insensitive. Requires a non-word char (or string start) immediately
 * before the `@`, and a word boundary after the alias.
 */
export function mentionsAgent(content: string, displayName: string): boolean {
  if (!content) return false;
  const alt = aliasPatterns(displayName).join('|');
  // (^|[^\w@]) — start, or a char that is neither a word char nor another '@'
  // (so `foo@lead` and `a@@lead` do not match) — this also rejects emails like
  // `user@team-lead.io` because the char before '@' is a word char. Then '@',
  // the alias, and a trailing non-word boundary (so `@leadership` does not match
  // but a sentence-ending `@team-lead.` still does).
  const re = new RegExp(`(^|[^\\w@])@(?:${alt})(?!\\w)`, 'i');
  return re.test(content);
}

/**
 * Remove @-mentions of the agent from the text (used to classify build/discuss
 * intent on the *content* rather than the mention token itself).
 */
export function stripMention(content: string, displayName: string): string {
  if (!content) return content;
  const alt = aliasPatterns(displayName).join('|');
  const re = new RegExp(`(^|[^\\w@])@(?:${alt})(?!\\w)`, 'gi');
  return content.replace(re, '$1').trim();
}
