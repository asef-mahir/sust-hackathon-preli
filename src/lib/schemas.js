import { z } from 'zod';

/**
 * Maps common string variations and synonyms to valid transaction types
 */
const normalizeType = (val) => {
  if (typeof val !== 'string') return val;
  const s = val.trim().toLowerCase().replace(/[- ]/g, '_');
  
  if (s.includes('transfer') || s.includes('send')) return 'transfer';
  if (s.includes('payment') || s.includes('pay') || s.includes('recharge') || s.includes('topup') || s.includes('fee') || s.includes('charge') || s.includes('bill')) return 'payment';
  if (s.includes('cash_in') || s.includes('cashin') || s.includes('deposit')) return 'cash_in';
  if (s.includes('cash_out') || s.includes('cashout') || s.includes('withdraw')) return 'cash_out';
  if (s.includes('settle')) return 'settlement';
  if (s.includes('refund') || s.includes('reversal')) return 'refund';
  
  return s; 
};

/**
 * Maps common string variations and synonyms to valid transaction statuses
 */
const normalizeStatus = (val) => {
  if (typeof val !== 'string') return val;
  const s = val.trim().toLowerCase().replace(/[- ]/g, '_');
  
  if (s.includes('complete') || s.includes('success') || s.includes('done') || s === 'ok') return 'completed';
  if (s.includes('fail') || s.includes('error') || s.includes('decline') || s.includes('reject')) return 'failed';
  if (s.includes('pend') || s.includes('progress') || s.includes('hold')) return 'pending';
  if (s.includes('revers') || s.includes('roll')) return 'reversed';
  
  return s;
};

// 1. INCOMING REQUEST SCHEMA
export const RequestSchema = z.object({
  ticket_id: z.string().min(1),
  complaint: z.string().min(1),
  
  language: z.enum(['en', 'bn', 'mixed']).nullable().optional().default('en'),
  channel: z.enum(['in_app_chat', 'call_center', 'email', 'merchant_portal', 'field_agent']).nullable().optional(),
  user_type: z.enum(['customer', 'merchant', 'agent', 'unknown']).nullable().optional(),
  campaign_context: z.string().nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(), 
  
  transaction_history: z.array(
    z.object({
      transaction_id: z.string().min(1),
      timestamp: z.string(), 
      
      // Intercept and map transaction types
      type: z.preprocess(
        normalizeType,
        z.enum(['transfer', 'payment', 'cash_in', 'cash_out', 'settlement', 'refund'])
      ),
      
      amount: z.number(),
      counterparty: z.string(),
      
      // Intercept and map transaction statuses
      status: z.preprocess(
        normalizeStatus,
        z.enum(['completed', 'failed', 'pending', 'reversed'])
      )
    })
  ).nullable().optional().default([])
});

// 2. OUTGOING RESPONSE SCHEMA
export const OutputSchema = z.object({
  ticket_id: z.string(), 
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
  agent_summary: z.string().min(1),
  recommended_next_action: z.string().min(1),
  customer_reply: z.string().min(1),
  human_review_required: z.boolean(),
  
  confidence: z.number().min(0.0).max(1.0).nullable().optional(), 
  reason_codes: z.array(z.string()).nullable().optional() 
});