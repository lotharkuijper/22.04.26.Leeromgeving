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
