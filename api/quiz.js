import Anthropic from "@anthropic-ai/sdk";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { topic, context, num_questions = 5, mode = "quiz" } = req.body;

  if (!topic) return res.status(400).json({ error: "Argomento mancante" });

  const prompt = mode === "exam"
    ? `Crea una simulazione di esame su: ${topic}\n\nContesto: ${(context || "").substring(0, 2000)}\n\nGenera 5 domande aperte impegnative.\nFormato:\nDOMANDA N: [testo]\nRISPOSTA MODELLO: [risposta]\n---`
    : `Crea un quiz di ${num_questions} domande a scelta multipla su: ${topic}\n\nContesto: ${(context || "").substring(0, 2000)}\n\nFormato OBBLIGATORIO:\nDOMANDA N: [testo]\nA) [opzione]\nB) [opzione]\nC) [opzione]\nD) [opzione]\nRISPOSTA CORRETTA: [lettera]\nSPIEGAZIONE: [breve spiegazione]\n---`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }]
    });
    res.json({ quiz: response.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
