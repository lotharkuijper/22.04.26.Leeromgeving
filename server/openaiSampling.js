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
