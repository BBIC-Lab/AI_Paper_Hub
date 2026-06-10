const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('app/docsify-plugin.js', 'utf8');

assert.ok(
  source.includes('const classifyDocsRoute = (...candidates) =>'),
  'route handling should be centralized instead of duplicated across page features',
);
assert.match(
  source,
  /dpr-periodic-report-page/,
  'periodic report pages should get a dedicated body class',
);
assert.match(
  source,
  /isReportPage && !isPeriodicReportPage/,
  'legacy daily report enhancer should not run on periodic pages',
);
assert.match(
  source,
  /bindPeriodicEvidenceToggles/,
  'periodic report evidence strips should bind explicit toggle buttons',
);
assert.match(
  source,
  /dpr-weekly-evidence-toggle/,
  'weekly evidence expansion should only be wired through the toggle button',
);
assert.match(
  source,
  /if \(isPaperPage && window\.PrivateDiscussionChat\)/,
  'private discussion chat should be initialized only on paper pages',
);
assert.doesNotMatch(
  source,
  /!isLandingLikePage && window\.PrivateDiscussionChat/,
  'non-paper pages should not rely on a broad negative allow-list for chat suppression',
);

console.log('docsify periodic route tests passed');
