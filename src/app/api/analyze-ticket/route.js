import { NextResponse } from 'next/server';
import { RequestSchema } from '@/lib/schemas';
import { SYSTEM_INSTRUCTION, generateUserPrompt } from '@/lib/prompts';
import { applySafetyFilters } from '@/lib/safetyFilters';

// 1. Import the NEW official SDK
import { GoogleGenAI } from '@google/genai';

// 2. Initialize the client (it automatically detects process.env.GEMINI_API_KEY)
const ai = new GoogleGenAI({});

const getFallbackPayload = (ticketId, diagnosticMessage) => ({
  ticket_id: ticketId || "UNKNOWN",
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

  const parsingResult = RequestSchema.safeParse(rawBody);
  if (!parsingResult.success) {
    return NextResponse.json({ error: parsingResult.error.format() }, { status: 400 });
  }

  const payload = parsingResult.data;
  if (!payload.complaint || payload.complaint.trim() === "") {
    return NextResponse.json({ error: "Semantic error: Complaint text field is missing values" }, { status: 422 });
  }

  try {
    const geminiTask = (async () => {
      
      // 3. Use the new SDK's structure to enforce JSON
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash', // The correct, real model name
        contents: generateUserPrompt(payload),
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json'
        }
      });
      
      // 4. Note: In the new SDK, .text is a property, not a function!
      return response.text;
    })();

    const timeoutTask = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("GATEWAY_TIMEOUT")), 25000)
    );

    const rawAiOutput = await Promise.race([geminiTask, timeoutTask]);
    
    const cleanedOutput = cleanJsonString(rawAiOutput);
    const validatedJsonResult = applySafetyFilters(JSON.parse(cleanedOutput), payload.ticket_id);
    
    return NextResponse.json(validatedJsonResult, { status: 200 });

  } catch (error) {
    console.error("🔥 GEMINI EXECUTION ERROR:", error.message);
    
    const backupJson = getFallbackPayload(payload.ticket_id, error.message);
    return NextResponse.json(backupJson, { status: 200 });
  }
}