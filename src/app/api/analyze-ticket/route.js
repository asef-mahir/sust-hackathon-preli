import { NextResponse } from 'next/server';
import { RequestSchema, OutputSchema } from '@/lib/schemas'; 
import { SYSTEM_INSTRUCTION, generateUserPrompt } from '@/lib/prompts';
import { applySafetyFilters } from '@/lib/safetyFilters';
import { GoogleGenAI } from '@google/genai';

// Initialize the client (automatically uses process.env.GEMINI_API_KEY)
const ai = new GoogleGenAI({});

// Deterministic fallback for timeouts, crashes, and API failures
const getFallbackPayload = (ticketId, diagnosticMessage) => ({
  ticket_id: ticketId || "UNKNOWN-TICKET",
  relevant_transaction_id: null,
  evidence_verdict: "insufficient_data",
  case_type: "other",
  severity: "high",
  department: "customer_support",
  agent_summary: "Automated analysis degraded due to backend processing timeout or structural constraint.",
  recommended_next_action: "Perform an immediate manual check on the customer profile and transaction logs.",
  customer_reply: "We are currently experiencing high volume processing delays. Your issue has been safely placed in our queue for manual review.",
  human_review_required: true,
  confidence: 0.0,
  reason_codes: ["circuit_breaker_timeout", diagnosticMessage || "unknown_error"]
});

// Sanitizer for LLM markdown hallucinations
function cleanJsonString(str) {
  return str.replace(/```json/gi, '').replace(/```/g, '').trim();
}

export async function POST(req) {
  let rawBody;
  try {
    rawBody = await req.json();
  } catch (err) {
    return NextResponse.json({ error: "Malformed payload structure" }, { status: 400 });
  }

  // 1. Validate Input Schema (Fail fast on bad payloads)
  const parsingResult = RequestSchema.safeParse(rawBody);
  if (!parsingResult.success) {
    return NextResponse.json({ error: parsingResult.error.format() }, { status: 400 });
  }

  const payload = parsingResult.data;
  if (!payload.complaint || payload.complaint.trim() === "") {
    return NextResponse.json({ error: "Semantic error: Complaint text field is missing values" }, { status: 422 });
  }

  // 2. Setup Native AbortController & Promise Race (25s hard kill)
  const controller = new AbortController();
  
  try {
    const aiPromise = ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: generateUserPrompt(payload),
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json'
      },
      signal: controller.signal // Attempt native abort
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        controller.abort(); // Fire the abort signal
        reject(new Error("GATEWAY_TIMEOUT"));
      }, 25000);
    });

    // 3. Execute the race condition
    const response = await Promise.race([aiPromise, timeoutPromise]);

    const cleanedOutput = cleanJsonString(response.text);
    let rawAiOutputJson = JSON.parse(cleanedOutput);

    // 4. Validate Output Schema (Prevents Enum hallucinations)
    const validatedOutput = OutputSchema.safeParse(rawAiOutputJson);
    if (!validatedOutput.success) {
      console.error("🔥 LLM SCHEMA HALLUCINATION:", validatedOutput.error.format());
      return NextResponse.json(getFallbackPayload(payload.ticket_id, "schema_hallucination"), { status: 200 });
    }

    // 5. Apply safety filters (Overrides unauthorized promises deterministically)
    const finalJsonResult = applySafetyFilters(validatedOutput.data, payload.ticket_id);
    
    return NextResponse.json(finalJsonResult, { status: 200 });

  } catch (error) {
    // Catch timeouts and API crashes gracefully
    if (error.name === 'AbortError' || error.message === 'GATEWAY_TIMEOUT') {
      console.error("🔥 GEMINI TIMEOUT CAUGHT");
      return NextResponse.json(getFallbackPayload(payload.ticket_id, "timeout_exceeded"), { status: 200 });
    }

    console.error("🔥 GEMINI EXECUTION ERROR:", error.message);
    const backupJson = getFallbackPayload(payload.ticket_id, error.message);
    return NextResponse.json(backupJson, { status: 200 });
  }
}