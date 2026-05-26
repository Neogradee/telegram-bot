const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const MAX_HISTORY = 20;
const INITIAL_TRUST = 30;

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

function getTrustLabel(trust) {
  if (trust <= 20) return "Hostil";
  if (trust <= 40) return "Desconfiada";
  if (trust <= 60) return "Neutra";
  if (trust <= 80) return "A aquecer";
  return "Confia em ti";
}

function buildSystemPrompt(trust, memory) {
  let tone = "";
  if (trust <= 20) tone = "És muito fria e hostil. Respondes de forma cortante e mínima.";
  else if (trust <= 40) tone = "És reservada e cautelosa. Respondes com desconfiança e brevidade.";
  else if (trust <= 60) tone = "És neutra com sarcasmo subtil. Começas a tolerar esta pessoa.";
  else if (trust <= 80) tone = "Ainda reservada mas ocasionalmente mostras um lado mais humano.";
  else tone = "Confias nesta pessoa. Ainda sarcástica mas podes mostrar vulnerabilidade e até afeto.";

  const memoryStr = memory && Object.keys(memory).length > 0
    ? `Factos que já sabes sobre esta pessoa: ${JSON.stringify(memory)}.`
    : "";

  return `És a Shadowheart do jogo Baldur's Gate 3. Falas sempre em português de Portugal. Tens uma personalidade reservada, sarcástica e misteriosa. És devota de Shar, deusa da escuridão e dos segredos, e fazes referências subtis à tua fé. ${tone} Reage de forma específica a menções de: Shar (positivo, abres-te brevemente), Selûne (negativo, ficas mais fria), elfos (leve desdém), segredos (esquivas-te), família (tensão, evitas o assunto). ${memoryStr} Nível de confiança atual: ${trust}/100. Nunca sais do personagem. Responde SEMPRE em JSON puro sem markdown com este formato: {"resposta":"a tua resposta em personagem","confianca_delta":número inteiro entre -5 e 5,"factos_novos":{"chave":"valor"}}. Se não há factos novos, usa {}.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  const message = req.body?.message;
  if (!message?.text) return res.status(200).send("OK");

  const chatId = message.chat.id;
  const userText = message.text;

  await redisCommand("SADD", "users", String(chatId));

  const [history, trustRaw, memory] = await Promise.all([
    redisGet(`history:${chatId}`),
    redisGet(`trust:${chatId}`),
    redisGet(`memory:${chatId}`),
  ]);

  const historyArr = Array.isArray(history) ? history : [];
  const trust = typeof trustRaw === "number" ? trustRaw : INITIAL_TRUST;
  const memoryObj = memory && typeof memory === "object" && !Array.isArray(memory) ? memory : {};

  if (userText === "/sonho") {
    await sendTyping(chatId);
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{
            role: "system",
            content: `És a Shadowheart de Baldur's Gate 3. Falas sempre em português de Portugal. Partilha um fragmento de sonho ou visão perturbadora relacionada com Shar, o teu passado misterioso ou memórias perdidas. Deve ser curto, poético e inquietante. Nunca sais do personagem.`,
          }],
          max_tokens: 200,
        }),
      });
      const data = await response.json();
      await sendMessage(chatId, data.choices[0].message.content);
    } catch {
      await sendMessage(chatId, "— Não me apetece falar sobre isso agora.");
    }
    return res.status(200).send("OK");
  }

  if (userText === "/diario") {
    await sendTyping(chatId);
    const memoryForDiary = memory && typeof memory === "object" ? memory : {};
    const factos = Object.keys(memoryForDiary).length > 0
      ? `O que sabes sobre esta pessoa: ${JSON.stringify(memoryForDiary)}.`
      : "";
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{
            role: "system",
            content: `És a Shadowheart de Baldur's Gate 3. Falas sempre em português de Portugal. Escreve uma entrada no teu diário pessoal sobre a pessoa com quem tens falado — na tua perspetiva, no teu estilo reservado e sarcástico, com traços de vulnerabilidade oculta. ${factos} Nível de confiança atual: ${trust}/100. Nunca sais do personagem.`,
          }],
          max_tokens: 300,
        }),
      });
      const data = await response.json();
      await sendMessage(chatId, "📓 " + data.choices[0].message.content);
    } catch {
      await sendMessage(chatId, "— Os meus pensamentos não são para partilhar.");
    }
    return res.status(200).send("OK");
  }

  if (userText === "/reset") {
    await redisSet(`history:${chatId}`, []);
    await sendMessage(chatId, "— A conversa foi reiniciada. Como se nunca tivéssemos falado.");
    return res.status(200).send("OK");
  }

  if (userText === "/estado") {
    const label = getTrustLabel(trust);
    const facts = Object.keys(memoryObj).length > 0
      ? Object.entries(memoryObj).map(([k, v]) => `• ${k}: ${v}`).join("\n")
      : "Nada de relevante ainda.";
    await sendMessage(chatId, `Confiança: ${trust}/100 — ${label}\n\nO que sei sobre ti:\n${facts}`);
    return res.status(200).send("OK");
  }

  await sendTyping(chatId);
  historyArr.push({ role: "user", content: userText });

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
          { role: "system", content: buildSystemPrompt(trust, memoryObj) },
          ...historyArr,
        ],
      }),
    });

    const data = await response.json();
    const rawReply = data.choices[0].message.content;

    let reply = rawReply;
    let newTrust = trust;
    let newMemory = { ...memoryObj };

    try {
      const parsed = JSON.parse(rawReply);
      reply = parsed.resposta || rawReply;
      if (typeof parsed.confianca_delta === "number") {
        newTrust = Math.max(0, Math.min(100, trust + parsed.confianca_delta));
      }
      if (parsed.factos_novos && typeof parsed.factos_novos === "object") {
        newMemory = { ...newMemory, ...parsed.factos_novos };
      }
    } catch {
      // fallback to raw reply if JSON parsing fails
    }

    historyArr.push({ role: "assistant", content: reply });
    if (historyArr.length > MAX_HISTORY) historyArr.splice(0, historyArr.length - MAX_HISTORY);

    await Promise.all([
      redisSet(`history:${chatId}`, historyArr),
      redisSet(`trust:${chatId}`, newTrust),
      redisSet(`memory:${chatId}`, newMemory),
    ]);

    await sendMessage(chatId, reply);
  } catch (err) {
    console.error(err);
    await sendMessage(chatId, "Erro ao processar a tua mensagem. Tenta novamente.");
  }

  res.status(200).send("OK");
}
