'use strict';

/**
 * Case- and diacritic-insensitive stop search, shared by every timetable store
 * (MPK GTFS, KD GTFS).
 *
 * The folding below is the one place stop-name normalization lives: names are
 * folded once when a feed is indexed and queries are folded through the same
 * function per search, so the two sides can never disagree. Only characters
 * with a canonical decomposition are folded (`ł`, `ß`… have none and must be
 * typed as-is); the search is deliberately not a transliteration.
 */
const normalizeSearchText = (value) =>
  value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

// Unicode-aware: Polish letters like ł, ą, ś have no canonical decomposition, so
// they survive normalizeSearchText() and must still count as letters here.
// Without the `\p{L}` property, `ł` would be treated as a separator and split
// "aleja łowiecka" into ["aleja", "owiecka"], downgrading a word-prefix match
// ("ło") to a generic substring match.
const WORD_BREAK = /[^\p{L}\p{N}]+/u;

/**
 * Rank one folded stop name against a folded query.
 *
 * The ranks form a partial order from best to acceptable:
 *   0  the names are identical
 *   1  the name starts with the query
 *   2  a word of the name starts with the query
 *   3  the query appears somewhere in the name
 *   -1 no match
 *
 * The scan that uses this runs over every stop, so an exact or prefix match is
 * found no matter where it sits in insertion order — ranking, not iteration
 * order, decides what wins.
 */
const matchRank = (name, query) => {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  for (const word of name.split(WORD_BREAK)) {
    if (word.startsWith(query)) return 2;
  }
  if (name.includes(query)) return 3;
  return -1;
};

module.exports = { matchRank, normalizeSearchText };
