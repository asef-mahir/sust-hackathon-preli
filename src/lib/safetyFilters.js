export function applySafetyFilters(jsonOutput, originalRequestData) {
  // 1. Force structural integrity & ensure ticket_id is ALWAYS echoed
  // Using originalRequestData as a fail-safe in case the LLM dropped it.
  jsonOutput.ticket_id = jsonOutput.ticket_id || (originalRequestData && originalRequestData.ticket_id) || "UNKNOWN-TICKET";
  
  jsonOutput.customer_reply = jsonOutput.customer_reply || "Your ticket has been received and is currently under review by our support team.";
  jsonOutput.recommended_next_action = jsonOutput.recommended_next_action || "Review transaction history.";
  jsonOutput.human_review_required = typeof jsonOutput.human_review_required === 'boolean' ? jsonOutput.human_review_required : true;
  jsonOutput.agent_summary = jsonOutput.agent_summary || "Automated summary generation failed. Please review manually.";
  
  // 2. Setup Regex for safety (Upgraded to catch LLM paraphrasing and third-party routing)
  const unsafeCredentialPattern = /\b(provide|share|enter|give|send|tell me|what is)\s+(your\s+)?(pin|otp|password|cvv|secret|credential|code|4-digit|login|token)\b/i;
  const unauthorizedPromisePattern = /\b(will refund|refunded|reversed your|money back|guarantee reversal|refund processed|unblock your)\b/i;
  const suspiciousRoutingPattern = /\b(whatsapp|telegram|facebook|dm us|message us on|call this number)\b/i;

  let guardrailTriggered = false;

  // 3. Rule 1 Verification: No credential collection requests
  if (unsafeCredentialPattern.test(jsonOutput.customer_reply)) {
    jsonOutput.customer_reply = "We have escalated your issue to our specialized operations team. For your security, remember that our platform will never ask you for your PIN, OTP, or password.";
    guardrailTriggered = true;
  }

  // 4. Rule 2 Verification: No unauthorized procedural promises
  if (
    unauthorizedPromisePattern.test(jsonOutput.customer_reply) || 
    unauthorizedPromisePattern.test(jsonOutput.recommended_next_action)
  ) {
    jsonOutput.customer_reply = "We have logged your complaint and tracked the associated transaction lifecycle. Any eligible balance adjustments will be safely credited back through official channels upon review.";
    jsonOutput.recommended_next_action = "Route ticket to clearing operations team for ledger balance verification.";
    guardrailTriggered = true;
  }

  // 5. Rule 3 Verification: No suspicious third-party routing
  if (suspiciousRoutingPattern.test(jsonOutput.customer_reply)) {
    jsonOutput.customer_reply = "Please reach out to us exclusively through the official in-app support chat or our verified hotline.";
    guardrailTriggered = true;
  }

  // 6. Apply penalty flags if any rule was broken
  if (guardrailTriggered) {
    jsonOutput.human_review_required = true;
    jsonOutput.confidence = 0.4;
    jsonOutput.reason_codes = [...(jsonOutput.reason_codes || []), "safety_guardrail_override"];
  }

  return jsonOutput;
}
