import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// === GIGACHAT CONFIG ===
const GIGACHAT_CLIENT_ID = process.env.GIGACHAT_CLIENT_ID;
const GIGACHAT_CLIENT_SECRET = process.env.GIGACHAT_CLIENT_SECRET;
const GIGACHAT_SCOPE = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";
const GIGACHAT_MODEL = process.env.GIGACHAT_MODEL || "GigaChat";

if (!GIGACHAT_CLIENT_ID || !GIGACHAT_CLIENT_SECRET) {
  console.error("❌ GIGACHAT_CLIENT_ID и GIGACHAT_CLIENT_SECRET обязательны в .env");
  process.exit(1);
}

// === GIGACHAT AUTH ===
async function getGigaChatToken() {
  try {
    const credentials = Buffer.from(`${GIGACHAT_CLIENT_ID}:${GIGACHAT_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`,
        'RqUID': generateUuid(),
      },
      body: `scope=${GIGACHAT_SCOPE}`
    });

    if (!response.ok) {
      throw new Error(`GigaChat auth failed: ${response.status}`);
    }

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error('❌ GigaChat auth error:', error);
    throw error;
  }
}

function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// === SYSTEM PROMPT ДЛЯ АНТИБОТА ===
const SYSTEM_PROMPT_ANTIBOT = `
Ты — продвинутый антибот-классификатор. Анализируй поведение пользователя по множеству параметров.

ДАННЫЕ ДЛЯ АНАЛИЗА:
- Основные события: клики, ввод, paste
- Тайминги: общее время, интервалы, скорость ответов
- Поведение: движения мыши, время на каждый вопрос
- Технические данные: userAgent
- Ответы на вопросы квиза

КРИТЕРИИ АНАЛИЗА:
1. ЕСТЕСТВЕННОСТЬ ПОВЕДЕНИЯ:
   - Плавность движений мыши (резкие/прямые линии = бот)
   - Время на обдумывание ответов (одинаковое = бот)
   - Активность между вопросами (полное бездействие = бот)

2. ПАТТЕРНЫ ЧЕЛОВЕКА:
   - Случайные микропаузы
   - Неидеальная траектория мыши
   - Естественное изменение скорости ответов

3. ПРИЗНАКИ АВТОМАТИЗАЦИИ:
   - Машинная точность таймингов
   - Идеальная геометрия кликов
   - Отсутствие ошибок ввода
   - Предсказуемые паттерны

Верни строго JSON:
{
 "score": 0-100,
 "action": "allow" | "deny" | "challenge", 
 "reason": "подробное объяснение с указанием конкретных аномалий"
}

Будь строгим к подозрительным паттернам!
`;

// === КОНСТАНТЫ АНТИБОТА ===
const QUIZ_MIN_DURATION_MS = parseInt(process.env.QUIZ_MIN_DURATION_MS) || 8000;
const QUIZ_MIN_AVG_INTERVAL_MS = parseInt(process.env.QUIZ_MIN_AVG_INTERVAL_MS) || 300;
const QUIZ_DENY_THRESHOLD = parseInt(process.env.QUIZ_DENY_THRESHOLD) || 20;
const QUIZ_ALLOW_THRESHOLD = parseInt(process.env.QUIZ_ALLOW_THRESHOLD) || 85;

const BLACKLIST_PHONES = (process.env.BLACKLIST_PHONES || "").split(",").filter(Boolean);
const BLACKLIST_IPS = (process.env.BLACKLIST_IPS || "").split(",").filter(Boolean);
const BLACKLIST_UA = (process.env.BLACKLIST_UA || "python-requests,curl,headless").split(",").filter(Boolean);

// === КОНФИГ ДЛЯ ФРОНТОВ ===
const CONFIGS = {
  "https://quiz-cb.onrender.com": {
    GS_LEAD_URL: "https://script.google.com/macros/s/AKfycbw_3wTbgMxiY02mogtLV46mEfdI46y7VgMfISf-EZvnlMaMfUTshtkO8hHnlMrFQNKl/exec",
    GS_LOGS_URL: "https://script.google.com/macros/s/AKfycbzsbjIWAvLKDti36VwVKJNj8LEMuOnxVQiq0T-9Pup6ahPBCY5DQokj5RIhZeceHwY/exec",
    BITRIX_LEAD_URL: "https://b24-rlsdyj.bitrix24.ru/rest/6530/div0suxgif5x3lvu/crm.lead.add.json"
  },
  "https://boldova-k.ru": {
    GS_LEAD_URL: "https://script.google.com/macros/s/AKfycbzQYwZMCMPOB20k8bJmlQNLPV8qNCXGHgjBPkrFvNHj56iSzDc47btwB3Sw-JF1lwuB/exec",
    GS_LOGS_URL: "https://script.google.com/macros/s/AKfycbynpXNZG4UW3SFHa2Xvkdcjg4aS9XZH0nnV0eD2kHzHTzkuP6pBvpDE7C1fvbLdKCVc/exec",
    BITRIX_LEAD_URL: "#"
  }
};

