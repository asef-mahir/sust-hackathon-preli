import { NextResponse } from 'next/server';
import { RequestSchema, OutputSchema } from '@/lib/schemas'; 
import { SYSTEM_INSTRUCTION, generateUserPrompt } from '@/lib/prompts';
import { applySafetyFilters } from '@/lib/safetyFilters';
import { GoogleGenAI } from '@google/genai';

// Initialize the client
const ai = new GoogleGenAI({});

// FIXED: Added ticketId parameter injection to ensure schema compliance even on failure
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

function cleanJsonString(str) {
  // Removes markdown code blocks if Gemini accidentally includes them
  return str.replace(/```json/gi, '').replace(/```/g, '').trim();
}

export async function POST(req) {
  let rawBody;
  try {
    rawBody = await req.json();
  } catch (err) {
    return NextResponse.json({ error: "Malformed payload structure" }, { status: 400 });
  }

  // 1. Validate Input Schema
  const parsingResult = RequestSchema.safeParse(rawBody);
  if (!parsingResult.success) {
    return NextResponse.json({ error: parsingResult.error.format() }, { status: 400 });
  }

  const payload = parsingResult.data;
  if (!payload.complaint || payload.complaint.trim() === "") {
    return NextResponse.json({ error: "Semantic error: Complaint text field is missing values" }, { status: 422 });
  }

  // 2. Setup Native AbortController (25s hard kill)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); 

  try {
    // 3. Call Gemini with the timeout signal attached
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: generateUserPrompt(payload),
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json'
      },
      signal: controller.signal // Passed to underlying fetch
    });

    // Clear the timeout if the request succeeds quickly
    clearTimeout(timeoutId);

    const cleanedOutput = cleanJsonString(response.text);
    let rawAiOutputJson = JSON.parse(cleanedOutput);

    // 4. Validate Output Schema (Prevents Enum hallucinations)
    const validatedOutput = OutputSchema.safeParse(rawAiOutputJson);
    if (!validatedOutput.success) {
      console.error("🔥 LLM SCHEMA HALLUCINATION:", validatedOutput.error);
      return NextResponse.json(getFallbackPayload(payload.ticket_id, "schema_hallucination"), { status: 200 });
    }

    // 5. Apply safety filters (FIXED: Passed payload as 2nd argument for ticket_id recovery)
    const finalJsonResult = applySafetyFilters(validatedOutput.data, payload);
    
    return NextResponse.json(finalJsonResult, { status: 200 });

  } catch (error) {
    clearTimeout(timeoutId); // Ensure the timer is always cleared
    
    // Check if the error was triggered by our AbortController
    if (error.name === 'AbortError') {
      console.error("🔥 GEMINI TIMEOUT CAUGHT");
      return NextResponse.json(getFallbackPayload(payload.ticket_id, "timeout_exceeded"), { status: 200 });
    }

    console.error("🔥 GEMINI EXECUTION ERROR:", error.message);
    const backupJson = getFallbackPayload(payload.ticket_id, error.message);
    return NextResponse.json(backupJson, { status: 200 });
  }
}