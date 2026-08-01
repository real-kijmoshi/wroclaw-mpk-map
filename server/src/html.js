'use strict';

/**
 * Strip tags and decode the handful of entities that show up in scraped
 * notices, without pulling in a full HTML parser dependency.
 *
 * Shared by src/alerts.js and src/twitterScrape.js — kept here instead of
 * duplicated in both, and instead of one requiring the other, since neither
 * scraper is a natural home for the other's dependency graph.
 */
const stripHtml = (value) =>
  String(value ?? '')
    // Tag AND content: page builders (Tilda, among others) embed a per-tile
    // <style> block inside the anchor itself for responsive image sizing, so
    // stripping only the tags left raw CSS text sitting in the notice title —
    // "@media screen and (max-width: 767px) { ... }" showing up as content.
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

module.exports = { stripHtml };
