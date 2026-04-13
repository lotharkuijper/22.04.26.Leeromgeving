/*
  # Seed Data voor Begrippen

  ## Overview
  Dit voegt voorbeeldconcepten toe voor epidemiologie en biostatistiek
  voor gebruik in de "Ik Leg Uit" module.

  ## Seed Data
  - 15 epidemiologie begrippen
  - 15 biostatistiek begrippen
  - Inclusief definities en kernpunten
*/

-- Insert epidemiologie concepten
INSERT INTO concepts (name, category, definition, key_points, examples) VALUES
  (
    'Confounding',
    'epidemiologie',
    'Een verstorende variabele die zowel geassocieerd is met de exposure als met de outcome, en niet op het causale pad ligt tussen beiden.',
    ARRAY['Associatie met exposure', 'Associatie met outcome', 'Niet op causaal pad', 'Kan leiden tot vertekening'],
    ARRAY['Leeftijd als confounder bij relatie tussen koffiedrinken en hartziekte', 'Roken als confounder bij alcohol en longkanker']
  ),
  (
    'Incidentie',
    'epidemiologie',
    'Het aantal nieuwe gevallen van een ziekte binnen een bepaalde populatie gedurende een specifieke periode.',
    ARRAY['Nieuwe gevallen', 'Tijdseenheid belangrijk', 'Maat voor risico', 'Teller: nieuwe gevallen, noemer: personen at risk'],
    ARRAY['50 nieuwe diabetes gevallen per 1000 personen per jaar', 'Incidentie van COVID-19 in Nederland']
  ),
  (
    'Prevalentie',
    'epidemiologie',
    'Het aantal bestaande gevallen van een ziekte op een bepaald moment of tijdens een bepaalde periode in een populatie.',
    ARRAY['Bestaande gevallen', 'Puntprevalentie vs periodeprevalentie', 'Maat voor ziektelast', 'Wordt beïnvloed door incidentie en duur'],
    ARRAY['15% van volwassenen heeft hypertensie', 'Prevalentie van diabetes in Nederland']
  ),
  (
    'Relatief Risico',
    'epidemiologie',
    'De verhouding tussen het risico op een outcome in de exposed groep versus het risico in de non-exposed groep.',
    ARRAY['RR = 1: geen associatie', 'RR > 1: verhoogd risico', 'RR < 1: verlaagd risico', 'Alleen in cohort studies'],
    ARRAY['RR = 2.0 betekent 2x zo groot risico bij geëxposeerden', 'Rokers hebben RR = 15 voor longkanker']
  ),
  (
    'Odds Ratio',
    'epidemiologie',
    'De verhouding van de odds van de outcome in de exposed groep versus de odds in de non-exposed groep.',
    ARRAY['Gebruikt in case-control studies', 'Benadert RR bij zeldzame outcomes', 'OR = 1: geen associatie', 'OR is symmetrisch'],
    ARRAY['OR = 3.0 bij zeldzame ziekte benadert RR van 3.0', 'Case-control studie naar risicofactoren voor zeldzame kanker']
  ),
  (
    'Selection Bias',
    'epidemiologie',
    'Vertekening door systematische verschillen tussen degenen die in de studie worden geïncludeerd en degenen die worden geëxcludeerd.',
    ARRAY['Ontstaat bij selectie van participanten', 'Beïnvloedt externe validiteit', 'Kan leiden tot verkeerde conclusies', 'Moeilijk te corrigeren na data collectie'],
    ARRAY['Healthy worker effect', 'Non-response bias in enquêtes', 'Berkson bias']
  ),
  (
    'Information Bias',
    'epidemiologie',
    'Vertekening door systematische fouten in de meting of classificatie van exposure, outcome, of andere variabelen.',
    ARRAY['Meetfouten', 'Recall bias', 'Observer bias', 'Misclassificatie'],
    ARRAY['Patiënten herinneren zich exposure beter na diagnose', 'Interviewer weet case/control status']
  ),
  (
    'Cohort Studie',
    'epidemiologie',
    'Een observationele studie waarbij een groep personen (cohort) in de tijd wordt gevolgd om te zien wie een bepaalde outcome ontwikkelt.',
    ARRAY['Prospectief of retrospectief', 'Start met exposure, meet outcome later', 'Kan incidentie berekenen', 'Kan meerdere outcomes bestuderen'],
    ARRAY['Framingham Heart Study', 'Nurses Health Study']
  ),
  (
    'Case-Control Studie',
    'epidemiologie',
    'Een observationele studie die begint met het identificeren van cases (met de outcome) en controls (zonder de outcome), en vervolgens kijkt naar eerdere exposures.',
    ARRAY['Retrospectief', 'Efficiënt voor zeldzame outcomes', 'Kan geen incidentie berekenen', 'Gevoelig voor bias'],
    ARRAY['Studie naar risicofactoren voor zeldzame kanker', 'Case-control studie naar oorzaken van geboorteafwijking']
  ),
  (
    'Sensitiviteit',
    'epidemiologie',
    'Het vermogen van een test om personen met de ziekte correct te identificeren (true positive rate).',
    ARRAY['True positives / (true positives + false negatives)', 'Hoog bij goede detectie van zieken', 'Trade-off met specificiteit'],
    ARRAY['95% sensitiviteit betekent 5% false negatives', 'HIV test met hoge sensitiviteit']
  ),
  (
    'Specificiteit',
    'epidemiologie',
    'Het vermogen van een test om personen zonder de ziekte correct te identificeren (true negative rate).',
    ARRAY['True negatives / (true negatives + false positives)', 'Hoog bij weinig false positives', 'Trade-off met sensitiviteit'],
    ARRAY['98% specificiteit betekent 2% false positives', 'Confirmatie test met hoge specificiteit']
  ),
  (
    'Positief Voorspellende Waarde',
    'epidemiologie',
    'De kans dat iemand met een positieve testuitslag daadwerkelijk de ziekte heeft.',
    ARRAY['Afhankelijk van prevalentie', 'True positives / (true positives + false positives)', 'Belangrijk voor klinische besluitvorming'],
    ARRAY['PPV van 80% betekent 20% false positives', 'Lagere PPV bij lage prevalentie']
  ),
  (
    'Attributable Risk',
    'epidemiologie',
    'Het verschil in incidentie tussen exposed en non-exposed groepen; het extra risico toe te schrijven aan de exposure.',
    ARRAY['AR = Incidentie exposed - Incidentie non-exposed', 'Absolute maat', 'Belangrijk voor public health impact', 'Kan negatief zijn (protectief effect)'],
    ARRAY['Extra gevallen toe te schrijven aan roken', 'Preventeerbare gevallen bij eliminatie exposure']
  ),
  (
    'Effect Modificatie',
    'epidemiologie',
    'Het effect van een exposure op een outcome verschilt tussen verschillende niveaus van een derde variabele.',
    ARRAY['Ook wel interactie genoemd', 'Biologisch fenomeen', 'Niet hetzelfde als confounding', 'Vereist stratificatie of interactie term'],
    ARRAY['Effect van medicijn verschilt tussen mannen en vrouwen', 'Leeftijd modificeert effect van vaccinatie']
  ),
  (
    'Causaliteit',
    'epidemiologie',
    'Een oorzakelijk verband tussen een exposure en een outcome, waarbij de exposure daadwerkelijk de outcome veroorzaakt.',
    ARRAY['Bradford Hill criteria', 'Temporaliteit cruciaal', 'Associatie is niet hetzelfde als causaliteit', 'Requires multiple lines of evidence'],
    ARRAY['Roken veroorzaakt longkanker', 'HPV veroorzaakt cervixkanker']
  )
