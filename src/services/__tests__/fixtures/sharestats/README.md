# ShareStats fixtures

Echte `.Rmd`-bestanden uit https://github.com/ShareStats/itembank, gebruikt om
de R/exams-parser tegen authentieke formuleringen te testen. Eén bestand per
edge-case-familie (mchoice/schoice met `exsolution`-binaire-string,
schoice met aparte True/False-Answerlist, num met decimale-punt-zonder-nul,
string met lege `exsolution`, cloze met `|`-gescheiden oplossingen, enzovoort).

## Een nieuwe fixture toevoegen

1. Zoek het pad in https://github.com/ShareStats/itembank (bijv.
   `Distributions/eur-distributions-201-en/eur-distributions-201-en.Rmd`).
2. Download het ruwe bestand naar deze map met dezelfde bestandsnaam:

   ```bash
   curl -O https://raw.githubusercontent.com/ShareStats/itembank/main/<pad>/<bestand>.Rmd
   ```

3. Voeg een entry toe aan de `cases`-array in
   `src/services/__tests__/rmd-parser.fixtures.test.ts` met de verwachte
   waarden voor `extype`, antwoordopties en oplossing.
4. Draai `npx vitest run` om te bevestigen dat de parser de nieuwe fixture
   correct verwerkt.

Houd de set klein (5–10 bestanden): elk bestand dekt één edge-case-familie,
niet één concrete vraag.
