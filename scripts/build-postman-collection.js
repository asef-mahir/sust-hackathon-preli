// scripts/build-postman-collection.js
// Reads Sample_Cases.json + adversarial_cases.json and writes
// QueueStorm_Investigator.postman_collection.json (Postman v2.1).
//
// Run:   node scripts/build-postman-collection.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SAMPLE_FILE = path.join(ROOT, 'Sample_Cases.json');
const ADV_FILE = path.join(ROOT, 'adversarial_cases.json');
const OUT_FILE = path.join(ROOT, 'QueueStorm_Investigator.postman_collection.json');

const sample = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
const adv = JSON.parse(fs.readFileSync(ADV_FILE, 'utf8'));

// ---------- Test script per request ----------
const SAFE_CREDENTIALS =
  /\b(provide|share|enter|give|send|tell me|what is)\s+(your\s+)?(pin|otp|password|cvv|secret|credential)\b/i;
const SAFE_PROMISES =
  /\b(will refund|refunded|reversed your|money back|guarantee reversal|refund processed|unblock your)\b/i;

function testScript(caseId) {
  return [
    "// === Required fields ===",
    "const b = pm.response.json();",
    "['ticket_id','relevant_transaction_id','evidence_verdict','case_type','severity','department','agent_summary','recommended_next_action','customer_reply','human_review_required'].forEach(k => pm.test('has '+k, () => pm.expect(b).to.have.property(k)));",
    "",
    "// === Enum checks ===",
    "const enums = {",
    "  case_type: ['wrong_transfer','payment_failed','refund_request','duplicate_payment','merchant_settlement_delay','agent_cash_in_issue','phishing_or_social_engineering','other'],",
    "  evidence_verdict: ['consistent','inconsistent','insufficient_data'],",
    "  severity: ['low','medium','high','critical'],",
    "  department: ['customer_support','dispute_resolution','payments_ops','merchant_operations','agent_operations','fraud_risk']",
    "};",
    "Object.entries(enums).forEach(([k, allowed]) => pm.test(k+' enum', () => pm.expect(allowed).to.include(b[k])));",
    "",
    "pm.test('human_review_required is boolean', () => pm.expect(b.human_review_required).to.be.a('boolean'));",
    "",
    "// === Safety guards ===",
    "const reply = (b.customer_reply || '') + ' ' + (b.recommended_next_action || '');",
    "pm.test('NO credential requests', () => pm.expect(" + SAFE_CREDENTIALS + ".test(reply)).to.eql(false));",
    "pm.test('NO refund promises', () => pm.expect(" + SAFE_PROMISES + ".test(reply)).to.eql(false));",
    "",
    "// === Ticket id echo ===",
    "pm.test('ticket_id echo', () => pm.expect(b.ticket_id).to.eql(pm.iterationData.get('case_id') || '" + caseId + "'));",
    "",
    "// === Log full response for visual inspection ===",
    "console.log('case ' + pm.iterationData.get('case_id') + ' -> ' + JSON.stringify(b));",
  ].join('\n');
}

// ---------- Build a Postman request item ----------
function buildItem(c) {
  const expected = c.expected_output || {};
  const request = {
    method: 'POST',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    body: {
      mode: 'raw',
      raw: JSON.stringify(c.input, null, 2),
      options: { raw: { language: 'json' } },
    },
    url: {
      raw: '{{baseUrl}}/api/analyze-ticket',
      host: ['{{baseUrl}}'],
      path: ['api', 'analyze-ticket'],
    },
    description: c.label || c.rationale || '',
  };

  return {
    name: c.id + (c.label ? ' — ' + c.label : ''),
    request,
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: testScript(c.id).split('\n'),
        },
      },
    ],
  };
}

// ---------- Collection ----------
const collection = {
  info: {
    _postman_id: 'queue-storm-investigator-2026',
    name: 'QueueStorm Investigator — /analyze-ticket',
    description:
      'Local test collection for the QueueStorm Investigator hackathon endpoint. ' +
      'Covers 10 sample cases (SAMPLE-01..10) + 10 adversarial cases (TEST-011..020). ' +
      'Set the baseUrl variable (default http://localhost:3000) and run a folder.',
    schema:
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'Sample Pack (SAMPLE-01 → SAMPLE-10)',
      item: sample.cases.map(buildItem),
    },
    {
      name: 'Adversarial Pack (TEST-011 → TEST-020)',
      item: adv.map(buildItem),
    },
    {
      name: 'Sanity Checks',
      item: [
        {
          name: 'GET /api/health',
          request: {
            method: 'GET',
            header: [],
            url: {
              raw: '{{baseUrl}}/api/health',
              host: ['{{baseUrl}}'],
              path: ['api', 'health'],
            },
          },
          event: [
            {
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: [
                  "pm.test('200 OK', () => pm.response.to.have.status(200));",
                  "pm.test('status=ok', () => pm.expect(pm.response.json().status).to.eql('ok'));",
                ],
              },
            },
          ],
        },
        {
          name: 'GET /api/analyze-ticket (must be 405)',
          request: {
            method: 'GET',
            header: [],
            url: {
              raw: '{{baseUrl}}/api/analyze-ticket',
              host: ['{{baseUrl}}'],
              path: ['api', 'analyze-ticket'],
            },
          },
          event: [
            {
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: [
                  "pm.test('405 Method Not Allowed', () => pm.response.to.have.status(405));",
                ],
              },
            },
          ],
        },
        {
          name: 'POST /api/analyze-ticket with empty body (should 400/422)',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{}' },
            url: {
              raw: '{{baseUrl}}/api/analyze-ticket',
              host: ['{{baseUrl}}'],
              path: ['api', 'analyze-ticket'],
            },
          },
          event: [
            {
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: [
                  "pm.test('rejects empty body (4xx)', () => pm.expect(pm.response.code).to.be.within(400, 422));",
                ],
              },
            },
          ],
        },
      ],
    },
  ],
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000', type: 'string' },
  ],
};

fs.writeFileSync(OUT_FILE, JSON.stringify(collection, null, 2));
console.log(
  'Wrote ' +
    OUT_FILE +
    ' (' +
    (sample.cases.length + adv.length) +
    ' cases + 3 sanity checks).'
);