ON CONFLICT (name) DO NOTHING;

-- Insert biostatistiek concepten
INSERT INTO concepts (name, category, definition, key_points, examples) VALUES
  (
    'P-waarde',
    'biostatistiek',
    'De kans op het observeren van de gevonden resultaten (of extremer) onder de aanname dat de nulhypothese waar is.',
    ARRAY['Conditionele kans', 'p < 0.05 vaak als grens', 'Niet de kans dat H0 waar is', 'Beïnvloed door sample size'],
    ARRAY['p = 0.03 betekent 3% kans op deze resultaten als H0 waar is', 'Kleine p-waarde suggereert bewijs tegen H0']
  ),
  (
    'Betrouwbaarheidsinterval',
    'biostatistiek',
    'Een range van waarden die met een bepaald niveau van zekerheid (meestal 95%) de ware populatieparameter bevat.',
    ARRAY['95% CI betekent niet 95% kans dat ware waarde erin ligt', 'Bredere CI bij kleinere sample', 'Narrower CI bij meer data', 'Overlapping CI suggereert geen significant verschil'],
    ARRAY['95% CI: 1.5 - 3.2', 'OR 2.1 (95% CI: 1.3 - 3.4)']
  ),
  (
    'Type I Fout',
    'biostatistiek',
    'Het ten onrechte verwerpen van een ware nulhypothese (false positive).',
    ARRAY['Alpha (α) niveau', 'Meestal 0.05', 'Verhoogt bij multiple testing', 'Controle door Bonferroni correctie'],
    ARRAY['Concluderen dat medicijn werkt terwijl dit niet zo is', 'False positive testresultaat']
  ),
  (
    'Type II Fout',
    'biostatistiek',
    'Het ten onrechte niet verwerpen van een valse nulhypothese (false negative).',
    ARRAY['Beta (β) niveau', 'Power = 1 - β', 'Verhoogt bij kleine sample size', 'Vermindert met grotere effectgrootte'],
    ARRAY['Concluderen dat medicijn niet werkt terwijl dit wel zo is', 'Missen van echt effect']
  ),
  (
    'Power',
    'biostatistiek',
    'De kans om een echt effect te detecteren als het bestaat; de kans om de nulhypothese correct te verwerpen.',
    ARRAY['Power = 1 - β', 'Meestal 0.80 of 0.90 gewenst', 'Verhoogt met sample size', 'Verhoogt met grotere effectgrootte'],
    ARRAY['Power van 80% betekent 80% kans op detectie echt effect', 'Sample size berekening gebaseerd op gewenste power']
  ),
  (
    'Regressie',
    'biostatistiek',
    'Een statistische methode om de relatie tussen een afhankelijke variabele en één of meer onafhankelijke variabelen te modelleren.',
    ARRAY['Lineaire regressie voor continue outcomes', 'Logistische regressie voor binaire outcomes', 'Cox regressie voor survival data', 'Controle voor confounders'],
    ARRAY['Effect van BMI op bloeddruk', 'Predictie van ziekterisico gebaseerd op meerdere factoren']
  ),
  (
    'Hazard Ratio',
    'biostatistiek',
    'De ratio van hazard rates tussen twee groepen; gebruikt in survival analyse.',
    ARRAY['HR = 1: geen verschil in hazard', 'HR > 1: verhoogd risico', 'HR < 1: verlaagd risico', 'Tijd-tot-event analyse'],
    ARRAY['HR = 0.7 betekent 30% reductie in hazard', 'Survival analyse in oncologie studies']
  ),
  (
    'ROC Curve',
    'biostatistiek',
    'Een grafiek die de trade-off tussen sensitiviteit en specificiteit laat zien voor verschillende cut-off waarden van een diagnostische test.',
    ARRAY['AUC = Area Under Curve', 'AUC = 0.5: geen discriminatie', 'AUC = 1.0: perfecte discriminatie', 'Gebruikt voor test evaluatie'],
    ARRAY['ROC curve voor biomarker', 'Optimale cut-off bepalen voor diagnose']
  ),
  (
    'Mediaan',
    'biostatistiek',
    'De middelste waarde in een geordende dataset; 50% van de waarden ligt eronder en 50% erboven.',
    ARRAY['Minder gevoelig voor outliers dan mean', 'Gebruikt bij scheve verdelingen', 'Maat voor centrale tendentie'],
    ARRAY['Mediaan inkomen', 'Mediaan overleving bij kanker']
  ),
  (
    'Standaarddeviatie',
    'biostatistiek',
    'Een maat voor de spreiding van data rond het gemiddelde.',
    ARRAY['SD = wortel van variantie', 'Zelfde eenheid als data', 'Bij normale verdeling: 68% binnen 1 SD', '95% binnen 2 SD'],
    ARRAY['Gemiddelde lengte 175 cm, SD 10 cm', 'Spreiding van bloeddruk metingen']
  ),
  (
    'Correlatie',
    'biostatistiek',
    'Een maat voor de lineaire samenhang tussen twee continue variabelen.',
    ARRAY['Pearson r: -1 tot +1', 'r = 0: geen lineaire samenhang', 'r = 1: perfecte positieve correlatie', 'Correlatie impliceert geen causaliteit'],
    ARRAY['Correlatie tussen lengte en gewicht', 'Correlatie tussen leeftijd en bloeddruk']
  ),
  (
    'Chi-kwadraat Test',
    'biostatistiek',
    'Een statistische test voor het analyseren van associaties tussen categorische variabelen.',
    ARRAY['Gebruikt voor contingency tables', 'Test of verdelingen verschillen', 'Vereist voldoende cel-aantallen', 'Non-parametrische test'],
    ARRAY['Associatie tussen geslacht en ziekte', 'Verschil in proportie tussen groepen']
  ),
  (
    'T-test',
    'biostatistiek',
    'Een statistische test voor het vergelijken van gemiddelden tussen twee groepen.',
    ARRAY['Paired vs unpaired', 'Assumptie: normale verdeling', 'Gelijke of ongelijke varianties', 'Alternative: non-parametrische test'],
    ARRAY['Vergelijken bloeddruk tussen behandel- en controlegroep', 'Voor-na meting bij dezelfde personen']
  ),
  (
    'ANOVA',
    'biostatistiek',
    'Analysis of Variance; een test voor het vergelijken van gemiddelden tussen drie of meer groepen.',
    ARRAY['Extensie van t-test', 'F-test', 'Post-hoc tests voor pairwise vergelijkingen', 'Assumptie: homogeniteit van variantie'],
    ARRAY['Vergelijken van drie behandelingen', 'Effect van verschillende doseringen']
  ),
  (
    'Intention-to-Treat',
    'biostatistiek',
    'Een analyseprincipe waarbij alle gerandomiseerde patiënten worden geanalyseerd in de groep waartoe ze oorspronkelijk werden toegewezen, ongeacht protocol adherentie.',
    ARRAY['Preserveert randomisatie', 'Conservatieve benadering', 'Real-world effectiveness', 'Omgaat met non-compliance'],
    ARRAY['Patiënt blijft in interventiegroep ook als ze medicatie stoppen', 'RCT analyse volgens randomisatie']
  )
ON CONFLICT (name) DO NOTHING;