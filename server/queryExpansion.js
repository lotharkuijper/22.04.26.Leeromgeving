// Statische uitbreidingen voor korte Nederlandse en Engelse vaktermen.
// Doel: een korte zoekterm zoals "cohort" omzetten naar een rijkere zoekstring
// zodat het embedding-model meer signaal krijgt om het juiste cursusmateriaal te vinden.
//
// De map bevat lowercase keys; matching is case-insensitive en spatiegevoelig.
// Houd termen kort en specifiek voor epidemiologie/biostatistiek.
export const QUERY_SYNONYMS_NL = {
  // Epidemiologie — onderzoeksdesigns
  'cohort': 'groep onderzoekspopulatie deelnemers patiënten klas jaargang',
  'cohortonderzoek': 'cohort prospectief onderzoek follow-up vergelijkende studie blootstelling',
  'cohortstudie': 'cohort prospectief onderzoek follow-up vergelijkende studie blootstelling',
  'patient-controle onderzoek': 'case-control retrospectief vergelijkend cases controles',
  'patiënt-controle onderzoek': 'case-control retrospectief vergelijkend cases controles',
  'case-control': 'patiënt-controle retrospectief vergelijkend cases controles',
  'cross-sectioneel onderzoek': 'dwarsdoorsnede prevalentie momentopname survey',
  'gerandomiseerd gecontroleerd onderzoek': 'rct trial randomisatie experimenteel interventie',
  'rct': 'gerandomiseerd gecontroleerd trial randomisatie experimenteel interventie',
  'ecologisch onderzoek': 'aggregaat populatieniveau correlatie groepsgegevens',
  'case report': 'casusbeschrijving patiëntcasus klinisch verslag',

  // Epidemiologie — maten
  'incidentie': 'aantal nieuwe gevallen risico optreden ziekte tijdsperiode',
  'incidentiedichtheid': 'incidence rate persoonjaren nieuwe gevallen tijd',
  'prevalentie': 'aantal aanwezig gevallen voorkomen populatie moment',
  'puntprevalentie': 'prevalentie moment dwarsdoorsnede',
  'relatief risico': 'rr ratio vergelijking blootgesteld niet-blootgesteld',
  'odds ratio': 'or kansverhouding case-control patiënt-controle',
  'attributief risico': 'verschil in risico blootstelling causaal absoluut',
  'number needed to treat': 'nnt aantal te behandelen interventie effect',

  // Epidemiologie — bias en causaliteit
  'confounding': 'verstoring vertekening derde variabele gemeenschappelijke oorzaak',
  'confounder': 'verstorende variabele gemeenschappelijke oorzaak',
  'effect modification': 'interactie effectmodificatie subgroepverschil',
  'effectmodificatie': 'interactie effect modification subgroepverschil',
  'mediatie': 'tussenliggende variabele indirect effect mechanisme',
  'selectiebias': 'selectievertekening selectie deelname respons',
  'informatiebias': 'meetfout misclassificatie informatie',
  'misclassificatie': 'meetfout informatiebias verkeerd ingedeeld',
  'dag': 'gerichte acyclische graaf causaal diagram pad',

  // Diagnostiek en screening
  'sensitiviteit': 'gevoeligheid testkenmerk werkelijk positief',
  'specificiteit': 'testkenmerk werkelijk negatief uitsluiting',
  'positief voorspellende waarde': 'ppv voorspelling positief test',
  'negatief voorspellende waarde': 'npv voorspelling negatief test',
  'screening': 'opsporing test vroege detectie populatie',
  'surveillance': 'monitoring bewaking volgsysteem ziekte',

  // Biostatistiek — beschrijvend
  'gemiddelde': 'mean centrale maat statistiek',
  'mediaan': 'middelste waarde centrale maat percentiel',
  'modus': 'meest voorkomende waarde centrale maat',
  'standaarddeviatie': 'sd spreiding variabiliteit afwijking',
  'variantie': 'spreiding kwadratische afwijking',
  'kwartiel': 'percentiel kwartielafstand spreiding',
  'interkwartielafstand': 'iqr spreiding kwartiel',

  // Biostatistiek — verdelingen
  'normaalverdeling': 'gauss kromme klokvorm verdeling',
  'binomiale verdeling': 'binomiaal succes kans aantal',
  'poisson-verdeling': 'poisson zeldzame gebeurtenissen telling',

  // Biostatistiek — toetsen en intervallen
  'betrouwbaarheidsinterval': 'ci confidence interval onzekerheid bereik',
  'p-waarde': 'p-value significantie hypothesetoets toetsingsuitslag',
  'nulhypothese': 'h0 hypothese statistische toets geen effect',
  'alternatieve hypothese': 'h1 hypothese effect verschil',
  't-toets': 't-test gemiddelden vergelijken',
  'chi-kwadraattoets': 'chi-square chi² categorisch verband',
  'anova': 'variantieanalyse meerdere groepen vergelijken',

  // Biostatistiek — modellen en survival
  'regressieanalyse': 'regressie lineair model verband variabelen voorspelling',
  'lineaire regressie': 'regressie lineair model continue uitkomst',
  'logistische regressie': 'logistic regression binair uitkomst kansen odds',
  'multilevel model': 'hiërarchisch model geneste data random effect',
  'kaplan-meier': 'overleving survival curve censoring follow-up',
  'log-rank toets': 'survival overleving groepen vergelijken censoring',
  'hazard ratio': 'hr verhouding risico tijd survival',
  'cox-regressie': 'proportional hazards survival overleving regressie',

  // Biostatistiek — onderzoeksopzet en fouten
  'steekproefomvang': 'sample size n aantal deelnemers berekening',
  'power': 'onderscheidingsvermogen statistisch detectievermogen sample size',
  'type i fout': 'fout-positief alfa significantie ten onrechte verwerpen',
  'type ii fout': 'fout-negatief beta gemist effect',
  'effectgrootte': 'effect size cohen d standaardisatie',
  'multiple testing': 'meervoudig toetsen bonferroni fdr correctie',
};

