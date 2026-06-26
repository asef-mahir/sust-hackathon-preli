# QueueStorm Investigator ⚡

QueueStorm Investigator is an automated, enterprise-grade digital finance platform ticket investigation copilot. Built with **Next.js (App Router)** and powered by **Google Gemini 2.5 Flash**, the service systematically ingests customer complaints, parses raw transaction ledgers, detects fraudulent behaviors or technical anomalies, routes tickets to correct departments, and drafts highly secure customer responses.

## 🚀 Live Endpoints

The API is fully deployed and reachable at the following endpoints:

* **Health Check:** [https://team-hope-eight.vercel.app/api/health](https://team-hope-eight.vercel.app/api/health)
* **Ticket Analysis:** [https://team-hope-eight.vercel.app/api/analyze-ticket](https://team-hope-eight.vercel.app/api/analyze-ticket)

*Note: For evaluation purposes, the base URL to be supplied to the judging harness is [https://team-hope-eight.vercel.app/api*](https://team-hope-eight.vercel.app/api)

---

## 🛠️ Architecture & Tech Stack

* **Runtime/Framework:** Node.js (Next.js 14+ App Router)
* **LLM Engine:** Google Gemini 2.5 Flash via official @google/genai SDK
* **Data Validation:** Zod (Strict, zero-compromise runtime schema enforcement)
* **Resiliency Layer:** Dual-layer native AbortController + Promise.race circuit breaker (Hard 25s timeout limit)

---

## ⚙️ Setup & Local Installation

Follow these steps to set up and run the service locally:

### 1. Clone the Repository

git clone [https://github.com/your-username/your-repo-name.git](https://github.com/your-username/your-repo-name.git)
cd your-repo-name

### 2. Install Dependencies

npm install

### 3. Environment Configuration

Create a .env.local file in the root directory (this is ignored by Git to preserve secret security):

GEMINI_API_KEY=your_actual_gemini_api_key_here

*An example template is provided in the repository as .env.example.*

### 4. Run the Development Server

npm run dev

The service will boot up locally on http://localhost:3000. You can verify it by hitting http://localhost:3000/api/health.

---

## 🧠 AI and Model Usage

QueueStorm Investigator implements a **hybrid rule-based + generative AI architecture** designed to combine rigid structural validation with complex cognitive reasoning:

1. **Input Filtering (Zod):** The incoming payload is parsed via RequestSchema. If the structure deviates from the rubric enums, the platform rejects it immediately with an HTTP 400 or 422, preserving compute resources.
2. **Context Assembly:** Validated parameters are transformed via a structural template wrapper into an isolated TICKET_DATA XML context block to prevent prompt leakage.
3. **Generative Reasoning Engine:** Gemini 2.5 Flash assesses the ledger text against strict, logical constraints (e.g., tracking "Established Recipient Traps", identifying true vs. phantom duplicate states, and managing ambiguous multi-transaction matches).
4. **Output Structural Defense (Zod):** The raw JSON string returned by Gemini is parsed, stripped of markdown wrappers, and strictly validated against OutputSchema to block enum hallucinations before leaving the platform.

---

## 🛡️ Safety Logic & Guardrails

Fintech environments demand absolute safety compliance. QueueStorm Investigator implements programmatic post-processing filters (applySafetyFilters) to guarantee zero tolerance across the following vectors:

* **Credential Shielding:** Direct regex monitoring prevents the system from ever asking a customer for sensitive verification vectors, including PINs, OTPs, passwords, or 4-digit codes.
* **Authority Boundaries:** As a support copilot, the system is blocked from promising direct financial outcomes. Any language guaranteeing "refunds", "reversals", "money back", or "account unblocks" is automatically intercepted and swapped with compliant, safe procedural terminology: *"Any eligible amount will be processed through official channels upon review."*
* **Prompt Injection Isolation:** Complaint texts are strictly isolated as untrusted runtime values. System rules are declared globally outside the mutable payload window to enforce complete instruction integrity.
* **Circuit-Breaker Fallback:** If an upstream network timeout occurs or a structure fails schema validation, a deterministic fallback payload (getFallbackPayload) automatically triggers with a safe fallback verdict, alerting human agents immediately.

---

## 📊 Sample Request & Response

### Sample Request

POST /api/analyze-ticket

{
"ticket_id": "TKT-015",
"complaint": "I tried to recharge my phone and it failed but you stole my 10 taka! Refund me right now or I am calling my lawyer!",
"language": "en",
"channel": "in_app_chat",
"user_type": "customer",
"transaction_history": [
{
"transaction_id": "TXN-015",
"timestamp": "2026-04-14T10:00:00Z",
"type": "payment",
"amount": 10,
"counterparty": "MOBILE-OP",
"status": "failed"
}
]
}

### Sample Response (HTTP 200)

{
"ticket_id": "TKT-015",
"relevant_transaction_id": "TXN-015",
"evidence_verdict": "consistent",
"case_type": "payment_failed",
"severity": "high",
"department": "payments_ops",
"agent_summary": "Customer is highly agitated and threatening legal action over a failed 10 BDT mobile recharge.",
"recommended_next_action": "Verify if the 10 BDT was actually deducted despite the 'failed' status and initiate auto-reversal if true.",
"customer_reply": "We apologize for the inconvenience with your mobile recharge. We see the transaction failed and are checking your balance. Any eligible amount will be processed through official channels upon review.",
"human_review_required": true,
"confidence": 0.95,
"reason_codes": ["failed_status_matching", "agitated_tone"]
}

---

