// rules.js
// Pure rule-matching logic shared by the service worker, the popup and the
// options page. Must not touch `chrome.*` or the DOM so it stays testable
// under `node --test`.

/** Chrome's tab group colors, in the order they appear in the pickers. */
export const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

// Match scores. A higher score wins, so rule precedence no longer depends on
// the insertion order of the `domainGroups` object.
const SCORE_EXACT = 3; // literal rule whose key is the whole hostname
const SCORE_SUFFIX = 2; // `*.example.com`, or a bare `example.com` parent rule
const SCORE_REGEX = 1; // user-supplied regular expression

/**
 * Extracts the hostname from a URL.
 * @param {string} url
 * @returns {string|null} The hostname, or null if the URL is unusable.
 */
export function getDomain(url) {
  try {
    const { hostname } = new URL(url);
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Rules are enabled unless explicitly disabled, so rules saved before the
 * `enabled` flag existed keep working.
 * @param {object} info
 * @returns {boolean}
 */
export function isRuleEnabled(info) {
  return info?.enabled !== false;
}

/**
 * The domain a literal rule keys off, with any `*.` prefix removed.
 * @param {string} key
 * @returns {string}
 */
export function ruleSuffix(key) {
  return key.startsWith("*.") ? key.slice(2) : key;
}

/**
 * Compiles the stored rule map into a form that can be matched repeatedly
 * without re-parsing regexes. Invalid regexes are dropped rather than thrown,
 * and reported back so the caller can log them.
 * @param {object} domainGroups
 * @returns {{rules: Array<object>, invalid: Array<{key: string, error: Error}>}}
 */
export function compileRules(domainGroups) {
  const rules = [];
  const invalid = [];
  let index = 0;

  for (const [key, info] of Object.entries(domainGroups || {})) {
    const order = index++;
    if (!isRuleEnabled(info)) continue;

    if (info.isRegex) {
      let regex;
      try {
        regex = new RegExp(key);
      } catch (error) {
        invalid.push({ key, error });
        continue;
      }
      // Pattern length is a pragmatic proxy for specificity: a broad
      // catch-all like `https://github.com/e.*` is short, while a narrower
      // rule like `https://github.com/whamcloud/ansible.*` that is meant to
      // take priority over it is longer. This lets a "catch the rest" regex
      // coexist with more specific regexes for the same site regardless of
      // which one was declared first.
      rules.push({
        key,
        info,
        order,
        isRegex: true,
        regex,
        suffix: null,
        specificity: key.length,
      });
    } else {
      const suffix = ruleSuffix(key);
      rules.push({
        key,
        info,
        order,
        isRegex: false,
        regex: null,
        suffix,
        specificity: suffix.length,
      });
    }
  }

  return { rules, invalid };
}

/**
 * Scores a single compiled rule against a URL and its hostname.
 * @returns {number} 0 when the rule does not match.
 */
function scoreRule(rule, url, domain) {
  if (rule.isRegex) {
    return rule.regex.test(url) ? SCORE_REGEX : 0;
  }
  if (!domain) return 0;
  if (domain === rule.suffix) {
    // A bare `example.com` rule is an exact match for `example.com` itself;
    // a `*.example.com` rule is only ever a suffix match.
    return rule.key.startsWith("*.") ? SCORE_SUFFIX : SCORE_EXACT;
  }
  if (domain.endsWith(`.${rule.suffix}`)) return SCORE_SUFFIX;
  return 0;
}

/**
 * Finds the most specific matching rule.
 *
 * Precedence: an exact hostname match beats a suffix match, a suffix match
 * beats a regex. Within a tier, a more specific rule wins: for domain rules
 * that means a longer suffix (so `mail.google.com` beats `*.google.com`);
 * for regex rules it means a longer pattern (so
 * `https://github.com/whamcloud/ansible.*` beats a broad catch-all like
 * `https://github.com/e.*`). Insertion order is only the final tie-break.
 *
 * @param {string} url
 * @param {Array<object>} compiledRules - from `compileRules().rules`
 * @returns {{key: string, info: object}|null}
 */
export function matchCompiledRules(url, compiledRules) {
  const domain = getDomain(url);
  let best = null;
  let bestScore = 0;

  for (const rule of compiledRules) {
    const score = scoreRule(rule, url, domain);
    if (score === 0) continue;

    if (
      best === null ||
      score > bestScore ||
      (score === bestScore &&
        (rule.specificity ?? 0) > (best.specificity ?? 0))
    ) {
      best = rule;
      bestScore = score;
    }
  }

  return best ? { key: best.key, info: best.info } : null;
}

/**
 * Convenience wrapper that compiles and matches in one step. Callers that
 * match many URLs should use `compileRules` once instead.
 * @param {string} url
 * @param {object} domainGroups
 * @returns {{key: string, info: object}|null}
 */
export function matchRule(url, domainGroups) {
  return matchCompiledRules(url, compileRules(domainGroups).rules);
}

/**
 * Validates a rule before it is saved.
 * @param {string} key
 * @param {string} title
 * @param {boolean} isRegex
 * @returns {string|null} An error message, or null when the rule is valid.
 */
export function validateRule(key, title, isRegex) {
  if (!key) return "Enter a domain or regex pattern.";
  if (!title) return "Enter a group title.";
  if (isRegex) {
    try {
      new RegExp(key);
    } catch (error) {
      return `Invalid regex: ${error.message}`;
    }
  }
  return null;
}

/**
 * Derives a rule key and group title from a hostname, used by "Add Current".
 * @param {string} hostname
 * @returns {{ruleKey: string, title: string}}
 */
export function deriveRuleFromHostname(hostname) {
  const domain = hostname.replace(/^www\./, "");
  const parts = domain.split(".");
  return {
    ruleKey: parts.length > 2 ? `*.${parts.slice(-2).join(".")}` : domain,
    title: parts.length > 1 ? parts.slice(-2).join(".") : domain,
  };
}
