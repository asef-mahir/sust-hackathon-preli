import { z } from 'zod';

export const RequestSchema = z.object({
  ticket_id: z.string().min(1),
  complaint: z.string().min(1),
  language: z.enum(['en', 'bn', 'mixed']).optional().default('en'),
  channel: z.enum(['in_app_chat', 'call_center', 'email', 'merchant_portal', 'field_agent']).optional(),
  user_type: z.enum(['customer', 'merchant', 'agent', 'unknown']).optional(),
  campaign_context: z.string().optional(),
  transaction_history: z.array(z.object({
    transaction_id: z.string(),
    timestamp: z.string(),
    type: z.enum(['transfer', 'payment', 'cash_in', 'cash_out', 'settlement', 'refund']),
    amount: z.number(),
    counterparty: z.string(),
    status: z.enum(['completed', 'failed', 'pending', 'reversed'])
  })).optional().default([])
});