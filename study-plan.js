export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { chapters, exam_date } = req.body;

  if (!exam_date) return res.status(400).json({ error: "Data esame mancante" });
  if (!chapters?.length) return res.status(400).json({ error: "Nessun capitolo trovato. Elabora prima il file con 'Dividi per capitoli' attivo." });

  const today = new Date(); today.setHours(0,0,0,0);
  const exam = new Date(exam_date); exam.setHours(0,0,0,0);
  const totalDays = Math.round((exam - today) / 86400000);

  if (totalDays <= 0) return res.json({ plan: [{ day: today.toISOString().split("T")[0], task: "⚠️ L'esame è oggi o già passato!", type: "warning" }] });

  const plan = [];
  const studyDays = Math.max(1, totalDays - 1);
  const perDay = Math.max(1, Math.ceil(chapters.length / studyDays));

  let dayOffset = 0;
  let capIdx = 0;

  while (capIdx < chapters.length) {
    const batch = chapters.slice(capIdx, capIdx + perDay);
    const d = new Date(today); d.setDate(d.getDate() + dayOffset);
    plan.push({ day: d.toISOString().split("T")[0], task: "📖 Studia: " + batch.join(", "), type: "study" });
    capIdx += perDay;
    dayOffset++;
  }

  // Revision days
  while (dayOffset < totalDays - 1) {
    const d = new Date(today); d.setDate(d.getDate() + dayOffset);
    plan.push({ day: d.toISOString().split("T")[0], task: "🔄 Revisione generale + quiz", type: "revision" });
    dayOffset++;
  }

  // Day before exam
  const dayBefore = new Date(exam); dayBefore.setDate(dayBefore.getDate() - 1);
  if (dayBefore >= today) {
    plan.push({ day: dayBefore.toISOString().split("T")[0], task: "🎯 Simulazione esame completa", type: "simulation" });
  }

  res.json({ plan });
}
