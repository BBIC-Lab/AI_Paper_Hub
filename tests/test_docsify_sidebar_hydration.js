const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'docsify-plugin.js'), 'utf8');

assert.match(source, /const titleZh = String\(\(payload && \(payload\.title_zh \|\| payload\.titleZh\)\) \|\| ''\)\.trim\(\);/);
assert.match(source, /const secondaryLine = titleZh \|\| evidence \|\| '-';/);
assert.match(source, /<div class="dpr-sidebar-link-line">\$\{escapeHtml\(secondaryLine\)\}<\/div>/);

console.log('docsify sidebar hydration tests passed');
