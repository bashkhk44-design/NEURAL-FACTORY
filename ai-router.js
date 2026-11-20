'use strict';

const FREE_GEMINI_MODELS = new Set(['gemini-3.8-flash']);

function getGeminiModel() {
  const requested = process.env.GEMINI_MODEL || process.env.GEMINI_FREE_MODEL || 'gemini-3.8-flash';
  return FREE_GEMINI_MODELS.has(requested) ? requested : 'gemini-3.8-flash';
}

function providers() {
  const list = [];

  // Gemini is the primary provider. Alternative providers are strictly opt-in.
  if (process.env.GEMINI_API_KEY) {
    list.push({
      id: 'gemini',
      key: process.env.GEMINI_API_KEY,
      model: getGeminiModel()
    });
  }

  if (process.env.AI_ENABLE_GROQ_FREE === 'true' && process.env.GROQ_API_KEY) {
    list.push({ id: 'groq', key: process.env.GROQ_API_KEY, model: 'openai/gpt-oss-120b' });
  }

  if (process.env.AI_ENABLE_OPENROUTER === 'true' && process.env.OPENROUTER_API_KEY) {
    list.push({ id: 'openrouter', key: process.env.OPENROUTER_API_KEY, model: 'openrouter/free' });
  }

  return list;
}

function messageOf(error) {
  return String(error && (error.message || error) || 'Unknown AI error');
}

async function callGemini(provider, systemInstruction, input, timeoutMs) {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: provider.key });
  const response = await ai.interactions.create(
    { model: provider.model, input, system_instruction: systemInstruction },
    { timeout_ms: timeoutMs }
  );

  if (!response.output_text || !response.output_text.trim()) {
    throw new Error('Gemini returned an empty response.');
  }

  return {
    text: response.output_text,
    model: provider.model,
    interactionId: response.id || null
  };
}

async function callCompatible(provider, systemInstruction, input, timeoutMs) {
  const endpoint = provider.id === 'groq'
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      Authorization: 'Bearer ' + provider.key,
      'Content-Type': 'application/json'
    };

    if (provider.id === 'openrouter') {
      headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL || 'https://boss-whatsapp-bot.onrender.com';
      headers['X-Title'] = 'BOSS BOT MASTER';
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: input }
        ],
        temperature: 0.2,
        max_tokens: 12000
      })
    });

    const raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (_) {}

    if (!response.ok) {
      const error = new Error(
        (data.error && (data.error.message || data.error)) || ('HTTP ' + response.status)
      );
      error.status = response.status;
      throw error;
    }

    const choice = data.choices && data.choices[0];
    if (choice && choice.finish_reason === 'length') {
      throw new Error(provider.id + ' response reached its output limit.');
    }

    const output = choice && choice.message && choice.message.content;
    if (typeof output !== 'string' || !output.trim()) {
      throw new Error(provider.id + ' returned an empty response.');
    }

    return { text: output, model: provider.model, interactionId: null };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(provider.id + ' request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generateText({
  systemInstruction,
  input,
  stage = 'unknown',
  timeoutMs = 120000
}) {
  if (!systemInstruction || typeof input !== 'string') {
    throw new Error('AI Router requires a system instruction and text input.');
  }

  const available = providers();
  if (!available.length) {
    throw new Error('لا يوجد محرك AI مضبوط. أضف GEMINI_API_KEY في إعدادات الاستضافة.');
  }

  const failures = [];

  for (const provider of available) {
    try {
      console.log(
        'AI ROUTER: stage=' + stage +
        ' provider=' + provider.id +
        ' model=' + provider.model
      );

      const result = provider.id === 'gemini'
        ? await callGemini(provider, systemInstruction, input, timeoutMs)
        : await callCompatible(provider, systemInstruction, input, timeoutMs);

      console.log('AI ROUTER: stage=' + stage + ' completed by ' + provider.id);
      return { ...result, provider: provider.id, stage };
    } catch (error) {
      const detail = messageOf(error).slice(0, 450);
      failures.push(provider.id + ': ' + detail);
      console.error('AI ROUTER: ' + provider.id + ' failed: ' + detail);
    }
  }

  throw new Error(
    'تعذرت المهمة عبر محركات AI المفعّلة: ' + failures.join(' | ').slice(0, 1600)
  );
}

module.exports = { generateText, providers, getGeminiModel };
