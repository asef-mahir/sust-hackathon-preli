export function applySafetyFilters(jsonOutput, originalTicketId) {
  // 1. Force structural integrity & ensure ticket_id is ALWAYS echoed
  // FIXED: Using originalTicketId directly since it's passed as a string
  jsonOutput.ticket_id = jsonOutput.ticket_id || originalTicketId || "UNKNOWN-TICKET";
  
  jsonOutput.customer_reply = jsonOutput.customer_reply || "Your ticket has been received and is currently under review by our support team.";
  jsonOutput.recommended_next_action = jsonOutput.recommended_next_action || "Review transaction history.";
  jsonOutput.human_review_required = typeof jsonOutput.human_review_required === 'boolean' ? jsonOutput.human_review_required : true;
  jsonOutput.agent_summary = jsonOutput.agent_summary || "Automated summary generation failed. Please review manually.";
  
  // 2. Setup Regex for safety (Upgraded to match Section 8 exact wording)
  // ADDED: "card number", "card details", broadened verbs to catch sneaky LLM phrasing
  const unsafeCredentialPattern = /\b(provide|share|enter|give|send|tell me|what is|verify|confirm)\s+(your\s+)?(pin|otp|password|cvv|secret|credential|code|4-digit|login|token|card number|card details)\b/i;
  
  // ADDED: "recovery", "recover", "unblock", "restore"
  const unauthorizedPromisePattern = /\b(will refund|refunded|reversed your|money back|guarantee reversal|refund processed|unblock your|unblock the account|recover your|recovery of|will be returned to you)\b/i;
  
  const suspiciousRoutingPattern = /\b(whatsapp|telegram|facebook|dm us|message us on|call this number)\b/i;

  let guardrailTriggered = false;

  // 3. Rule 1 Verification: No credential collection requests
  if (unsafeCredentialPattern.test(jsonOutput.customer_reply)) {
    jsonOutput.customer_reply = "We have escalated your issue to our specialized operations team. For your security, remember that our platform will never ask you for your PIN, OTP, password, or full card number.";
    guardrailTriggered = true;
  }

  // 4. Rule 2 Verification: No unauthorized procedural promises
  // Checks BOTH customer_reply and recommended_next_action per Section 8
  if (
    unauthorizedPromisePattern.test(jsonOutput.customer_reply) || 
    unauthorizedPromisePattern.test(jsonOutput.recommended_next_action)
  ) {
    jsonOutput.customer_reply = "We have logged your complaint and tracked the associated transaction lifecycle. Any eligible balance adjustments will be safely credited back through official channels upon review.";
    jsonOutput.recommended_next_action = "Route ticket to operations team for ledger balance verification and authority review.";
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
    // Lower confidence slightly more to signal a high-risk LLM generation
    jsonOutput.confidence = 0.2; 
    jsonOutput.reason_codes = [...(jsonOutput.reason_codes || []), "safety_guardrail_override"];
  }

  return jsonOutput;
}