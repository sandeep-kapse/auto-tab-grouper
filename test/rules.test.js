import test from "node:test";
import assert from "node:assert/strict";

import {
  compileRules,
  deriveRuleFromHostname,
  getDomain,
  isRuleEnabled,
  matchRule,
  ruleSuffix,
  validateRule,
} from "../rules.js";

const rule = (title, extra = {}) => ({ title, color: "blue", ...extra });

test("getDomain extracts hostnames", () => {
  assert.equal(
    getDomain("https://mail.google.com/mail/u/0"),
    "mail.google.com"
  );
  assert.equal(getDomain("http://example.com"), "example.com");
});

test("getDomain returns null for URLs with no host", () => {
  assert.equal(getDomain("about:blank"), null);
  assert.equal(getDomain("not a url"), null);
  assert.equal(getDomain(""), null);
  assert.equal(getDomain(undefined), null);
});

test("ruleSuffix strips the wildcard prefix", () => {
  assert.equal(ruleSuffix("*.example.com"), "example.com");
  assert.equal(ruleSuffix("example.com"), "example.com");
});

test("isRuleEnabled defaults to true for rules saved before the flag existed", () => {
  assert.equal(isRuleEnabled({}), true);
  assert.equal(isRuleEnabled({ enabled: true }), true);
  assert.equal(isRuleEnabled({ enabled: false }), false);
});

test("an exact host rule matches", () => {
  const match = matchRule("https://example.com/x", {
    "example.com": rule("Example"),
  });
  assert.equal(match.info.title, "Example");
});

test("a wildcard rule matches subdomains and the apex", () => {
  const rules = { "*.example.com": rule("Example") };
  assert.equal(
    matchRule("https://a.example.com/", rules).info.title,
    "Example"
  );
  assert.equal(matchRule("https://example.com/", rules).info.title, "Example");
});

test("a wildcard rule does not match a lookalike domain", () => {
  const rules = { "*.example.com": rule("Example") };
  assert.equal(matchRule("https://notexample.com/", rules), null);
  assert.equal(matchRule("https://example.com.evil.net/", rules), null);
});

test("a more specific rule wins even when added after a broad one", () => {
  // Regression guard: matching used to break on the first Object.entries hit,
  // so insertion order silently decided precedence.
  const rules = {
    "*.google.com": rule("Google"),
    "mail.google.com": rule("Mail"),
  };
  assert.equal(matchRule("https://mail.google.com/", rules).info.title, "Mail");
});

test("the longer suffix wins between two wildcard rules", () => {
  const rules = {
    "*.co.uk": rule("UK"),
    "*.bbc.co.uk": rule("BBC"),
  };
  assert.equal(matchRule("https://news.bbc.co.uk/", rules).info.title, "BBC");
});

test("a literal rule beats a regex that also matches", () => {
  const rules = {
    ".*\\.com": rule("Regex", { isRegex: true }),
    "example.com": rule("Literal"),
  };
  assert.equal(matchRule("https://example.com/", rules).info.title, "Literal");
});

test("regex rules match against the full URL", () => {
  const rules = { "^https://.*/docs/": rule("Docs", { isRegex: true }) };
  assert.equal(matchRule("https://any.site/docs/x", rules).info.title, "Docs");
  assert.equal(matchRule("https://any.site/blog/x", rules), null);
});

test("disabled rules are ignored", () => {
  const rules = { "example.com": rule("Example", { enabled: false }) };
  assert.equal(matchRule("https://example.com/", rules), null);
});

test("an invalid regex is reported and skipped, never thrown", () => {
  const rules = {
    "([": rule("Broken", { isRegex: true }),
    "example.com": rule("Example"),
  };
  const { rules: compiled, invalid } = compileRules(rules);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].key, "([");
  assert.equal(compiled.length, 1);
  assert.equal(matchRule("https://example.com/", rules).info.title, "Example");
});

test("compileRules tolerates a missing rule map", () => {
  assert.deepEqual(compileRules(undefined).rules, []);
});

test("no rules means no match", () => {
  assert.equal(matchRule("https://example.com/", {}), null);
});

test("validateRule rejects empty fields and bad regexes", () => {
  assert.match(validateRule("", "Title", false), /domain or regex/i);
  assert.match(validateRule("example.com", "", false), /group title/i);
  assert.match(validateRule("([", "Title", true), /invalid regex/i);
  assert.equal(validateRule("([", "Title", false), null);
  assert.equal(validateRule("example.com", "Title", false), null);
});

test("deriveRuleFromHostname builds a wildcard for subdomains", () => {
  assert.deepEqual(deriveRuleFromHostname("mail.google.com"), {
    ruleKey: "*.google.com",
    title: "google.com",
  });
  assert.deepEqual(deriveRuleFromHostname("www.example.com"), {
    ruleKey: "example.com",
    title: "example.com",
  });
  assert.deepEqual(deriveRuleFromHostname("localhost"), {
    ruleKey: "localhost",
    title: "localhost",
  });
});

// --- Edge cases ---

test("hostnames are matched without the port", () => {
  const rules = { "example.com": rule("Example") };
  assert.equal(
    matchRule("https://example.com:8443/x", rules).info.title,
    "Example"
  );
});

test("hostname case is normalised by the URL parser", () => {
  const rules = { "example.com": rule("Example") };
  assert.equal(
    matchRule("https://EXAMPLE.COM/path", rules).info.title,
    "Example"
  );
});

