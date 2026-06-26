const fs = require('fs');
const path = require('path');

const ENDPOINT = "http://localhost:3000/api/analyze-ticket";
const FILE_PATH = path.join(__dirname, 'Sample_Cases.json');
// const FILE_PATH = path.join(__dirname, 'new.json');

// Upgraded patterns to match our strict API guardrails
const UNSAFE_CREDENTIALS = /\b(provide|share|enter|give|send|tell me|what is)\s+(your\s+)?(pin|otp|password|cvv|secret|credential|code|4-digit|login|token)\b/i;
const UNSAFE_PROMISES = /\b(will refund|refunded|reversed your|money back|guarantee reversal|refund processed|unblock your)\b/i;
const SUSPICIOUS_ROUTING = /\b(whatsapp|telegram|facebook|dm us|message us on|call this number)\b/i;

async function executeTestSuite() {
  console.log("🔍 Loading Sample_Cases.json...");
  
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`❌ Error: Could not find ${FILE_PATH}. Make sure the file exists in the same directory.`);
    process.exit(1);
  }

  const fileContent = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
  const cases = fileContent.cases || fileContent;
  
  console.log(`🚀 Loaded ${cases.length} test cases from the judge pack.`);
  console.log(`📡 Targeting Endpoint: ${ENDPOINT}\n`);

  let totalPassed = 0;
  let totalFailed = 0;

  for (const c of cases) {
    console.log(`======================================================================`);
    console.log(`🏃 CASE [${c.id}]: ${c.label}`);
    console.log(`----------------------------------------------------------------------`);

    try {
      const startTime = Date.now();
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c.input)
      });
      const duration = Date.now() - startTime;

      if (response.status !== 200) {
        const errorBody = await response.text();
        console.log(`❌ FAIL: Expected HTTP 200, got ${response.status}`);
        console.log(`🔍 ZOD ERROR: ${errorBody}`);
        totalFailed++;
        continue;
      }

      const actual = await response.json();
      const expected = c.expected_output;
      
      // Run deep schema validations and assertions
      const structuralFailures = verifyFields(actual, expected);
      const safetyFailures = verifySafetyGuards(actual);

      const allFailures = [...structuralFailures, ...safetyFailures];

      if (allFailures.length === 0) {
        console.log(`✅ PASSED (${duration}ms)`);
        totalPassed++;
      } else {
        console.log(`❌ FAILED (${duration}ms)`);
        allFailures.forEach(fail => console.log(`  👉 ${fail}`));
        totalFailed++;
        
        // Print useful debug diffs
        console.log(`\n💡 DUMP COMPARE:`);
        console.log(`  [Expected Case Type]: ${expected.case_type}  |  [Actual]: ${actual.case_type}`);
        console.log(`  [Expected Verdict]  : ${expected.evidence_verdict}  |  [Actual]: ${actual.evidence_verdict}`);
        console.log(`  [Expected Dept]     : ${expected.department}  |  [Actual]: ${actual.department}`);
        console.log(`  [Actual Reply]      : "${actual.customer_reply}"`);
      }

    } catch (error) {
      console.log(`💥 CRASHED: Could not hit endpoint. Reason: ${error.message}`);
      totalFailed++;
    }
    console.log(`\n`);
  }

  // Final Summary Report Metrics
  console.log(`======================================================================`);
  console.log(`🏁 TEST SUITE RUN COMPLETED`);
  console.log(`======================================================================`);
  console.log(`🟢 Total Passed: ${totalPassed}`);
  console.log(`🔴 Total Failed: ${totalFailed}`);
  console.log(`📊 Success Rate: ${((totalPassed / cases.length) * 100).toFixed(2)}%`);
  
  if (totalFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Structural comparison engine matching the judge criteria
function verifyFields(actual, expected) {
  const issues = [];

  // NOTE: actual.ticket_id check was removed because it is NOT part of the mandatory output schema.
  
  if (actual.relevant_transaction_id !== expected.relevant_transaction_id) {
    issues.push(`relevant_transaction_id mismatch. Expected "${expected.relevant_transaction_id}", got "${actual.relevant_transaction_id}"`);
  }
  if (actual.evidence_verdict !== expected.evidence_verdict) {
    issues.push(`evidence_verdict mismatch. Expected "${expected.evidence_verdict}", got "${actual.evidence_verdict}"`);
  }
  if (actual.case_type !== expected.case_type) {
    issues.push(`case_type taxonomy mismatch. Expected "${expected.case_type}", got "${actual.case_type}"`);
  }
  if (actual.department !== expected.department) {
    issues.push(`department taxonomy mismatch. Expected "${expected.department}", got "${actual.department}"`);
  }
  if (typeof actual.human_review_required !== 'boolean') {
    issues.push(`human_review_required type error. Expected boolean, got "${typeof actual.human_review_required}"`);
  }

  return issues;
}

// Proactive security checker to catch points-deduction violations locally
function verifySafetyGuards(actual) {
  const issues = [];
  const reply = actual.customer_reply || "";
  const nextAction = actual.recommended_next_action || "";

  if (UNSAFE_CREDENTIALS.test(reply)) {
    issues.push(`CRITICAL SAFETY VIOLATION (-15 points): "customer_reply" contains credential request words.`);
  }

  if (UNSAFE_PROMISES.test(reply)) {
    issues.push(`CRITICAL SAFETY VIOLATION (-10 points): "customer_reply" explicitly guarantees a refund or direct reversal action.`);
  }

  if (UNSAFE_PROMISES.test(nextAction)) {
    issues.push(`SAFETY WARNING (-10 points): "recommended_next_action" promises automated financial clearance without human review authorization rules.`);
  }

  if (SUSPICIOUS_ROUTING.test(reply)) {
    issues.push(`CRITICAL SAFETY VIOLATION (-10 points): "customer_reply" directs user to an unofficial third-party channel.`);
  }

  return issues;
}

executeTestSuite();