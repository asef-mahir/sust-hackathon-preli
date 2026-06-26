// src/app/api/analyze-ticket/route.js
// QueueStorm Investigator â€” POST /analyze-ticket
// Rules-only evidence engine. No LLM dependency. Safe by construction.

import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Enums (must match the QueueStorm schema exactly)
// ---------------------------------------------------------------------------
const CASE_TYPES = [
  'wrong_transfer',
  'payment_failed',
  'refund_request',
  'duplicate_payment',
  'merchant_settlement_delay',
  'agent_cash_in_issue',
  'phishing_or_social_engineering',
  'other',
];

const DEPARTMENTS = [
  'customer_support',
  'dispute_resolution',
  'payments_ops',
  'merchant_operations',
  'agent_operations',
  'fraud_risk',
];

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const VERDICTS = ['consistent', 'inconsistent', 'insufficient_data'];
const TX_TYPES = ['transfer', 'payment', 'cash_in', 'cash_out', 'settlement', 'refund'];
const TX_STATUS = ['completed', 'failed', 'pending', 'reversed'];
const LANGUAGES = ['en', 'bn', 'mixed'];
const CHANNELS = ['in_app_chat', 'call_center', 'email', 'merchant_portal', 'field_agent'];
const USER_TYPES = ['customer', 'merchant', 'agent', 'unknown'];

// ---------------------------------------------------------------------------
// Safety regexes â€” fail closed if any of these appear in customer_reply or
// recommended_next_action
// ---------------------------------------------------------------------------
const UNSAFE_CREDENTIALS =
  /\b(provide|share|enter|give|send|tell me|what is|kindly share|please share)\s+(your\s+)?(pin|otp|password|cvv|secret|credential|one[- ]time\s+password)\b/i;

const UNSAFE_PROMISES =
  /\b(will refund|refunded|reversed your|money back|guarantee reversal|refund processed|unblock your|will return your|we have refunded|will credit your)\b/i;

const UNSAFE_THIRD_PARTY =
  /\b(call\s+\d{6,}|contact\s+\d{6,}|email\s+[a-z0-9._-]+@[a-z0-9.-]+|reach us at)\b/i;

// Prompt-injection patterns stripped from the complaint BEFORE classification
const INJECTION_PATTERNS = [
  /ignore (all|any|previous|prior|the|your) (rules|instructions|prompts?)/gi,
  /disregard (all|any|previous|prior|the|your) (rules|instructions|prompts?)/gi,
  /forget (all|any|previous|prior|the|your) (rules|instructions|prompts?)/gi,
  /system\s*:\s*[^\n]+/gi,
  /you are now [^\n]+/gi,
  /reveal (your|the) system prompt/gi,
  /override (all|any|the) (rules|safety)/gi,
  /\bset\s+evidence_verdict\s*=\s*\w+/gi,
  /\bset\s+case_type\s*=\s*\w+/gi,
  /\bpromise (a )?refund\b/gi,
  /\bi (will|refund|reverse) (you|your|the)/gi,
];

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------
const TransactionSchema = z
  .object({
    transaction_id: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.enum(TX_TYPES),
    amount: z.number().nonnegative(),
    counterparty: z.string().min(1),
    status: z.enum(TX_STATUS),
  })
  .passthrough();

