// utils/isValidLink.js
//
// A notification/exam-alert link is either empty, a full http(s) URL, or an
// in-app path starting with "/". Protocol-relative "//host" is rejected so a
// link can never silently leave the site without an explicit scheme.

export const LINK_RULE_MESSAGE =
  "link must be empty, an http(s):// URL, or a path starting with /";

export const isValidLink = (value) => {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") return false;
  if (/^https?:\/\/\S+$/i.test(value)) return true;
  return value.startsWith("/") && !value.startsWith("//");
};
