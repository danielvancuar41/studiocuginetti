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
    let fileData = null, fileName = "";

    for (const part of parts) {
      const nameMatch = part.headers.match(/name="([^"]+)"/);
      const fileNameMatch = part.headers.match(/filename="([^"]+)"/);
      if (!nameMatch) continue;
      if (nameMatch[1] === "file" && fileNameMatch) {
        fileName = fileNameMatch[1].toLowerCase();
        fileData = part.data;
      }
    }

    if (!fileData) return res.status(400).json({ error: "Nessun file" });

    const prompt = `Analizza questo testo e dividilo in capitoli/sezioni principali.

Per ogni capitolo restituisci:
1. Il titolo del capitolo
2. Il testo COMPLETO del capitolo (copia fedelmente tutto il testo originale, non riassumere)

Formato OBBLIGATORIO - usa esattamente questi separatori:
===CAPITOLO_START===
TITOLO: [titolo del capitolo]
TESTO:
[tutto il testo del capitolo, copiato fedelmente]
===CAPITOLO_END===

Ripeti per ogni capitolo. Non omettere nulla del testo originale.`;

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
      return res.status(400).json({ error: "Formato non supportato per la divisione. Usa PDF, TXT o DOCX." });
    }

    // Streaming response
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

    // Parse chapters from fullText
    const chapters = [];
    const chapRegex = /===CAPITOLO_START===\s*TITOLO:\s*(.+?)\s*TESTO:\s*([\s\S]*?)===CAPITOLO_END===/g;
    let match;
    while ((match = chapRegex.exec(fullText)) !== null) {
      chapters.push({ title: match[1].trim(), text: match[2].trim() });
    }

    res.write(`data: ${JSON.stringify({ done: true, chapters })}\n\n`);
    res.end();

  } catch (e) {
    console.error(e);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
}
