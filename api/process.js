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

const CHUNK_SIZE = 80000; // chars per part

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const body = await readBody(req);
    const boundary = parseBoundary(req.headers["content-type"] || "");
    if (!boundary) return res.status(400).json({ error: "Bad request" });

    const parts = parseMultipart(body, boundary);
    let fileData = null, fileName = "", prefs = {}, partIndex = 0, totalParts = 1;

    for (const part of parts) {
      const nameMatch = part.headers.match(/name="([^"]+)"/);
      const fileNameMatch = part.headers.match(/filename="([^"]+)"/);
      if (!nameMatch) continue;
      if (nameMatch[1] === "preferences") prefs = JSON.parse(part.data.toString());
      else if (nameMatch[1] === "partIndex") partIndex = parseInt(part.data.toString());
      else if (nameMatch[1] === "totalParts") totalParts = parseInt(part.data.toString());
      else if (nameMatch[1] === "file" && fileNameMatch) {
        fileName = fileNameMatch[1].toLowerCase();
        fileData = part.data;
      }
    }

    if (!fileData) return res.status(400).json({ error: "Nessun file caricato" });

    // Extract text
    let fullText = "";
    if (fileName.endsWith(".txt") || fileName.endsWith(".md")) {
      fullText = fileData.toString("utf8");
    } else if (fileName.endsWith(".docx")) {
      fullText = fileData.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    } else if (fileName.endsWith(".pdf")) {
      // PDF: send directly to Claude with base64
      fullText = null;
    }

    // Split into chunks if text-based
    let chunks = [];
    if (fullText !== null) {
      const total = Math.ceil(fullText.length / CHUNK_SIZE);
      for (let i = 0; i < total; i++) {
        chunks.push(fullText.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
      }
      totalParts = chunks.length;
    }

    const lengthInstructions = {
      short:  "Copri il 20% del contenuto: 2-3 paragrafi per ogni sezione/argomento.",
      medium: "Copri il 40% del contenuto: 4-6 paragrafi per ogni sezione con tutti i concetti chiave.",
      long:   "Copri il 60% del contenuto: tratta ogni sezione in modo esaustivo con definizioni complete."
    }[prefs.length || "medium"];

    const styleNote = {
      semplice:      "Linguaggio chiaro per studenti.",
      universitario: "Linguaggio tecnico preciso per esami universitari.",
      esempi:        "Spiega ogni concetto con esempi concreti."
    }[prefs.style || "semplice"];

    const isFirstPart = partIndex === 0;
    const isLastPart = partIndex === totalParts - 1;
    const partLabel = totalParts > 1 ? ` (parte ${partIndex + 1} di ${totalParts})` : "";

    const outputParts = [];

    if (prefs.summary || prefs.mindmap) {
      const type = prefs.mindmap
        ? `MAPPA CONCETTUALE${partLabel} — usa → • ◦ per la struttura ad albero`
        : `RIASSUNTO${partLabel}`;
      outputParts.push(`== ${type} ==
${lengthInstructions} ${styleNote}
Struttura sezione per sezione seguendo il testo. Paragrafi densi e completi, NON elenchi striminziti.
${isFirstPart ? "Inizia direttamente col contenuto." : "Continua dal punto in cui si era interrotto il riassunto precedente."}
${isLastPart && prefs.chapters ? "" : ""}`);
    }

    if (prefs.chapters && isLastPart) {
      outputParts.push(`== INDICE ARGOMENTI ==
Elenca tutti i capitoli/argomenti principali trovati nell'intero testo.
Ultima riga esattamente:
{"chapters":["Argomento 1","Argomento 2","Argomento 3"]}`);
    }

    if (isLastPart) {
      const diffNote = { facile:"semplici", medio:"media difficoltà", difficile:"impegnative" }[prefs.quiz_diff || "medio"];
      const scopeNote = { generale:"sull intero contenuto", capitolo:"2-3 per ogni argomento principale", paragrafo:"specifiche per ogni sezione" }[prefs.quiz_scope || "capitolo"];
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
    }

    const prompt = `Sei un tutor universitario. ${styleNote}
Produci output CORPOSI e UTILI allo studio.

${outputParts.join("\n\n")}`;

    let messageContent;
    if (fileName.endsWith(".pdf")) {
      messageContent = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileData.toString("base64") } },
        { type: "text", text: prompt }
      ];
    } else {
      const chunkText = chunks[partIndex] || chunks[0] || fullText.substring(0, CHUNK_SIZE);
      messageContent = `${prompt}\n\n== TESTO (parte ${partIndex + 1} di ${totalParts}) ==\n${chunkText}`;
    }

    // Streaming
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Send metadata first
    res.write(`data: ${JSON.stringify({ meta: { totalParts, partIndex } })}\n\n`);

    let fullResponse = "";
    const stream = client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8000,
      messages: [{ role: "user", content: messageContent }]
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        fullResponse += event.delta.text;
        res.write(`data: ${JSON.stringify({ chunk: event.delta.text })}\n\n`);
      }
    }

    let chapters = [];
    const match = fullResponse.match(/\{"chapters":\s*\[.*?\]\}/s);
    if (match) { try { chapters = JSON.parse(match[0]).chapters; } catch {} }

    res.write(`data: ${JSON.stringify({ done: true, chapters, totalParts, partIndex, isLastPart })}\n\n`);
    res.end();

  } catch (e) {
    console.error(e);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
}
