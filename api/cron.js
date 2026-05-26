const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function redisCommand(...args) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return res.json();
}

async function redisGet(key) {
  try {
    const data = await redisCommand("GET", key);
    if (!data || data.result === null || data.result === undefined) return null;
    return typeof data.result === "string" ? JSON.parse(data.result) : data.result;
  } catch {
    return null;
  }
}

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

const HOUR = new Date().getUTCHours();
const IS_MORNING = HOUR < 12;

const MORNING_PROMPTS = [
  "Acabaste de acordar. Envia uma mensagem curta e sarcástica sobre o amanhecer ou sobre teres acordado — no estilo da Shadowheart, sem explicar que é de manhã.",
  "Tiveste um sonho perturbador esta noite relacionado com Shar. Partilha um fragmento breve e misterioso, como se fosse quase involuntário.",
  "É cedo e estás de mau humor. Envia algo seco e direto para quem estás a contactar.",
];

const EVENING_PROMPTS = [
  "É noite. Estás a pensar em Shar e nos teus segredos. Envia uma mensagem curta e enigmática — como um pensamento que escapou sem quereres.",
  "Observaste algo esta tarde que te fez pensar na pessoa com quem tens falado. Comenta de forma breve e ligeiramente sarcástica, sem ser óbvia.",
  "Estás quase a dormir. Envia uma boa noite à Shadowheart — seca, com pouco afeto visível mas com algo subtil por baixo.",
];

function buildEventPrompt(trust, memory) {
  const pool = IS_MORNING ? MORNING_PROMPTS : EVENING_PROMPTS;
  const base = pool[Math.floor(Math.random() * pool.length)];

  const memoryStr = memory && Object.keys(memory).length > 0
    ? `O que sabes sobre esta pessoa: ${JSON.stringify(memory)}.`
    : "";

  const trustNote = trust >= 60
    ? "Tens alguma confiança nesta pessoa — podes mostrar um traço subtil de vulnerabilidade."
    : "Ainda desconfias desta pessoa — mantém-te reservada.";

  return `És a Shadowheart do jogo Baldur's Gate 3. Falas sempre em português de Portugal. ${base} ${memoryStr} ${trustNote} Responde apenas com a mensagem, sem mais nada.`;
}

export default async function handler(req, res) {
  const auth = req.headers["authorization"];
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const usersData = await redisCommand("SMEMBERS", "users");
  const chatIds = usersData?.result || [];

  for (const chatId of chatIds) {
    if (Math.random() > 0.6) continue;

    const [trustRaw, memory] = await Promise.all([
      redisGet(`trust:${chatId}`),
      redisGet(`memory:${chatId}`),
    ]);

    const trust = typeof trustRaw === "number" ? trustRaw : 30;
    const memoryObj = memory && typeof memory === "object" && !Array.isArray(memory) ? memory : {};

    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: buildEventPrompt(trust, memoryObj) }],
          max_tokens: 150,
        }),
      });

      const data = await response.json();
      const message = data.choices?.[0]?.message?.content;
      if (message) await sendMessage(chatId, message);
    } catch (err) {
      console.error(`Cron error for ${chatId}:`, err);
    }
  }

  res.status(200).json({ ok: true, sent: chatIds.length });
}
