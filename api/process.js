import Anthropic from "@anthropic-ai/sdk";

export const config = { api: { bodyParser: false } };

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseBoundary(contentType) {
  const m = contentType.match(/boundary=(.+)/);
  return m ? m[1] : null;
}

function parseMultipart(buffer, boundary) {
  const sep = Buffer.from("--" + boundary);
  const parts = [];
  let start = 0;
  while (start < buffer.length) {
    const sepIdx = buffer.indexOf(sep, start);
    if (sepIdx === -1) break;
    const after = sepIdx + sep.length;
    if (buffer[after] === 45 && buffer[after + 1] === 45) break;
    const headerEnd = buffer.indexOf("\r\n\r\n", after);
    if (headerEnd === -1) break;
    const headerStr = buffer.slice(after + 2, headerEnd).toString();
    const dataStart = headerEnd + 4;
    const nextSep = buffer.indexOf("\r\n" + sep, dataStart);
    const dataEnd = nextSep === -1 ? buffer.length : nextSep;
    parts.push({ headers: headerStr, data: buffer.slice(dataStart, dataEnd) });
    start = dataEnd + 2;
  }
  return parts;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const body = await readBody(req);
    const boundary = parseBoundary(req.headers["content-type"] || "");
    if (!boundary) return res.status(400).json({ error: "Bad request" });

    const parts = parseMultipart(body, boundary);
    let fileData = null, fileName = "", prefs = {};

    for (const part of parts) {
      const nameMatch = part.headers.match(/name="([^"]+)"/);
      const fileNameMatch = part.headers.match(/filename="([^"]+)"/);
      if (!nameMatch) continue;
      if (nameMatch[1] === "preferences") prefs = JSON.parse(part.data.toString());
      else if (nameMatch[1] === "file" && fileNameMatch) {
        fileName = fileNameMatch[1].toLowerCase();
        fileData = part.data;
      }
    }

    if (!fileData) return res.status(400).json({ error: "Nessun file caricato" });

    const lengthInstructions = {
      short:  "Copri il 20% del contenuto: 2-3 paragrafi per ogni capitolo/sezione.",
      medium: "Copri il 40% del contenuto: 4-6 paragrafi per ogni capitolo con tutti i concetti chiave.",
      long:   "Copri il 60% del contenuto: tratta ogni capitolo in modo esaustivo con definizioni complete."
    }[prefs.length || "medium"];

    const styleNote = {
      semplice:      "Linguaggio chiaro per studenti al primo anno.",
      universitario: "Linguaggio tecnico preciso per esami universitari.",
      esempi:        "Spiega ogni concetto con esempi concreti."
    }[prefs.style || "semplice"];

    const outputParts = [];

    if (prefs.summary) outputParts.push(`== RIASSUNTO ==
${lengthInstructions} ${styleNote}
Struttura CAPITOLO PER CAPITOLO. Per ogni capitolo: titolo + paragrafi di testo continuo e denso (NON elenchi striminziti).`);

    if (prefs.mindmap) outputParts.push(`== MAPPA CONCETTUALE ==
${lengthInstructions} ${styleNote}
Capitolo per capitolo. Usa: → concetti principali / • sotto-concetti / ◦ dettagli con breve spiegazione.`);

    if (prefs.chapters) outputParts.push(`== CAPITOLI ==
Elenca i capitoli principali. Ultima riga di questa sezione, esattamente:
{"chapters":["Cap 1","Cap 2","Cap 3"]}`);

    const diffNote = { facile:"semplici", medio:"media difficoltà", difficile:"impegnative" }[prefs.quiz_diff || "medio"];
    const scopeNote = { generale:"sull intero contenuto", capitolo:"2-3 per ogni capitolo", paragrafo:"specifiche per ogni sezione" }[prefs.quiz_scope || "capitolo"];
    outputParts.push(`== QUIZ (${prefs.quiz_count || 10} domande) ==
Domande a scelta multipla ${diffNote}, ${scopeNote}.
DOMANDA N: [testo]
A) B) C) D)
RISPOSTA CORRETTA: [lettera]
SPIEGAZIONE: [testo]
---`);

    const examTypeNote = { aperte:"domande aperte", miste:"mix aperte + vero/falso", orale:"stile colloquio orale" }[prefs.exam_type || "aperte"];
    outputParts.push(`== SIMULAZIONE ESAME (${prefs.exam_count || 3} domande) ==
${examTypeNote} da esame universitario.
DOMANDA ESAME N: [testo]
RISPOSTA MODELLO: [risposta completa]
---`);

    const prompt = `Sei un tutor universitario. ${styleNote}
Produci output CORPOSI e UTILI. Non fare riassunti di una riga per capitolo.

${outputParts.join("\n\n")}`;

    let messageContent;
    if (fileName.endsWith(".pdf")) {
      messageContent = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileData.toString("base64") } },
        { type: "text", text: prompt }
      ];
    } else if (fileName.endsWith(".txt") || fileName.endsWith(".md")) {
      messageContent = `${prompt}\n\n== TESTO ==\n${fileData.toString("utf8").substring(0, 90000)}`;
    } else if (fileName.endsWith(".docx")) {
      messageContent = `${prompt}\n\n== TESTO ==\n${fileData.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").substring(0, 60000)}`;
    } else {
      const ext = fileName.split(".").pop();
      const mt = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || "image/jpeg";
      messageContent = [
        { type: "image", source: { type: "base64", media_type: mt, data: fileData.toString("base64") } },
        { type: "text", text: prompt }
      ];
    }

    // Use streaming to avoid Vercel 504 timeout
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullText = "";

    const stream = client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8000,
      messages: [{ role: "user", content: messageContent }]
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        fullText += event.delta.text;
        res.write(`data: ${JSON.stringify({ chunk: event.delta.text })}\n\n`);
      }
    }

    // Extract chapters
    let chapters = [];
    const match = fullText.match(/\{"chapters":\s*\[.*?\]\}/s);
    if (match) { try { chapters = JSON.parse(match[0]).chapters; } catch {} }

    res.write(`data: ${JSON.stringify({ done: true, chapters })}\n\n`);
    res.end();

  } catch (e) {
    console.error(e);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
}