function getConfig(origin) {
  return CONFIGS[origin] || CONFIGS["https://quiz-cb.onrender.com"];
}

// === ЭВРИСТИКИ АНТИБОТА ===
function calculateHeuristicScore(events, durationMs, phone, honeypot, behaviorData = {}) {
  let score = 100;
  const reasons = [];

  // 1. HONEYPOT - мгновенный бан
  if (honeypot && honeypot.trim() !== "") {
    return { score: 0, reasons: ["honeypot заполнен"] };
  }

  // 2. СКОРОСТЬ ПРОХОЖДЕНИЯ
  if (durationMs < QUIZ_MIN_DURATION_MS) {
    score -= 50;
    reasons.push(`неестественно быстро: ${durationMs}ms`);
  }

  // 3. СРЕДНИЙ ИНТЕРВАЛ КЛИКОВ
  const intervals = events.map(e => Math.max(0, e.intervalMs || 0));
  const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 9999;
  
  if (avgInterval < QUIZ_MIN_AVG_INTERVAL_MS) {
    score -= 40;
    reasons.push(`роботизированные интервалы: ${Math.round(avgInterval)}ms`);
  }

  // 4. PASTE В ПОЛЯХ
  const pasteCount = events.filter(e => e.type === "paste").length;
  if (pasteCount > 0) {
    score -= (pasteCount * 20);
    reasons.push(`вставка данных: ${pasteCount} раз`);
  }

  // 5. ВАЛИДАЦИЯ ТЕЛЕФОНА
  const phoneRegex = /^\+7[0-9]{10}$/;
  if (!phoneRegex.test(phone)) {
    score -= 25;
    reasons.push("невалидный телефон");
  }

  return { 
    score: Math.max(0, Math.min(100, score)), 
    reasons 
  };
}

