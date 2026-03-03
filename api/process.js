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
      else if (nameMatch[1] === "file" && fileNameMatch) { fileName = fileNameMatch[1].toLowerCase(); fileData = part.data; }
    }

    if (!fileData) return res.status(400).json({ error: "Nessun file caricato" });

    const lengthInstructions = {
      short:  "Il riassunto deve coprire il 20% del contenuto: almeno 2-3 paragrafi per ogni capitolo/sezione.",
      medium: "Il riassunto deve coprire il 40% del contenuto: almeno 4-6 paragrafi per ogni capitolo/sezione con tutti i concetti chiave.",
      long:   "Il riassunto deve coprire il 60% del contenuto: tratta ogni capitolo/sezione in modo esaustivo con paragrafi dettagliati e definizioni complete."
    }[prefs.length || "medium"];

    const styleNote = {
      semplice:      "Linguaggio chiaro e semplice, adatto a studenti al primo anno.",
      universitario: "Linguaggio tecnico e preciso per esami universitari avanzati.",
      esempi:        "Spiega ogni concetto con esempi concreti e analogie."
    }[prefs.style || "semplice"];

    const outputParts = [];

    if (prefs.summary) outputParts.push(`== SEZIONE 1: RIASSUNTO COMPLETO ==
REGOLA: ${lengthInstructions} Stile: ${styleNote}
Struttura capitolo per capitolo seguendo il testo originale.
Per ogni capitolo scrivi il titolo poi PARAGRAFI DI TESTO CONTINUO E DENSO (non elenchi puntati striminziti).
Questo deve essere un vero strumento di studio.`);

    if (prefs.mindmap) outputParts.push(`== SEZIONE 1: MAPPA CONCETTUALE COMPLETA ==
REGOLA: ${lengthInstructions.replace('riassunto','mappa')} Stile: ${styleNote}
Capitolo per capitolo, usa: → concetti principali / • sotto-concetti / ◦ dettagli
Ogni nodo deve avere una breve spiegazione, non solo parole chiave.`);

    if (prefs.chapters) outputParts.push(`== SEZIONE 2: CAPITOLI ==
Elenca i capitoli/argomenti principali.
OBBLIGATORIO — ultima riga di questa sezione, esattamente così:
{"chapters":["Capitolo 1","Capitolo 2","Capitolo 3"]}`);

    const diffNote = { facile:"semplici sui concetti base", medio:"di media difficoltà", difficile:"impegnative e ragionate" }[prefs.quiz_diff || "medio"];
    const scopeNote = { generale:"sull intero contenuto", capitolo:"2-3 domande per ogni capitolo organizzate per capitolo", paragrafo:"specifiche per ogni sezione del testo" }[prefs.quiz_scope || "capitolo"];
    outputParts.push(`== SEZIONE 3: QUIZ (${prefs.quiz_count || 10} domande) ==
Domande a scelta multipla ${diffNote}, ${scopeNote}.
Formato per ogni domanda:
DOMANDA N: [testo]
A) [opzione]
B) [opzione]
C) [opzione]
D) [opzione]
RISPOSTA CORRETTA: [lettera]
SPIEGAZIONE: [spiegazione dettagliata]
---`);

    const examTypeNote = { aperte:"domande aperte da esame scritto", miste:"mix aperte + vero/falso con motivazione", orale:"domande da colloquio orale con controdomande" }[prefs.exam_type || "aperte"];
    outputParts.push(`== SEZIONE 4: SIMULAZIONE ESAME (${prefs.exam_count || 3} domande) ==
${examTypeNote} come in un vero esame universitario.
DOMANDA ESAME N: [testo]
RISPOSTA MODELLO: [risposta completa come la darebbe uno studente preparato]
---`);

    const prompt = `Sei un tutor universitario esperto. ${styleNote}

PRODUCE OUTPUT COMPLETI E CORPOSI. Gli appunti devono essere UTILI allo studio — non fare riassunti di una riga per capitolo.

${outputParts.join("\n\n")}`;

    let messageContent;
    if (fileName.endsWith(".pdf")) {
      messageContent = [{ type:"document", source:{ type:"base64", media_type:"application/pdf", data:fileData.toString("base64") } }, { type:"text", text:prompt }];
    } else if (fileName.endsWith(".txt") || fileName.endsWith(".md")) {
      messageContent = `${prompt}\n\n== TESTO ==\n${fileData.toString("utf8").substring(0,90000)}`;
    } else if (fileName.endsWith(".docx")) {
      messageContent = `${prompt}\n\n== TESTO ==\n${fileData.toString("utf8").replace(/<[^>]+>/g," ").replace(/\s+/g," ").substring(0,60000)}`;
    } else {
      const ext = fileName.split(".").pop();
      const mt = { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp" }[ext] || "image/jpeg";
      messageContent = [{ type:"image", source:{ type:"base64", media_type:mt, data:fileData.toString("base64") } }, { type:"text", text:prompt }];
    }

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 7000,
      messages: [{ role:"user", content:messageContent }]
    });

    const resultText = response.content[0].text;
    let chapters = [];
    const match = resultText.match(/\{"chapters":\s*\[.*?\]\}/s);
    if (match) { try { chapters = JSON.parse(match[0]).chapters; } catch {} }

    res.json({ result: resultText, chapters });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
