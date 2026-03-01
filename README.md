# 📚 Studiamoci!

Il tuo tutor AI personale — carica un libro, ricevi riassunti, mappe concettuali, un piano di studio e quiz interattivi. Alimentato da Claude di Anthropic.

## ✨ Funzionalità

- 📁 Carica PDF, Word (.docx) o foto degli appunti
- 📝 Riassunti brevi, medi o dettagliati
- 🗺️ Mappe concettuali a struttura ad albero
- 📑 Divisione automatica per capitoli
- 📅 Piano di studio giorno per giorno in base alla data dell'esame
- ❓ Quiz a scelta multipla con correzione automatica e spiegazioni
- 🎯 Simulazione d'esame con domande aperte e risposte modello

---

## 🚀 Deploy su Vercel (5 minuti)

### 1. Ottieni una API Key di Anthropic
Vai su [console.anthropic.com](https://console.anthropic.com), crea un account gratuito e genera una API Key.

### 2. Carica su GitHub
Carica questa cartella su un repository GitHub (pubblico o privato).

### 3. Collega Vercel
1. Vai su [vercel.com](https://vercel.com) e accedi con GitHub
2. Clicca **"Add New Project"** → seleziona il tuo repository
3. Clicca **"Deploy"** — Vercel riconosce tutto da solo

### 4. Aggiungi la API Key
Dopo il deploy, in Vercel:
1. Vai su **Settings → Environment Variables**
2. Aggiungi: `ANTHROPIC_API_KEY` = `sk-ant-...`
3. Clicca **Save** e poi **Redeploy**

✅ Fatto! Il sito è online.

---

## 🗂️ Struttura del progetto

```
studiamoci/
├── index.html          ← tutto il sito
├── package.json        ← dipendenze JS
├── vercel.json         ← configurazione Vercel
└── api/
    ├── process.js      ← elabora il file con Claude
    ├── quiz.js         ← genera quiz e simulazioni
    └── study-plan.js   ← costruisce il piano di studio
```

Le funzioni nella cartella `api/` girano lato server su Vercel, quindi la API key non è mai visibile agli utenti.

---

## 📖 Come si usa

```
① Carica il file  →  ② Scegli gli output  →  ③ Leggi gli appunti
                                                      ↓
⑤ Quiz & Simulazione  ←  ④ Piano di studio
```

1. **Carica** il tuo libro o appunti (PDF, Word, foto)
2. **Configura** cosa vuoi: riassunto, mappa concettuale, capitoli, quiz, simulazione esame
3. **Leggi** gli appunti generati da Claude
4. **Inserisci la data dell'esame** per avere un piano di studio giorno per giorno
5. **Allenati** con il quiz o fai una simulazione d'esame completa

---

## 🛠️ Problemi comuni

**Il sito carica ma le API non rispondono** → Controlla che la variabile `ANTHROPIC_API_KEY` sia impostata nelle Environment Variables di Vercel e che tu abbia fatto Redeploy dopo averla aggiunta.

**Errore sul file** → Verifica che sia PDF, DOCX, JPG, PNG o WEBP e che non superi i 10MB.

**Il piano di studio non si genera** → Assicurati di aver attivato "Dividi per capitoli" prima di elaborare il file, oppure aggiungi i capitoli manualmente nel Step 4.

---

*Fatto con ❤️ — open source, libero da usare e modificare.*
