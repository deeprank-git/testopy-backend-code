// utils/escapeRegex.js
//
// Escape user text for use inside a RegExp / Mongo $regex, so a search for
// "a.b" matches the literal string instead of any character.

export const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