const InputSchema = z
  .object({
    ticket_id: z.string().min(1),
    complaint: z.string().min(1),
    language: z.enum(LANGUAGES).optional(),
    channel: z.enum(CHANNELS).optional(),
    user_type: z.enum(USER_TYPES).optional(),
    campaign_context: z.any().optional(),
    transaction_history: z.array(TransactionSchema).optional().default([]),
    metadata: z.record(z.any()).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const digitsOnly = (s) => (s || '').replace(/\D/g, '');
const lastNDigits = (s, n = 8) => digitsOnly(s).slice(-n);

function normalizeComplaint(raw) {
  if (!raw) return '';
  let text = String(raw);
  for (const pat of INJECTION_PATTERNS) text = text.replace(pat, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function extractMentionedNumbers(text) {
  return Array.from(new Set((text.match(/\b\d{6,}\b/g) || []).map(digitsOnly).filter(Boolean)));
}

function extractMentionedAmount(text) {
  const m = text.match(/\b(\d{2,7})(?:\s*(taka|tk|à§³|bdt))?\b/i);
  return m ? Number(m[1]) : null;
}

function timeWindowHours(ts) {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return Infinity;
  return Math.abs(Date.now() - t) / 36e5;
}

// ---------------------------------------------------------------------------
// Classifier â€” returns case_type from normalized complaint text
// Priority order matters: phishing > merchant_settlement > duplicate_payment >
// agent_cash_in > payment_failed > refund_request > wrong_transfer > other
// ---------------------------------------------------------------------------
function classifyCase(normalizedText, rawTextLower, transactions) {
  // 1. Phishing / social engineering â€” always wins
  if (/\b(head office|helpline|operator|customer care)\b[^.\n]*\b(asked|asking|requested|request)\b[^.\n]*\b(pin|otp|password|code|secret|verify|reverse|unblock)/i.test(normalizedText)) {
    return 'phishing_or_social_engineering';
  }
  if (/\b(phish|social engineer|scam call|fraud call|impersonat|pretend)/i.test(normalizedText)) {
    return 'phishing_or_social_engineering';
  }

  // 2. Agent cash-in mismatch
  const cashIn = transactions.find((t) => t.type === 'cash_in' && t.status === 'completed');
  const mentionsDepositCash = /\b(gave|deposited|handed|paid)\b[^.\n]*\b(cash|agent)\b/i.test(normalizedText) ||
                              /\bagent\b[^.\n]*\b(short|less|missing|partial|kept)\b/i.test(normalizedText);
  if (cashIn && mentionsDepositCash) return 'agent_cash_in_issue';

  // 3. Duplicate payment â€” â‰¥2 completed same-type same-amount to same counterparty
  const completedByKey = new Map();
  for (const t of transactions) {
    if (t.status !== 'completed') continue;
    const k = `${t.type}|${t.amount}|${t.counterparty}`;
    completedByKey.set(k, (completedByKey.get(k) || 0) + 1);
  }
  const hasDuplicates = Array.from(completedByKey.values()).some((n) => n >= 2);
  if (hasDuplicates && /\b(charged|paid|two|twice|three|duplicate|double|multiple times)\b/i.test(normalizedText)) {
    return 'duplicate_payment';
  }
  // also when history shows â‰¥2 failed attempts with one success to same biller
  if (transactions.length >= 3) {
    const failed = transactions.filter((t) => t.status === 'failed');
    const succeeded = transactions.filter((t) => t.status === 'completed');
    if (failed.length >= 1 && succeeded.length >= 1 &&
        failed.every((f) => succeeded.some((s) => s.amount === f.amount && s.counterparty === f.counterparty)) &&
        /\b(recharged|recharge|bill|billed|paid the|top[- ]?up)\b/i.test(normalizedText)) {
      return 'duplicate_payment';
    }
  }

  // 4. Merchant settlement delay
  if (/\b(merchant|seller|shop|payout|settlement|credited me|not yet received)\b/i.test(normalizedText) &&
      /\b(disburs|settle|transfer to|payout)\b/i.test(normalizedText)) {
    return 'merchant_settlement_delay';
  }

  // 5. Payment failed (status=failed or customer says balance deducted)
  const failedTx = transactions.find((t) => t.status === 'failed');
  if (failedTx && /\b(failed|didn'?t go through|not credited|not received|deducted but)/i.test(normalizedText)) {
    return 'payment_failed';
  }

  // 6. Refund request â€” explicit refund/cancel/reverse language on a completed payment
  if (/\b(refund|cancel|reverse|money back|chargeback|return my money|get my money back)\b/i.test(normalizedText) &&
      transactions.some((t) => t.status === 'completed' && (t.type === 'payment' || t.type === 'transfer'))) {
    return 'refund_request';
  }

  // 7. Wrong transfer â€” wrong-number / sent to wrong person / mistyped
  if (/\b(wrong (number|person|account)|mistype|mistyped|mis-?sent|accidentally sent|sent to the wrong|incorrect number)\b/i.test(normalizedText) ||
      /\bnot picking\b|\bnot receiving\b|\bdid not receive\b/i.test(normalizedText)) {
    return 'wrong_transfer';
  }
  // transfer + counterparty digit-mismatch between complaint and history
  const transfers = transactions.filter((t) => t.type === 'transfer' && t.status === 'completed');
  if (transfers.length > 0) {
    const mentioned = extractMentionedNumbers(normalizedText);
    const counterpartyNumbers = transfers.map((t) => lastNDigits(t.counterparty, 8));
    const sameNumber = mentioned.some((n) => counterpartyNumbers.includes(lastNDigits(n, 8)));
    const mismatched = mentioned.length > 0 && !sameNumber;
    if (mismatched && /\b(sent|transfer|sent money|bkash|nagad|rocket)\b/i.test(normalizedText)) {
      return 'wrong_transfer';
    }
    if (sameNumber && /\b(sent|transfer)\b/i.test(normalizedText)) {
      return 'wrong_transfer';
    }
  }

  // 8. Vague fallback
  return 'other';
}

// ---------------------------------------------------------------------------
// Transaction scoring â€” pick the most relevant txn for the complaint
// ---------------------------------------------------------------------------
function scoreTransaction(txn, complaintText, mentionedNumbers, mentionedAmount) {
  let score = 0;
  const reasons = [];
  const counterpartyTail = lastNDigits(txn.counterparty, 8);

  // Amount match
  if (mentionedAmount != null && txn.amount === mentionedAmount) {
    score += 4; reasons.push('amount_exact');
  } else if (mentionedAmount != null && Math.abs(txn.amount - mentionedAmount) <= 50) {
    score += 2; reasons.push('amount_close');
  }

  // Counterparty digit match (last 8)
  if (mentionedNumbers.some((n) => lastNDigits(n, 8) === counterpartyTail)) {
    score += 3; reasons.push('counterparty_exact');
  }

  // Recency â€” only count if within 48h
  const hrs = timeWindowHours(txn.timestamp);
  if (hrs <= 48) { score += 2; reasons.push('recent'); }
  else if (hrs <= 24 * 7) { score += 1; reasons.push('this_week'); }

  // Status signal â€” failed payments are often the complaint subject
  if (txn.status === 'failed') { score += 1; reasons.push('failed'); }

  // Type-weight: payments more often complained about than settlements
  if (txn.type === 'payment' || txn.type === 'transfer') { score += 1; reasons.push('high_signal_type'); }

  return { score, reasons };
}

function pickTransaction(transactions, complaintText, caseType) {
  if (!transactions || transactions.length === 0) {
    return { id: null, reasons: [], secondBestScore: 0 };
  }
  const mentionedNumbers = extractMentionedNumbers(complaintText);
  const mentionedAmount = extractMentionedAmount(complaintText);

  const scored = transactions.map((t) => ({
    txn: t,
    ...scoreTransaction(t, complaintText, mentionedNumbers, mentionedAmount),
  }));
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1]?.score ?? 0;

  // Hard filters by case type â€” pick the txn that fits the diagnosis best
  let candidate = top;
  if (caseType === 'payment_failed') {
    const failed = scored.find((s) => s.txn.status === 'failed');
    if (failed) candidate = failed;
  }
  if (caseType === 'duplicate_payment') {
    const completed = scored.find((s) => s.txn.status === 'completed');
    if (completed) candidate = completed;
  }
  if (caseType === 'wrong_transfer' || caseType === 'agent_cash_in_issue') {
    const completed = scored.find((s) => s.txn.status === 'completed');
    if (completed) candidate = completed;
  }

  // Ambiguity guard: only return a transaction if it's clearly the best
  const AMBIGUITY_GAP = 2;
  const MIN_CONFIDENCE = 3;
  const ambiguous = candidate.score - second < AMBIGUITY_GAP && candidate.score < MIN_CONFIDENCE;
  if (ambiguous && caseType === 'other') {
    return { id: null, reasons: ['ambiguous'], secondBestScore: second };
  }

  return { id: candidate.txn.transaction_id, reasons: candidate.reasons, secondBestScore: second };
}

// ---------------------------------------------------------------------------
// Verdict â€” consistent / inconsistent / insufficient_data
// ---------------------------------------------------------------------------
function determineVerdict(caseType, picked, transactions) {
  if (picked.id == null) return 'insufficient_data';

  const tx = transactions.find((t) => t.transaction_id === picked.id);

  // Payment failed => always consistent with complaint
  if (caseType === 'payment_failed') return 'consistent';

  // Agent cash-in mismatch â€” completed txn exists, customer says wrong amount => inconsistent
  if (caseType === 'agent_cash_in_issue') return 'inconsistent';

  // Duplicate payment â€” same amount billed multiple times => inconsistent
  if (caseType === 'duplicate_payment') return 'inconsistent';

  // Wrong transfer â€” the complaint is that money went somewhere, so the txn
  // being there is consistent with the claim; but inconsistency comes from
  // repeated same-counterparty transfers
  if (caseType === 'wrong_transfer') {
    const sameTargetCount = transactions.filter(
      (t) => t.type === 'transfer' && t.status === 'completed' &&
             lastNDigits(t.counterparty, 8) === lastNDigits(tx.counterparty, 8),
    ).length;
    return sameTargetCount >= 2 ? 'inconsistent' : 'consistent';
  }

  // Phishing with no transaction => insufficient_data
  if (caseType === 'phishing_or_social_engineering') return 'insufficient_data';

  // Refund / merchant settlement / other
  if (caseType === 'refund_request') return 'consistent';
  if (caseType === 'merchant_settlement_delay') return 'consistent';

  // Default: if we picked a transaction, it is consistent with the complaint
  return 'consistent';
}

// ---------------------------------------------------------------------------
// Severity, department, human_review
// ---------------------------------------------------------------------------
function clampSeverityByAmount(severity, txn, caseType) {
  if (!txn) return severity;
  if (caseType === 'wrong_transfer' && txn.amount >= 50000) return 'critical';
  if (caseType === 'agent_cash_in_issue' && txn.amount >= 50000) return 'critical';
  if (txn.amount >= 50000 && severity !== 'critical') return 'high';
  return severity;
}

function deriveSeverity(caseType, verdict, txn) {
  if (caseType === 'phishing_or_social_engineering') return 'critical';
  if (caseType === 'wrong_transfer') return txn && txn.amount >= 50000 ? 'critical' : 'high';
  if (caseType === 'agent_cash_in_issue') return txn && txn.amount >= 50000 ? 'critical' : 'high';
  if (caseType === 'duplicate_payment') return 'medium';
  if (caseType === 'merchant_settlement_delay') return 'medium';
  if (caseType === 'payment_failed') return verdict === 'inconsistent' ? 'high' : 'high';
  if (caseType === 'refund_request') return 'low';
  return 'medium';
}

function deriveDepartment(caseType) {
  switch (caseType) {
    case 'wrong_transfer': return 'dispute_resolution';
    case 'payment_failed': return 'payments_ops';
    case 'duplicate_payment': return 'payments_ops';
    case 'merchant_settlement_delay': return 'merchant_operations';
    case 'agent_cash_in_issue': return 'agent_operations';
    case 'phishing_or_social_engineering': return 'fraud_risk';
    case 'refund_request': return 'customer_support';
    default: return 'customer_support';
  }
}

function needsHumanReview(caseType, verdict) {
  if (caseType === 'phishing_or_social_engineering') return true;
  if (caseType === 'wrong_transfer') return true;
  if (caseType === 'agent_cash_in_issue') return true;
  if (caseType === 'duplicate_payment') return true;
  if (verdict === 'inconsistent') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Replies & summaries â€” English and Bangla templates
// ---------------------------------------------------------------------------
function safeText(s) {
  return String(s == null ? '' : s)
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSummaryEn({ caseType, txn, verdict }) {
  if (!txn) {
    return {
      agent_summary: 'We could not match this complaint to a transaction in your recent history and have routed the ticket for a manual review.',
      customer_reply: 'Thanks for reaching out. We could not find a matching transaction from your description and have flagged this for a manual review by our support team. A specialist will contact you shortly.',
    };
  }
  switch (caseType) {
    case 'wrong_transfer':
      return {
        agent_summary: `Customer reports a transfer of ${txn.amount} to ${txn.counterparty} (${txn.transaction_id}) sent to the wrong recipient. Verdict: ${verdict}. Routed to dispute resolution.`,
        customer_reply: `Thanks for letting us know about the transfer of ${txn.amount} taka. Our dispute team has been notified and will contact you within one business day to start the recovery process. Please do not share any PIN or OTP with anyone who contacts you about this.`,
      };
    case 'payment_failed':
      return {
        agent_summary: `Customer reports that payment ${txn.transaction_id} of ${txn.amount} to ${txn.counterparty} failed. Status confirms failed. Routed to payments ops.`,
        customer_reply: `We have located your payment of ${txn.amount} taka and confirmed it is marked as failed. Our payments team is reviewing the deduction and will update you once the reversal is complete. You will not be asked for your PIN or password at any point.`,
      };
    case 'duplicate_payment':
      return {
        agent_summary: `Customer may have been billed multiple times for the same payment to ${txn.counterparty}. Most recent completed txn: ${txn.transaction_id} of ${txn.amount}. Routed to payments ops.`,
        customer_reply: `We can see multiple attempts for your payment of ${txn.amount} taka to ${txn.counterparty}. Our payments team will review the duplicates and reconcile your account. You do not need to do anything further at this time.`,
      };
    case 'refund_request':
      return {
        agent_summary: `Customer is requesting a refund for transaction ${txn.transaction_id} (${txn.amount} to ${txn.counterparty}). Customer support will review merchant refund eligibility.`,
        customer_reply: `Thanks for your message regarding your payment of ${txn.amount} taka to ${txn.counterparty}. We have recorded your request and our customer support team will review whether a refund can be processed.`,
      };
    case 'merchant_settlement_delay':
      return {
        agent_summary: `Customer reports that a merchant settlement of ${txn.amount} (${txn.transaction_id}) has not been received by ${txn.counterparty}. Routed to merchant operations.`,
        customer_reply: `We have logged the settlement delay for ${txn.amount} taka. Our merchant operations team is checking the payout status and will update you as soon as the funds are released.`,
      };
    case 'agent_cash_in_issue':
      return {
        agent_summary: `Customer claims a cash-in to agent ${txn.counterparty} of ${txn.amount} (${txn.transaction_id}) is short. Routed to agent operations for investigation.`,
        customer_reply: `Thank you for reporting the cash-in issue at agent ${txn.counterparty}. Our agent operations team will verify the deposit against the agent's records and contact you. Please keep any paper receipt you were given.`,
      };
    case 'phishing_or_social_engineering':
      return {
        agent_summary: 'Customer reports being contacted by someone claiming to be from head office and asking for credentials. No matching transaction found. Routed to fraud risk.',
        customer_reply: `Thank you for letting us know. Please do not share your PIN, OTP, password or any verification code with anyone â€” even if they claim to work for us. We have flagged this for our fraud team to follow up. We will never ask you for your PIN or OTP by phone or message.`,
      };
    default:
      return {
        agent_summary: `Ticket logged. Closest matching transaction: ${txn.transaction_id}. Routed to customer support for follow-up.`,
        customer_reply: 'Thank you for contacting us. We have recorded your message and our support team will get back to you as soon as possible.',
      };
  }
}

function buildSummaryBn({ caseType, txn, verdict }) {
  if (!txn) {
    return {
      agent_summary: 'à¦—à§à¦°à¦¾à¦¹à¦•à§‡à¦° à¦…à¦­à¦¿à¦¯à§‹à¦—à§‡à¦° à¦¸à¦¾à¦¥à§‡ à¦®à¦¿à¦²à¦¿à¦¯à¦¼à§‡ à¦•à§‹à¦¨à§‹ à¦²à§‡à¦¨à¦¦à§‡à¦¨ à¦ªà¦¾à¦“à¦¯à¦¼à¦¾ à¦¯à¦¾à¦¯à¦¼à¦¨à¦¿à¥¤ à¦®à§à¦¯à¦¾à¦¨à§à¦¯à¦¼à¦¾à¦² à¦°à¦¿à¦­à¦¿à¦‰-à¦à¦° à¦œà¦¨à§à¦¯ à¦ªà¦¾à¦ à¦¾à¦¨à§‹ à¦¹à¦¯à¦¼à§‡à¦›à§‡à¥¤',
      customer_reply: 'à¦†à¦®à¦¾à¦¦à§‡à¦° à¦œà¦¾à¦¨à¦¾à¦¨à§‹à¦° à¦œà¦¨à§à¦¯ à¦§à¦¨à§à¦¯à¦¬à¦¾à¦¦à¥¤ à¦†à¦ªà¦¨à¦¾à¦° à¦¬à¦°à§à¦£à¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦®à¦¿à¦²à¦¿à¦¯à¦¼à§‡ à¦•à§‹à¦¨à§‹ à¦²à§‡à¦¨à¦¦à§‡à¦¨ à¦–à§à¦à¦œà§‡ à¦ªà¦¾à¦“à¦¯à¦¼à¦¾ à¦¯à¦¾à¦¯à¦¼à¦¨à¦¿à¥¤ à¦†à¦®à¦¾à¦¦à§‡à¦° à¦¸à¦¾à¦ªà§‹à¦°à§à¦Ÿ à¦Ÿà¦¿à¦® à¦à¦Ÿà¦¿ à¦®à§à¦¯à¦¾à¦¨à§à¦¯à¦¼à¦¾à¦²à¦¿ à¦¯à¦¾à¦šà¦¾à¦‡ à¦•à¦°à¦¬à§‡ à¦à¦¬à¦‚ à¦¶à§€à¦˜à§à¦°à¦‡ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦¯à§‹à¦—à¦¾à¦¯à§‹à¦— à¦•à¦°à¦¬à§‡à¥¤',
    };
  }
  switch (caseType) {
    case 'wrong_transfer':
      return {
        agent_summary: `à¦—à§à¦°à¦¾à¦¹à¦• ${txn.counterparty}-à¦ ${txn.amount} à¦Ÿà¦¾à¦•à¦¾ à¦­à§à¦² à¦¨à¦®à§à¦¬à¦°à§‡ à¦ªà¦¾à¦ à¦¿à¦¯à¦¼à§‡à¦›à§‡à¦¨ (${txn.transaction_id})à¥¤ à¦°à¦¾à¦¯à¦¼: ${verdict}à¥¤ dispute_resolution-à¦ à¦°à¦¾à¦‰à¦Ÿ à¦•à¦°à¦¾ à¦¹à¦¯à¦¼à§‡à¦›à§‡à¥¤`,
        customer_reply: `à¦†à¦ªà¦¨à¦¾à¦° ${txn.amount} à¦Ÿà¦¾à¦•à¦¾à¦° à¦­à§à¦² à¦²à§‡à¦¨à¦¦à§‡à¦¨à§‡à¦° à¦¬à¦¿à¦·à¦¯à¦¼à¦Ÿà¦¿ à¦†à¦®à¦°à¦¾ à¦œà§‡à¦¨à§‡à¦›à¦¿à¥¤ à¦†à¦®à¦¾à¦¦à§‡à¦° dispute à¦Ÿà¦¿à¦® à¦¬à¦¿à¦·à¦¯à¦¼à¦Ÿà¦¿ à¦¯à¦¾à¦šà¦¾à¦‡ à¦•à¦°à¦›à§‡ à¦à¦¬à¦‚ à¦à¦• à¦•à¦°à§à¦®à¦¦à¦¿à¦¬à¦¸à§‡à¦° à¦®à¦§à§à¦¯à§‡ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦¯à§‹à¦—à¦¾à¦¯à§‹à¦— à¦•à¦°à¦¬à§‡à¥¤ à¦…à¦¨à§à¦—à§à¦°à¦¹ à¦•à¦°à§‡ à¦•à¦¾à¦°à§‹ à¦¸à¦¾à¦¥à§‡ à¦†à¦ªà¦¨à¦¾à¦° PIN à¦¬à¦¾ OTP à¦¶à§‡à¦¯à¦¼à¦¾à¦° à¦•à¦°à¦¬à§‡à¦¨ à¦¨à¦¾à¥¤`,
      };
    case 'payment_failed':
      return {
        agent_summary: `${txn.counterparty}-à¦ ${txn.amount} à¦Ÿà¦¾à¦•à¦¾à¦° à¦ªà§‡à¦®à§‡à¦¨à§à¦Ÿ (${txn.transaction_id}) à¦¬à§à¦¯à¦°à§à¦¥ à¦¹à¦¯à¦¼à§‡à¦›à§‡à¥¤ payments_ops-à¦ à¦°à¦¾à¦‰à¦Ÿ à¦•à¦°à¦¾ à¦¹à¦¯à¦¼à§‡à¦›à§‡à¥¤`,
        customer_reply: `à¦†à¦ªà¦¨à¦¾à¦° ${txn.amount} à¦Ÿà¦¾à¦•à¦¾à¦° à¦ªà§‡à¦®à§‡à¦¨à§à¦Ÿ à¦¬à§à¦¯à¦°à§à¦¥ à¦¹à¦¯à¦¼à§‡à¦›à§‡ à¦¬à¦²à§‡ à¦¨à¦¿à¦¶à§à¦šà¦¿à¦¤ à¦¹à¦¯à¦¼à§‡à¦›à¦¿à¥¤ à¦†à¦®à¦¾à¦¦à§‡à¦° à¦ªà§‡à¦®à§‡à¦¨à§à¦Ÿ à¦Ÿà¦¿à¦® à¦Ÿà¦¾à¦•à¦¾ à¦«à§‡à¦°à¦¤à§‡à¦° à¦ªà§à¦°à¦•à§à¦°à¦¿à¦¯à¦¼à¦¾ à¦¯à¦¾à¦šà¦¾à¦‡ à¦•à¦°à¦›à§‡à¥¤ à¦ªà§à¦°à¦•à§à¦°à¦¿à¦¯à¦¼à¦¾ à¦šà¦²à¦¾à¦•à¦¾à¦²à§‡ à¦•à§‡à¦‰ à¦†à¦ªà¦¨à¦¾à¦° PIN à¦¬à¦¾ à¦ªà¦¾à¦¸à¦“à¦¯à¦¼à¦¾à¦°à§à¦¡ à¦šà¦¾à¦‡à¦²à§‡ à¦¶à§‡à¦¯à¦¼à¦¾à¦° à¦•à¦°à¦¬à§‡à¦¨ à¦¨à¦¾à¥¤`,
      };
    case 'duplicate_payment':
      return {
        agent_summary: `${txn.counterparty}-à¦ à¦à¦•à¦‡ à¦ªà§‡à¦®à§‡à¦¨à§à¦Ÿ à¦à¦•à¦¾à¦§à¦¿à¦•à¦¬à¦¾à¦° à¦¹à¦¤à§‡ à¦ªà¦¾à¦°à§‡à¥¤ à¦¸à¦°à§à¦¬à¦¶à§‡à¦· à¦¸à¦«à¦² à¦²à§‡à¦¨à¦¦à§‡à¦¨: ${txn.transaction_id} (${txn.amount})à¥¤`,
        customer_reply: `à¦†à¦ªà¦¨à¦¾à¦° ${txn.amount} à¦Ÿà¦¾à¦•à¦¾à¦° à¦ªà§‡à¦®à§‡à¦¨à§à¦Ÿ à¦à¦•à¦¾à¦§à¦¿à¦•à¦¬à¦¾à¦° à¦šà§‡à¦·à§à¦Ÿà¦¾ à¦•à¦°à¦¾ à¦¹à¦¯à¦¼à§‡à¦›à§‡ à¦¬à¦²à§‡ à¦®à¦¨à§‡ à¦¹à¦šà§à¦›à§‡à¥¤ à¦†à¦®à¦¾à¦¦à§‡à¦° à¦ªà§‡à¦®à§‡à¦¨à§à¦Ÿ à¦Ÿà¦¿à¦® à¦¡à§à¦ªà§à¦²à¦¿à¦•à§‡à¦Ÿ à¦šà§‡à¦• à¦•à¦°à§‡ à¦†à¦ªà¦¨à¦¾à¦° à¦…à§à¦¯à¦¾à¦•à¦¾à¦‰à¦¨à§à¦Ÿ à¦¸à¦ à¦¿à¦• à¦•à¦°à¦¬à§‡à¥¤`,
      };
    case 'refund_request':
      return {
        agent_summary: `${txn.transaction_id} (${txn.counterparty}, ${txn.amount}) à¦²à§‡à¦¨à¦¦à§‡à¦¨à§‡à¦° à¦°à¦¿à¦«à¦¾à¦¨à§à¦¡ à¦…à¦¨à§à¦°à§‹à¦§à¥¤ customer_support à¦¯à¦¾à¦šà¦¾à¦‡ à¦•à¦°à¦¬à§‡à¥¤`,
        customer_reply: `à¦†à¦ªà¦¨à¦¾à¦° ${txn.amount} à¦Ÿà¦¾à¦•à¦¾à¦° à¦°à¦¿à¦«à¦¾à¦¨à§à¦¡ à¦…à¦¨à§à¦°à§‹à¦§ à¦†à¦®à¦°à¦¾ à¦—à§à¦°à¦¹à¦£ à¦•à¦°à§‡à¦›à¦¿à¥¤ à¦†à¦®à¦¾à¦¦à§‡à¦° à¦¸à¦¾à¦ªà§‹à¦°à§à¦Ÿ à¦Ÿà¦¿à¦® à¦®à¦¾à¦°à§à¦šà§‡à¦¨à§à¦Ÿà§‡à¦° à¦°à¦¿à¦«à¦¾à¦¨à§à¦¡ à¦¨à§€à¦¤à¦¿ à¦…à¦¨à§à¦¯à¦¾à¦¯à¦¼à§€ à¦¯à¦¾à¦šà¦¾à¦‡ à¦•à¦°à§‡ à¦†à¦ªà¦¨à¦¾à¦•à§‡ à¦œà¦¾à¦¨à¦¾à¦¬à§‡à¥¤`,
      };
    case 'agent_cash_in_issue':
      return {
        agent_summary: `à¦à¦œà§‡à¦¨à§à¦Ÿ ${txn.counterparty}-à¦à¦° à¦•à§à¦¯à¦¾à¦¶-à¦‡à¦¨ ${txn.amount} à¦Ÿà¦¾à¦•à¦¾ à¦•à¦® à¦¦à§‡à¦–à¦¾à¦¨à§‹ à¦¹à¦¯à¦¼à§‡à¦›à§‡ à¦¬à¦²à§‡ à¦…à¦­à¦¿à¦¯à§‹à¦— (${txn.transaction_id})à¥¤`,
        customer_reply: `à¦à¦œà§‡à¦¨à§à¦Ÿ ${txn.counterparty}-à¦ à¦•à§à¦¯à¦¾à¦¶-à¦‡à¦¨à§‡à¦° à¦¸à¦®à¦¸à§à¦¯à¦¾à¦° à¦œà¦¨à§à¦¯ à¦¦à§à¦ƒà¦–à¦¿à¦¤à¥¤ à¦†à¦®à¦¾à¦¦à§‡à¦° à¦à¦œà§‡à¦¨à§à¦Ÿ à¦…à¦ªà¦¾à¦°à§‡à¦¶à¦¨ à¦Ÿà¦¿à¦® à¦°à§‡à¦•à¦°à§à¦¡ à¦¯à¦¾à¦šà¦¾à¦‡ à¦•à¦°à§‡ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦¯à§‹à¦—à¦¾à¦¯à§‹à¦— à¦•à¦°à¦¬à§‡à¥¤ à¦•à¦¾à¦—à¦œà§‡à¦° à¦°à¦¸à¦¿à¦¦ à¦¥à¦¾à¦•à¦²à§‡ à¦°à¦¾à¦–à§à¦¨à¥¤`,
      };
    case 'phishing_or_social_engineering':
      return {
        agent_summary: 'à¦—à§à¦°à¦¾à¦¹à¦• à¦œà¦¾à¦¨à¦¿à¦¯à¦¼à§‡à¦›à§‡à¦¨ à¦•à§‡à¦‰ à¦¹à§‡à¦¡ à¦…à¦«à¦¿à¦¸à§‡à¦° à¦ªà¦°à¦¿à¦šà¦¯à¦¼à§‡ à¦•à¦² à¦•à¦°à§‡ PIN/à¦­à§‡à¦°à¦¿à¦«à¦¿à¦•à§‡à¦¶à¦¨ à¦•à§‹à¦¡ à¦šà§‡à¦¯à¦¼à§‡à¦›à§‡à¥¤ à¦•à§‹à¦¨à§‹ à¦²à§‡à¦¨à¦¦à§‡à¦¨ à¦ªà¦¾à¦“à¦¯à¦¼à¦¾ à¦¯à¦¾à¦¯à¦¼à¦¨à¦¿à¥¤ fraud_risk-à¦ à¦°à¦¾à¦‰à¦Ÿ à¦•à¦°à¦¾ à¦¹à¦¯à¦¼à§‡à¦›à§‡à¥¤',
        customer_reply: `à¦¸à¦¾à¦¬à¦§à¦¾à¦¨ à¦¥à¦¾à¦•à§à¦¨à¥¤ à¦•à§‡à¦‰ à¦¯à¦¦à¦¿ "à¦¹à§‡à¦¡ à¦…à¦«à¦¿à¦¸" à¦¬à¦¾ "à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦•à§‡à¦¯à¦¼à¦¾à¦°" à¦¬à¦²à§‡ à¦†à¦ªà¦¨à¦¾à¦° PIN, OTP, à¦ªà¦¾à¦¸à¦“à¦¯à¦¼à¦¾à¦°à§à¦¡ à¦¬à¦¾ à¦­à§‡à¦°à¦¿à¦«à¦¿à¦•à§‡à¦¶à¦¨ à¦•à§‹à¦¡ à¦šà¦¾à¦¯à¦¼, à¦¤à¦¾à¦¹à¦²à§‡ à¦•à¦–à¦¨à§‹ à¦¦à§‡à¦¬à§‡à¦¨ à¦¨à¦¾à¥¤ à¦†à¦®à¦°à¦¾ à¦•à¦–à¦¨à§‹ à¦«à§‹à¦¨à§‡ PIN à¦¬à¦¾ OTP à¦šà¦¾à¦‡ à¦¨à¦¾à¥¤ à¦à¦‡ à¦˜à¦Ÿà¦¨à¦¾ à¦†à¦®à¦¾à¦¦à§‡à¦° à¦«à§à¦°à¦¡ à¦Ÿà¦¿à¦®à¦•à§‡ à¦œà¦¾à¦¨à¦¾à¦¨à§‹ à¦¹à¦¯à¦¼à§‡à¦›à§‡à¥¤`,
      };
    default:
      return {
        agent_summary: `à¦Ÿà¦¿à¦•à¦¿à¦Ÿ à¦²à¦— à¦•à¦°à¦¾ à¦¹à¦¯à¦¼à§‡à¦›à§‡à¥¤ à¦¨à¦¿à¦•à¦Ÿà¦¤à¦® à¦²à§‡à¦¨à¦¦à§‡à¦¨: ${txn.transaction_id}à¥¤ customer_support à¦«à¦²à§‹à¦†à¦ª à¦•à¦°à¦¬à§‡à¥¤`,
        customer_reply: 'à¦†à¦®à¦¾à¦¦à§‡à¦° à¦œà¦¾à¦¨à¦¾à¦¨à§‹à¦° à¦œà¦¨à§à¦¯ à¦§à¦¨à§à¦¯à¦¬à¦¾à¦¦à¥¤ à¦†à¦®à¦°à¦¾ à¦†à¦ªà¦¨à¦¾à¦° à¦¬à¦¾à¦°à§à¦¤à¦¾ à¦°à§‡à¦•à¦°à§à¦¡ à¦•à¦°à§‡à¦›à¦¿ à¦à¦¬à¦‚ à¦¶à§€à¦˜à§à¦°à¦‡ à¦¯à§‹à¦—à¦¾à¦¯à§‹à¦— à¦•à¦°à¦¬à¥¤',
      };
  }
}

function buildNextActionEn(caseType, verdict) {
  switch (caseType) {
    case 'wrong_transfer': return 'Initiate dispute resolution workflow; queue callback within 24h.';
    case 'payment_failed': return 'Verify failed payment with gateway and trigger auto-reversal if eligible.';
    case 'duplicate_payment': return 'Reconcile duplicate payments; refund any duplicate completed charges after audit.';
    case 'refund_request': return 'Verify merchant refund eligibility and respond to customer with policy.';
    case 'merchant_settlement_delay': return 'Check settlement batch status with merchant operations.';
    case 'agent_cash_in_issue': return 'Reconcile agent cash bag and dispatch field investigator if variance confirmed.';
    case 'phishing_or_social_engineering': return 'Open fraud case; send customer an in-app warning about credential sharing.';
    default: return 'Send ticket to customer support queue for manual triage.';
  }
}

function buildNextActionBn(caseType) {
  switch (caseType) {
    case 'wrong_transfer': return 'Dispute resolution à¦“à¦¯à¦¼à¦¾à¦°à§à¦•à¦«à§à¦²à§‹ à¦¶à§à¦°à§ à¦•à¦°à§à¦¨; à§¨à§ª à¦˜à¦£à§à¦Ÿà¦¾à¦° à¦®à¦§à§à¦¯à§‡ à¦•à¦²à¦¬à§à¦¯à¦¾à¦• à¦¨à¦¿à¦°à§à¦§à¦¾à¦°à¦£ à¦•à¦°à§à¦¨à¥¤';
    case 'payment_failed': return 'à¦—à§‡à¦Ÿà¦“à¦¯à¦¼à§‡à¦° à¦¸à¦¾à¦¥à§‡ à¦¬à§à¦¯à¦°à§à¦¥ à¦ªà§‡à¦®à§‡à¦¨à§à¦Ÿ à¦¯à¦¾à¦šà¦¾à¦‡ à¦•à¦°à§‡ à¦¯à§‹à¦—à§à¦¯ à¦¹à¦²à§‡ à¦…à¦Ÿà§‹-à¦°à¦¿à¦­à¦¾à¦°à§à¦¸à¦¾à¦² à¦šà¦¾à¦²à§ à¦•à¦°à§à¦¨à¥¤';
    case 'duplicate_payment': return 'à¦¡à§à¦ªà§à¦²à¦¿à¦•à§‡à¦Ÿ à¦ªà§‡à¦®à§‡à¦¨à§à¦Ÿ à¦°à¦¿à¦•à¦¨à¦¸à¦¾à¦‡à¦² à¦•à¦°à§à¦¨; à¦…à¦¡à¦¿à¦Ÿà§‡à¦° à¦ªà¦° à¦¡à§à¦ªà§à¦²à¦¿à¦•à§‡à¦Ÿ à¦šà¦¾à¦°à§à¦œ à¦°à¦¿à¦«à¦¾à¦¨à§à¦¡ à¦•à¦°à§à¦¨à¥¤';
    case 'refund_request': return 'à¦®à¦¾à¦°à§à¦šà§‡à¦¨à§à¦Ÿà§‡à¦° à¦°à¦¿à¦«à¦¾à¦¨à§à¦¡ à¦¨à§€à¦¤à¦¿ à¦¯à¦¾à¦šà¦¾à¦‡ à¦•à¦°à§‡ à¦—à§à¦°à¦¾à¦¹à¦•à¦•à§‡ à¦œà¦¾à¦¨à¦¾à¦¨à¥¤';
    case 'merchant_settlement_delay': return 'à¦®à¦¾à¦°à§à¦šà§‡à¦¨à§à¦Ÿ à¦…à¦ªà¦¾à¦°à§‡à¦¶à¦¨à§‡à¦° à¦¸à¦¾à¦¥à§‡ à¦¸à§‡à¦Ÿà§‡à¦²à¦®à§‡à¦¨à§à¦Ÿ à¦¬à§à¦¯à¦¾à¦šà§‡à¦° à¦…à¦¬à¦¸à§à¦¥à¦¾ à¦¯à¦¾à¦šà¦¾à¦‡ à¦•à¦°à§à¦¨à¥¤';
    case 'agent_cash_in_issue': return 'à¦à¦œà§‡à¦¨à§à¦Ÿà§‡à¦° à¦•à§à¦¯à¦¾à¦¶-à¦¬à§à¦¯à¦¾à¦— à¦°à¦¿à¦•à¦¨à¦¸à¦¾à¦‡à¦² à¦•à¦°à§à¦¨ à¦à¦¬à¦‚ à¦ªà§à¦°à¦¯à¦¼à§‹à¦œà¦¨à§‡ à¦«à¦¿à¦²à§à¦¡ à¦‡à¦¨à¦­à§‡à¦¸à§à¦Ÿà¦¿à¦—à§‡à¦Ÿà¦° à¦ªà¦¾à¦ à¦¾à¦¨à¥¤';
    case 'phishing_or_social_engineering': return 'à¦«à§à¦°à¦¡ à¦•à§‡à¦¸ à¦–à§à¦²à§à¦¨; à¦—à§à¦°à¦¾à¦¹à¦•à¦•à§‡ à¦•à§à¦°à§‡à¦¡à§‡à¦¨à¦¶à¦¿à¦¯à¦¼à¦¾à¦² à¦¶à§‡à¦¯à¦¼à¦¾à¦° à¦¸à¦®à§à¦ªà¦°à§à¦•à§‡ à¦‡à¦¨-à¦…à§à¦¯à¦¾à¦ª à¦¸à¦¤à¦°à§à¦•à¦¤à¦¾ à¦ªà¦¾à¦ à¦¾à¦¨à¥¤';
    default: return 'à¦Ÿà¦¿à¦•à¦¿à¦Ÿà¦Ÿà¦¿ à¦®à§à¦¯à¦¾à¦¨à§à¦¯à¦¼à¦¾à¦² à¦Ÿà§à¦°à¦¾à¦¯à¦¼à¦¾à¦œà§‡à¦° à¦œà¦¨à§à¦¯ customer_support à¦•à¦¿à¦‰à¦¤à§‡ à¦ªà¦¾à¦ à¦¾à¦¨à¥¤';
  }
}

// ---------------------------------------------------------------------------
// Safety guard â€” final scrub on customer_reply and recommended_next_action
// ---------------------------------------------------------------------------
function applySafetyGuard(text) {
  let s = safeText(text);
  if (UNSAFE_CREDENTIALS.test(s)) {
    s = s.replace(UNSAFE_CREDENTIALS, '[removed â€” credential request]');
  }
  if (UNSAFE_PROMISES.test(s)) {
    s = s.replace(UNSAFE_PROMISES, 'be reviewed for eligibility');
  }
  if (UNSAFE_THIRD_PARTY.test(s)) {
    s = s.replace(UNSAFE_THIRD_PARTY, '[contact removed]');
  }
  return s;
}

// ---------------------------------------------------------------------------
// Final enum safety net
// ---------------------------------------------------------------------------
function enumSafetyNet(out) {
  if (!CASE_TYPES.includes(out.case_type)) out.case_type = 'other';
  if (!DEPARTMENTS.includes(out.department)) out.department = 'customer_support';
  if (!SEVERITIES.includes(out.severity)) out.severity = 'medium';
  if (!VERDICTS.includes(out.evidence_verdict)) out.evidence_verdict = 'insufficient_data';
  if (typeof out.human_review_required !== 'boolean') out.human_review_required = false;
  if (!out.ticket_id) out.ticket_id = 'UNKNOWN';
  return out;
}

// ---------------------------------------------------------------------------
// Main POST handler
// ---------------------------------------------------------------------------
export async function POST(req) {
  let rawBody;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Malformed payload structure: invalid JSON.' },
      { status: 400 },
    );
  }

  const parsed = InputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  if (!input.complaint || input.complaint.trim() === '') {
    return NextResponse.json(
      { error: 'complaint text is required' },
      { status: 422 },
    );
  }

  const safeComplaint = normalizeComplaint(input.complaint);
  const transactions = Array.isArray(input.transaction_history) ? input.transaction_history : [];

  // Classify from sanitized text
  const caseType = classifyCase(safeComplaint, safeComplaint.toLowerCase(), transactions);

  // Pick transaction (or none)
  const pick = pickTransaction(transactions, safeComplaint, caseType);
  const pickedTxn = pick.id ? transactions.find((t) => t.transaction_id === pick.id) : null;

  // Verdict
  const verdict = determineVerdict(caseType, pick, transactions);

  // Severity, department, review
  let severity = deriveSeverity(caseType, verdict, pickedTxn);
  severity = clampSeverityByAmount(severity, pickedTxn, caseType);
  const department = deriveDepartment(caseType);
  const humanReview = needsHumanReview(caseType, verdict);

  // Replies
  const lang = input.language === 'bn' ? 'bn' : 'en';
  const built = lang === 'bn'
    ? buildSummaryBn({ caseType, txn: pickedTxn, verdict })
    : buildSummaryEn({ caseType, txn: pickedTxn, verdict });
  const nextAction = (lang === 'bn' ? buildNextActionBn(caseType) : buildNextActionEn(caseType, verdict));

  const out = {
    ticket_id: input.ticket_id,
    relevant_transaction_id: pick.id || null,
    evidence_verdict: verdict,
    case_type: caseType,
    severity: severity,
    department: department,
    agent_summary: applySafetyGuard(built.agent_summary),
    recommended_next_action: applySafetyGuard(nextAction),
    customer_reply: applySafetyGuard(built.customer_reply),
    human_review_required: humanReview,
    confidence: pick.id ? 0.7 : 0.3,
    reason_codes: pick.reasons.length > 0 ? pick.reasons : ['no_signal'],
  };

  return NextResponse.json(enumSafetyNet(out), { status: 200 });
}

// Reject other methods
export async function GET() {
  return new NextResponse('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST' },
  });
}
