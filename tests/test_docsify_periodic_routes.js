const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('app/docsify-plugin.js', 'utf8');

assert.ok(
  source.includes('/^reports\\/(?:weekly|monthly)(?:\\/[^/]+)?\\/README\\.md$/i.test(f)'),
  'periodic report routes should be treated as report pages',
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

console.log('docsify periodic route tests passed');