// English synonym map — maps English epidemiology/biostatistics terms to related terms.
export const QUERY_SYNONYMS_EN = {
  // Epidemiology — study designs
  'cohort': 'group study population participants patients follow-up',
  'cohort study': 'prospective longitudinal follow-up exposure outcome',
  'case-control': 'case control retrospective comparison cases controls odds',
  'cross-sectional': 'prevalence survey snapshot population moment',
  'randomized controlled trial': 'rct randomization experimental intervention control',
  'rct': 'randomized controlled trial randomization experimental intervention',
  'ecological study': 'aggregate population-level correlation group data',
  'case report': 'case description patient clinical report',

  // Epidemiology — measures
  'incidence': 'new cases risk occurrence disease time period rate',
  'incidence rate': 'incidence density person-years new cases time',
  'prevalence': 'existing cases proportion population moment',
  'relative risk': 'rr risk ratio comparison exposed unexposed',
  'odds ratio': 'or odds case-control association',
  'attributable risk': 'risk difference exposure causal absolute',
  'number needed to treat': 'nnt treatment effect intervention',

  // Epidemiology — bias and causality
  'confounding': 'confounder bias third variable common cause',
  'confounder': 'confounding variable common cause spurious',
  'effect modification': 'interaction subgroup heterogeneity',
  'mediation': 'mediator indirect effect mechanism pathway',
  'selection bias': 'selection distortion participation response',
  'information bias': 'measurement error misclassification',
  'dag': 'directed acyclic graph causal diagram path',

  // Diagnostics and screening
  'sensitivity': 'true positive rate test property detection',
  'specificity': 'true negative rate test property exclusion',
  'positive predictive value': 'ppv prediction positive test',
  'negative predictive value': 'npv prediction negative test',
  'screening': 'detection early test population',
  'surveillance': 'monitoring tracking disease system',

  // Biostatistics — descriptive
  'mean': 'average central tendency measure statistics',
  'median': 'middle value central tendency percentile',
  'mode': 'most frequent value central tendency',
  'standard deviation': 'sd spread variability dispersion',
  'variance': 'spread squared deviation dispersion',
  'quartile': 'percentile interquartile spread',
  'interquartile range': 'iqr spread quartile',

  // Biostatistics — distributions
  'normal distribution': 'gaussian bell curve distribution',
  'binomial distribution': 'binomial success probability count',
  'poisson distribution': 'poisson rare events count',

  // Biostatistics — tests and intervals
  'confidence interval': 'ci uncertainty range estimate',
  'p-value': 'significance hypothesis test result',
  'null hypothesis': 'h0 no effect statistical test',
  'alternative hypothesis': 'h1 effect difference',
  't-test': 't-test means comparison groups',
  'chi-square test': 'chi-square categorical association',
  'anova': 'analysis of variance multiple groups comparison',

  // Biostatistics — models and survival
  'regression analysis': 'regression model association variables prediction',
  'linear regression': 'regression linear model continuous outcome',
  'logistic regression': 'logistic regression binary outcome odds',
  'multilevel model': 'hierarchical model nested data random effect',
  'kaplan-meier': 'survival curve censoring follow-up',
  'log-rank test': 'survival groups comparison censoring',
  'hazard ratio': 'hr risk time survival',
  'cox regression': 'proportional hazards survival regression',

  // Biostatistics — study design and errors
  'sample size': 'n participants calculation power',
  'power': 'statistical power detection sample size',
  'type i error': 'false positive alpha significance',
  'type ii error': 'false negative beta missed effect',
  'effect size': 'cohen d standardized difference',
  'multiple testing': 'bonferroni fdr correction',
};

// Backwards compat: keep old export name pointing to Dutch map
export const QUERY_SYNONYMS = QUERY_SYNONYMS_NL;

// Bouwt een verrijkte zoekstring rond `term`. De originele term blijft als
// belangrijkste signaal bovenaan; daarna voegen we (in deze volgorde) toe:
//   1. Statische synoniemen uit de taalspecifieke synonymenmap
//   2. key_points van het concept (gefilterd op metadata-tags zoals "[RAG-…]")
//   3. De eerste ~200 tekens van de definition
// Resultaat is gededupliceerd op woordniveau zodat het embedding-model
// niet onnodig op herhaalde tokens hoeft te focussen.
export function expandQuery(term, options, lang) {
  const opts = options || {};
  const useLang = lang === 'en' ? 'en' : 'nl';
  const synonymMap = useLang === 'en' ? QUERY_SYNONYMS_EN : QUERY_SYNONYMS_NL;
  const baseTerm = String(term || '').trim();
  if (!baseTerm) return '';

  const parts = [baseTerm];
  const key = baseTerm.toLowerCase();
  if (synonymMap[key]) parts.push(synonymMap[key]);

  if (Array.isArray(opts.keyPoints)) {
    const filtered = opts.keyPoints
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('['));
    if (filtered.length > 0) parts.push(filtered.join(' '));
  }

  if (typeof opts.definition === 'string' && opts.definition.trim()) {
    const def = opts.definition.replace(/\s+/g, ' ').trim().slice(0, 200);
    parts.push(def);
  }

  const seen = new Set();
  const tokens = [];
  for (const part of parts) {
    for (const raw of part.split(/\s+/)) {
      const token = raw.trim();
      if (!token) continue;
      const lower = token.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      tokens.push(token);
    }
  }
  return tokens.join(' ');
}
