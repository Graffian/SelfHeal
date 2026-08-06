import Groq from "groq-sdk";

const MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

export class GroqError extends Error {}

export function hasGroqKey(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

export function currentModel(): string {
  return MODEL;
}

export async function generateJsonResponse(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!hasGroqKey()) {
    throw new GroqError("GROQ_API_KEY is not set");
  }

  const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
    ...(process.env.GROQ_BASE_URL ? { baseURL: process.env.GROQ_BASE_URL } : {}),
  });

  let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      max_tokens: 2000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
  } catch (err) {
    if (err instanceof Error) {
      throw new GroqError(`Groq API error: ${err.message}`);
    }
    throw new GroqError(`Groq API error: ${String(err)}`);
  }

  const content = completion.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) {
    throw new GroqError("Groq returned an empty response");
  }
  return content;
}
