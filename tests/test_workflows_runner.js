const assert = require('node:assert/strict');

global.window = global.window || {};
global.document = global.document || {
  readyState: 'loading',
  addEventListener() {},
};

require('../app/workflows.runner.js');

const {
  WORKFLOWS,
  getWorkflowByKey,
  buildPeriodicReportInputs,
} = global.window.DPRWorkflowRunner.__test;

function testPeriodicWorkflowIsRegistered() {
  const workflow = getWorkflowByKey('periodic-report');

  assert.ok(workflow, 'periodic-report workflow should be registered');
  assert.equal(workflow.id, 'periodic-report.yml');
  assert.equal(workflow.dispatchInputs.period, 'weekly');
  assert.equal(workflow.dispatchInputs.input_mode, 'artifacts');
  assert.equal(workflow.dispatchInputs.dry_run, 'false');
  assert.ok(WORKFLOWS.some((item) => item.key === 'periodic-report'));
}

function testBuildPeriodicReportInputsNormalizesAndMerges() {
  const inputs = buildPeriodicReportInputs('MONTHLY', 'HYBRID', {
    dispatchInputs: {
      fetch_days: '30',
      profile_tag: 'GENE',
      dry_run: 'true',
    },
  });

  assert.deepEqual(inputs, {
    period: 'monthly',
    input_mode: 'hybrid',
    dry_run: 'true',
    fetch_days: '30',
    profile_tag: 'GENE',
  });
}

function testBuildPeriodicReportInputsFallsBackSafely() {
  const inputs = buildPeriodicReportInputs('yearly', 'expensive', {});

  assert.equal(inputs.period, 'weekly');
  assert.equal(inputs.input_mode, 'artifacts');
  assert.equal(inputs.dry_run, 'false');
}

testPeriodicWorkflowIsRegistered();
testBuildPeriodicReportInputsNormalizesAndMerges();
testBuildPeriodicReportInputsFallsBackSafely();

console.log('workflow runner tests passed');
