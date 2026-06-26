import { z } from 'zod';

// 1. INCOMING REQUEST SCHEMA (Validates the Hackathon Judge's POST body)
export const RequestSchema = z.object({
  ticket_id: z.string().min(1),
  complaint: z.string().min(1),
  language: z.enum(['en', 'bn', 'mixed']).optional().default('en'),
  channel: z.enum(['in_app_chat', 'call_center', 'email', 'merchant_portal', 'field_agent']).optional(),
  user_type: z.enum(['customer', 'merchant', 'agent', 'unknown']).optional(),
  campaign_context: z.string().optional(),
  metadata: z.record(z.any()).optional(), // ADDED: from section 5.1
  transaction_history: z.array(z.object({
    transaction_id: z.string(),
    timestamp: z.string(), // Consider .datetime() if you want strict ISO 8601 validation
    type: z.enum(['transfer', 'payment', 'cash_in', 'cash_out', 'settlement', 'refund']),
    amount: z.number(),
    counterparty: z.string(),
    status: z.enum(['completed', 'failed', 'pending', 'reversed'])
  })).optional().default([])
});

// 2. OUTGOING RESPONSE SCHEMA (Validates Gemini's generated JSON)
export const OutputSchema = z.object({
  ticket_id: z.string(), // ADDED: CRITICAL from section 6.1
  relevant_transaction_id: z.string().nullable(),
  evidence_verdict: z.enum(["consistent", "inconsistent", "insufficient_data"]),
  case_type: z.enum([
    "wrong_transfer", 
    "payment_failed", 
    "refund_request", 
    "duplicate_payment", 
    "merchant_settlement_delay", 
    "agent_cash_in_issue", 
    "phishing_or_social_engineering", 
    "other"
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  department: z.enum([
    "customer_support", 
    "dispute_resolution", 
    "payments_ops", 
    "merchant_operations", 
    "agent_operations", 
    "fraud_risk"
  ]),
  agent_summary: z.string(),
  recommended_next_action: z.string(),
  customer_reply: z.string(),
  human_review_required: z.boolean(),
  confidence: z.number().min(0.0).max(1.0).optional(), // FIXED: Made optional per section 6.1
  reason_codes: z.array(z.string()).optional() // FIXED: Made optional per section 6.1
});