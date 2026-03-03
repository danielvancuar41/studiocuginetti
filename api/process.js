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
    if (buffer[after] === 45 && buffer[after + 1] === 45) break; // --
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
    let fileData = null;
    let fileName = "";
    let prefs = {};

    for (const part of parts) {
      const nameMatch = part.headers.match(/name="([^"]+)"/);
      const fileNameMatch = part.headers.match(/filename="([^"]+)"/);
      if (!nameMatch) continue;

      if (nameMatch[1] === "preferences") {
        prefs = JSON.parse(part.data.toString());
      } else if (nameMatch[1] === "file" && fileNameMatch) {
        fileName = fileNameMatch[1].toLowerCase();
        fileData = part.data;
      }
    }

    if (!fileData) return res.status(400).json({ error: "Nessun file" });

    // Limit file size to avoid 413 - truncate to 3MB
    if (fileData.length > 3 * 1024 * 1024) {
      fileData = fileData.slice(0, 3 * 1024 * 1024);
    }

    // Build prompt
    const outputParts = [];
    const len = { short: "breve (max 200 parole per capitolo)", medium: "medio (~400 parole)", long: "dettagliato e completo" }[prefs.length || "medium"];

    if (prefs.summary) outputParts.push(`1. RIASSUNTO: scrivi un riassunto ${len}.`);
    if (prefs.mindmap) outputParts.push(`1. MAPPA CONCETTUALE: struttura ad albero ${len} con indentazione e simboli (→, •, ◦).`);
    if (prefs.chapters) outputParts.push('2. CAPITOLI: identifica i capitoli/argomenti principali. Alla fine aggiungi esattamente questo JSON su una riga: {"chapters":["cap1","cap2",...]}');

    // Quiz — always included
    const diffNote = { facile: "semplici e dirette", medio: "di media difficoltà", difficile: "impegnative e approfondite" }[prefs.quiz_diff || "facile"];
    const scopeNote = { generale: "sull'intero contenuto", capitolo: "divise per capitolo", paragrafo: "molto specifiche per ogni paragrafo/sezione" }[prefs.quiz_scope || "generale"];
    outputParts.push(`3. QUIZ: genera ${prefs.quiz_count || 10} domande a scelta multipla ${diffNote}, ${scopeNote}. Formato: DOMANDA N: [testo] A) B) C) D) RISPOSTA CORRETTA: [lettera] SPIEGAZIONE: [testo] ---`);

    // Exam simulation — always included
    const examTypeNote = { aperte: "domande aperte classiche", miste: "mix di domande aperte e vero/falso", orale: "domande stile colloquio orale con possibili controdomande" }[prefs.exam_type || "aperte"];
    outputParts.push(`4. SIMULAZIONE ESAME: genera ${prefs.exam_count || 3} ${examTypeNote} impegnative come in un esame vero, con risposta modello dettagliata.`);

    const styleNote = { semplice: "Usa un linguaggio semplice, adatto a studenti delle superiori.", universitario: "Usa linguaggio tecnico e preciso, livello universitario.", esempi: "Usa molti esempi pratici e analogie." }[prefs.style || "semplice"];

    const prompt = `Sei un tutor esperto. ${styleNote}\n\nOUTPUT RICHIESTI:\n${outputParts.join("\n")}\n\nMATERIALE:\n[vedi allegato]`;

    let messageContent;

    if (fileName.endsWith(".pdf")) {
      messageContent = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileData.toString("base64") } },
        { type: "text", text: prompt }
      ];
    } else if (fileName.endsWith(".docx")) {
      // Extract basic text from docx (XML-based)
      const text = fileData.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").substring(0, 50000);
      messageContent = `${prompt}\n\nTESTO ESTRATTO:\n${text}`;
    } else {
      const ext = fileName.split(".").pop();
      const mediaType = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || "image/jpeg";
      messageContent = [
        { type: "image", source: { type: "base64", media_type: mediaType, data: fileData.toString("base64") } },
        { type: "text", text: prompt }
      ];
    }

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: messageContent }]
    });

    const resultText = response.content[0].text;

    // Extract chapters JSON if present
    let chapters = [];
    const match = resultText.match(/\{"chapters":\s*\[.*?\]\}/s);
    if (match) {
      try { chapters = JSON.parse(match[0]).chapters; } catch {}
    }

    res.json({ result: resultText, chapters });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