// === GIGACHAT АНАЛИЗ ===
async function analyzeWithGigaChat(events, answers, phone, durationMs, honeypot, behaviorData = {}) {
  try {
    const userContent = `answers:
${Object.entries(answers).map(([q,a]) => `${q}: ${a}`).join("\n")}
events:
${events.map(e => `${e.type}|${e.label}|${e.intervalMs}`).join("\n")}
duration: ${durationMs}
avgInterval: ${events.length ? events.reduce((sum, e) => sum + (e.intervalMs || 0), 0) / events.length : 0}
honeypot: ${!!honeypot}
phone: ${phone}
mouseMovements: ${behaviorData.mouseMovements ? behaviorData.mouseMovements.length : 0}
questionTimings: ${behaviorData.questionTimings ? JSON.stringify(behaviorData.questionTimings) : 'none'}
clickPositions: ${behaviorData.clickPositions ? behaviorData.clickPositions.length : 0}`;

    const accessToken = await getGigaChatToken();
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const gigachatResponse = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${accessToken}`, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        model: GIGACHAT_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT_ANTIBOT },
          { role: "user", content: userContent }
        ],
        temperature: 0.1,
        max_tokens: 500
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!gigachatResponse.ok) {
      const errorData = await gigachatResponse.json();
      throw new Error(`GigaChat error: ${errorData.message || gigachatResponse.status}`);
    }

    const data = await gigachatResponse.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) throw new Error("Пустой ответ от GigaChat");
    
    const result = JSON.parse(content);
    
    if (typeof result.score !== 'number' || !result.action || !result.reason) {
      throw new Error("Неверный формат ответа от GigaChat");
    }
    
    return result;

  } catch (error) {
    console.warn("❌ GigaChat анализ не сработал:", error.message);
    return null;
  }
}

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===
function isBlacklisted(phone, ip, ua) {
  if (BLACKLIST_PHONES.some(p => phone?.startsWith(p))) return true;
  if (BLACKLIST_IPS.some(i => ip === i)) return true;
  if (BLACKLIST_UA.some(u => ua?.toLowerCase().includes(u.toLowerCase()))) return true;
  return false;
}

function getActionByScore(score) {
  if (score < QUIZ_DENY_THRESHOLD) return "deny";
  if (score >= QUIZ_ALLOW_THRESHOLD) return "allow";
  return "challenge";
}

// === ОСНОВНОЙ ЭНДПОИНТ /quiz ===
app.post("/quiz", async (req, res) => {
  const origin = req.headers.origin;
  const { GS_LEAD_URL, GS_LOGS_URL, BITRIX_LEAD_URL } = getConfig(origin);

  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    const ua = req.headers["user-agent"] || "";
    const { 
      userId = "unknown", 
      events = [], 
      answers = {}, 
      phone = "", 
      honeypot = "",
      durationMs = 0,
      frontend = "unknown"
    } = req.body;

    // === ЧЕРНЫЕ СПИСКИ ===
    if (isBlacklisted(phone, ip, ua)) {
      return res.json({ score: 0, action: "deny", reason: "blacklisted" });
    }

    const heuristic = calculateHeuristicScore(events, durationMs, phone, honeypot, req.body.behaviorData || {});

    // Если хонипот заполнен - мгновенный deny
    if (heuristic.score === 0 && heuristic.reasons.includes("honeypot заполнен")) {
      return res.json({ score: 0, action: "deny", reason: "honeypot" });
    }

    // === GIGACHAT-КЛАССИФИКАТОР ===
    let gigaScore = null;
    let gigaAction = null; 
    let gigaReason = null;

    try {
      const gigaResult = await analyzeWithGigaChat(events, answers, phone, durationMs, honeypot, req.body.behaviorData);
      if (gigaResult) {
        gigaScore = gigaResult.score;
        gigaAction = gigaResult.action;
        gigaReason = gigaResult.reason;
      }
    } catch (gigaError) {
      console.warn("⚠️ GigaChat классификатор недоступен:", gigaError.message);
    }

    // Используем GigaChat результат если он есть, иначе эвристики
    const finalScore = gigaScore !== null ? gigaScore : heuristic.score;
    const finalAction = gigaAction !== null ? gigaAction : getActionByScore(heuristic.score);
    const finalReason = gigaReason !== null ? gigaReason : heuristic.reasons.join(", ");

    // === ЛОГИРОВАНИЕ ===
    await logQuizResult(userId, finalScore, finalAction, finalReason, phone, ip, ua, answers, GS_LOGS_URL, frontend);

    // === ОТПРАВКА ЛИДОВ (только allow и challenge) ===
    if (finalAction === "challenge" || finalAction === "allow") {
      const commentText = `Антибот статус: ${finalAction.toUpperCase()} (${finalReason})`;

      // Отправляем в Google Sheets
      await fetch(GS_LEAD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: answers.name || "Не указано",
          phone,
          userId,
          comment: commentText,
          source: "quiz"
        })
      }).catch(err => console.warn("⚠️ GS lead error:", err.message));

      // Отправляем в Bitrix
      if (BITRIX_LEAD_URL !== "#") {
        await fetch(BITRIX_LEAD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: {
              NAME: answers.name || "Не указано",
              PHONE: [{ VALUE: phone, VALUE_TYPE: "WORK" }],
              COMMENTS: commentText,
              SOURCE_ID: "QUIZ"
            }
          })
        }).catch(err => console.warn("⚠️ Bitrix error:", err.message));
      }
    }

    // === ОТВЕТ ===
    res.json({ 
      score: finalScore, 
      action: finalAction, 
      reason: finalReason 
    });

  } catch (err) {
    console.error("❌ QUIZ error:", err);
    res.status(500).json({ error: "quiz server error" });
  }
});

async function logQuizResult(userId, score, action, reason, phone, ip, ua, answers, GS_LOGS_URL, origin) {
  const answersSummary = Object.entries(answers).map(([q,a]) => `${q}: ${a}`).join("; ");
  
  await fetch(GS_LOGS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "quiz",
      userId,
      score,
      action, 
      reason,
      phone,
      ip,
      ua,
      answers: answersSummary,
      timestamp: new Date().toISOString()
    })
  }).catch(err => console.warn("⚠️ Quiz log error:", err.message));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ ANTIBOT GigaChat server запущен на порту", PORT);
});
