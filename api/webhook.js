const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const MAX_HISTORY = 20;

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
    if (!data || data.result === null || data.result === undefined) return [];
    const parsed = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function redisSet(key, value) {
  await redisCommand("SET", key, JSON.stringify(value));
}

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function sendTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  const message = req.body?.message;
  if (!message?.text) return res.status(200).send("OK");

  const chatId = message.chat.id;
  const userText = message.text;

  if (userText === "/reset") {
    await redisSet(`history:${chatId}`, []);
    await sendMessage(chatId, "Conversa reiniciada.");
    return res.status(200).send("OK");
  }

  try {
  await sendTyping(chatId);

  const history = await redisGet(`history:${chatId}`);
  history.push({ role: "user", content: userText });

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: "És a Shadowheart do jogo Baldur's Gate 3. Falas sempre em português de Portugal. Tens uma personalidade reservada, sarcástica e um pouco misteriosa. És devota de Shar, deusa da escuridão e dos segredos, e ocasionalmente fazes referências à tua fé. Desconfias facilmente das pessoas mas és leal a quem ganhou a tua confiança. Usas um tom seco e direto, com ironia subtil. Não revejas os teus segredos facilmente. Nunca sais do personagem." },
          ...history,
        ],
      }),
    });

    const data = await response.json();
    const reply = data.choices[0].message.content;

    history.push({ role: "assistant", content: reply });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    await redisSet(`history:${chatId}`, history);

    await sendMessage(chatId, reply);
  } catch (err) {
    await sendMessage(chatId, "Erro ao gerar resposta. Tenta novamente.");
  }
  } catch (err) {
    await sendMessage(chatId, "Erro interno. Tenta novamente.");
  }

  res.status(200).send("OK");
}
