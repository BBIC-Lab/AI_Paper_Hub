const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app/secret.session.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function testSecretStep2HeaderAndCards() {
  assert.ok(source.includes('id="secret-setup-step2-heading">密钥配置（必要）</h2>'));
  assert.ok(source.includes('<div class="secret-setup-step2-top-icon">🔐</div>'));
  assert.ok(source.includes('<div class="secret-setup-step2-title">GitHub Token</div>'));
  assert.ok(source.includes('<div class="secret-setup-step2-title">论文工作流大模型</div>'));
  assert.ok(source.includes('<div class="secret-setup-step2-title">聊天区大模型</div>'));
  assert.ok(source.indexOf('GitHub Token') < source.indexOf('论文工作流大模型'));
  assert.ok(source.indexOf('论文工作流大模型') < source.indexOf('聊天区大模型'));
}

function testSecretStep2KeepsExpandedChatConfigInsideChatCard() {
  const chatCardStart = source.indexOf('id="secret-setup-chat-section"');
  const customPanel = source.indexOf('id="secret-setup-custom-section"', chatCardStart);
  const chatCardEnd = source.indexOf('</div>\n            </div>\n          </div>\n\n          <div class="secret-setup-step2-footer">', chatCardStart);
  assert.ok(chatCardStart > 0);
  assert.ok(customPanel > chatCardStart);
  assert.ok(customPanel < chatCardEnd);
  assert.ok(source.includes('class="secret-setup-inline-panel"'));
}

function testSecretStep2CssMatchesAdvancedModalShape() {
  assert.ok(css.includes('width: min(940px, 100%);'));
  assert.ok(css.includes('grid-template-rows: auto minmax(0, 1fr) auto;'));
  assert.ok(css.includes('.secret-setup-step2-top-card'));
  assert.ok(css.includes('.secret-setup-step2-scroll'));
  assert.ok(css.includes('grid-template-columns: minmax(0, 1fr);'));
  assert.ok(css.includes('.secret-gate-modal.secret-gate-modal-step2 .secret-gate-actions'));
}

function testSecretSessionCacheBusted() {
  assert.ok(html.includes('app/secret.session.js?v=secret-modal-cards-20260610'));
  assert.ok(html.includes('app/app.css?v=secret-modal-cards-20260610'));
}

testSecretStep2HeaderAndCards();
testSecretStep2KeepsExpandedChatConfigInsideChatCard();
testSecretStep2CssMatchesAdvancedModalShape();
testSecretSessionCacheBusted();

console.log('secret session UI tests passed');
