// Pure helper rond OpenAI sampling-parameters, los van server/index.js zodat
// hij in tests geïmporteerd kan worden zonder de hele Express-app te starten.

// Sommige reasoning-modellen (o1/o3/o4 en bepaalde gpt-5-varianten) accepteren
// alleen de standaard 'temperature'/'top_p' en weigeren een aangepaste waarde
// met een 400. Detecteer die specifieke fout zodat de aanroeper het verzoek
// één keer opnieuw kan doen zonder die sampling-parameters in plaats van te
// falen met "het taalmodel weigerde het verzoek".
export function isUnsupportedSamplingParamError(data) {
  const err = data && data.error;
  if (!err) return false;
  const param = (err.param || '').toLowerCase();
  if (param === 'temperature' || param === 'top_p') return true;
  const msg = (err.message || '').toLowerCase();
  return (
    (msg.includes('temperature') || msg.includes('top_p')) &&
    (msg.includes('unsupported') ||
      msg.includes('does not support') ||
      msg.includes('only the default') ||
      msg.includes('not supported'))
  );
}

// Reasoning-modellen (gpt-5/o1/o3/o4) verbruiken hun tokenbudget deels aan
// 'reasoning'. Bij een zware, gestructureerde opdracht kan een chat-completion
// daardoor een HTTP 200 met lege of afgekapte content opleveren
// (finish_reason: "length"). Detecteer dat zodat de aanroeper één keer opnieuw
// kan proberen met een ruimer budget i.p.v. een misleidende lege 200 door te
// geven. Een succesvolle respons met echte tekst en finish_reason "stop"
// levert hier false op.
export function isEmptyOrTruncatedCompletion(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (!choice) return true;
  const content = choice.message && choice.message.content;
  if (!content || !String(content).trim()) return true;
  if (choice.finish_reason === 'length') return true;
  return false;
}

// Gedeelde helper voor álle chat-completion-aanroepen (quiz, beoordeling,
// project-evaluatie, samenvattingen, …). Doet de POST en, wanneer het model een
// aangepaste temperature/top_p weigert met een 400, probeert het verzoek één
// keer opnieuw zonder die sampling-parameters. response_format, token-limieten
// en alle overige velden blijven ongemoeid. De auth-headers worden door de
// aanroeper meegegeven (Azure 'api-key' of OpenAI 'Authorization: Bearer'),
// zodat dezelfde helper voor zowel Azure als publieke OpenAI werkt.
//
// Geeft een Response-achtig object terug ({ ok, status, json(), text() }) zodat
// bestaande aanroepers — die `.ok`, `.status`, `await resp.json()` of
// `await resp.text()` gebruiken — vrijwel ongewijzigd kunnen blijven. De body
// wordt intern al gelezen; json()/text() leveren de gecachte waarde.
export async function postChatCompletionWithRetry({ url, headers, body, fetchImpl = fetch }) {
  const doFetch = async (b) => {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(b),
    });
    const rawText = await r.text();
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }
    return { r, rawText, parsed };
  };

  let { r, rawText, parsed } = await doFetch(body);

  if (!r.ok && r.status === 400 && isUnsupportedSamplingParamError(parsed)) {
    const { temperature: _t, top_p: _tp, ...retryBody } = body;
    console.warn(
      `[openai] Model ${body && body.model} accepteert geen aangepaste temperature/top_p — opnieuw zonder die parameters.`,
    );
    ({ r, rawText, parsed } = await doFetch(retryBody));
  }

  return {
    ok: r.ok,
    status: r.status,
    json: async () => parsed,
    text: async () => rawText,
  };
}