test("a wildcard rule does not match a partial label", () => {
  // *.example.com must not swallow "myexample.com".
  const rules = { "*.example.com": rule("Example") };
  assert.equal(matchRule("https://myexample.com/", rules), null);
  assert.equal(matchRule("https://a.myexample.com/", rules), null);
});

test("deep subdomains still match a wildcard rule", () => {
  const rules = { "*.example.com": rule("Example") };
  assert.equal(
    matchRule("https://a.b.c.d.example.com/", rules).info.title,
    "Example"
  );
});

test("an exact rule beats a wildcard on a deep subdomain", () => {
  const rules = {
    "*.example.com": rule("Broad"),
    "a.b.example.com": rule("Narrow"),
  };
  assert.equal(
    matchRule("https://a.b.example.com/", rules).info.title,
    "Narrow"
  );
});

test("IP address hosts match exactly", () => {
  const rules = { "127.0.0.1": rule("Local") };
  assert.equal(
    matchRule("http://127.0.0.1:3000/app", rules).info.title,
    "Local"
  );
  assert.equal(matchRule("http://127.0.0.2:3000/", rules), null);
});

test("localhost matches without a dot in the host", () => {
  const rules = { localhost: rule("Local") };
  assert.equal(matchRule("http://localhost:5173/", rules).info.title, "Local");
});

test("non-http schemes with no host never match", () => {
  const rules = { "example.com": rule("Example") };
  for (const url of ["about:blank", "chrome://extensions", "file:///tmp/x"]) {
    assert.equal(matchRule(url, rules), null, url);
  }
});

test("a chrome-extension URL does not match a domain rule", () => {
  const rules = { "example.com": rule("Example") };
  assert.equal(matchRule("chrome-extension://abcdef/popup.html", rules), null);
});

test("between two matching regexes the longer (more specific) one wins", () => {
  const rules = {
    "^https://a\\.": rule("Broad", { isRegex: true }),
    "^https://a\\.example": rule("Narrow", { isRegex: true }),
  };
  assert.equal(
    matchRule("https://a.example.com/", rules).info.title,
    "Narrow"
  );
});

test("a broad catch-all regex loses to a narrower regex regardless of order", () => {
  const rules = {
    "https://github.com/e.*": rule("github others", { isRegex: true }),
    "https://github.com/whamcloud/ansible.*": rule("EXAScaler github", {
      isRegex: true,
    }),
  };
  assert.equal(
    matchRule("https://github.com/whamcloud/ansible/pulls", rules).info.title,
    "EXAScaler github"
  );
  assert.equal(
    matchRule("https://github.com/example/repo", rules).info.title,
    "github others"
  );
});

test("a regex is matched against the whole URL, not just the host", () => {
  const rules = { "example\\.com/admin": rule("Admin", { isRegex: true }) };
  assert.equal(
    matchRule("https://example.com/admin/users", rules).info.title,
    "Admin"
  );
  assert.equal(matchRule("https://example.com/public", rules), null);
});

test("an unanchored regex can still match mid-URL", () => {
  const rules = { "/issues/": rule("Issues", { isRegex: true }) };
  assert.equal(
    matchRule("https://github.com/x/y/issues/1", rules).info.title,
    "Issues"
  );
});

test("a disabled regex rule is skipped and falls through", () => {
  const rules = {
    "^https://": rule("Everything", { isRegex: true, enabled: false }),
    "example.com": rule("Example"),
  };
  assert.equal(matchRule("https://example.com/", rules).info.title, "Example");
});

test("disabling the specific rule falls back to the broad one", () => {
  const rules = {
    "*.google.com": rule("Google"),
    "mail.google.com": rule("Mail", { enabled: false }),
  };
  assert.equal(
    matchRule("https://mail.google.com/", rules).info.title,
    "Google"
  );
});

test("a bare rule also covers its subdomains, but exact wins", () => {
  const rules = {
    "example.com": rule("Broad"),
    "shop.example.com": rule("Shop"),
  };
  assert.equal(matchRule("https://a.example.com/", rules).info.title, "Broad");
  assert.equal(
    matchRule("https://shop.example.com/", rules).info.title,
    "Shop"
  );
});

test("a wildcard and a bare rule for the same domain tie predictably", () => {
  // Both are suffix matches of identical length; the first declared wins.
  const rules = {
    "*.example.com": rule("Wild"),
    "example.com": rule("Bare"),
  };
  assert.equal(matchRule("https://a.example.com/", rules).info.title, "Wild");
});

test("every rule being invalid leaves no matches and no throw", () => {
  const rules = {
    "([": rule("A", { isRegex: true }),
    "(?<": rule("B", { isRegex: true }),
  };
  const { rules: compiled, invalid } = compileRules(rules);
  assert.equal(compiled.length, 0);
  assert.equal(invalid.length, 2);
  assert.equal(matchRule("https://example.com/", rules), null);
});

test("a rule with an empty title is still matchable", () => {
  // The options page blocks these, but rules synced from an older version
  // must not crash the matcher.
  const rules = { "example.com": { title: "", color: "grey", enabled: true } };
  assert.equal(matchRule("https://example.com/", rules).info.title, "");
});

test("deriveRuleFromHostname handles multi-part public suffixes imperfectly", () => {
  // Documented limitation: there is no public-suffix list, so a co.uk domain
  // collapses to the last two labels.
  assert.deepEqual(deriveRuleFromHostname("news.bbc.co.uk"), {
    ruleKey: "*.co.uk",
    title: "co.uk",
  });
});
