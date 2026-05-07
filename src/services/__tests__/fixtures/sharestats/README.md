# ShareStats fixtures

Echte `.Rmd`-bestanden uit https://github.com/ShareStats/itembank, gebruikt om
de R/exams-parser tegen authentieke formuleringen te testen. Eén bestand per
edge-case-familie (mchoice/schoice met `exsolution`-binaire-string,
schoice met aparte True/False-Answerlist, num met decimale-punt-zonder-nul,
string met lege `exsolution`, cloze met `|`-gescheiden oplossingen, enzovoort).

## Fixtures verversen vanaf de live repo

Het script `scripts/refresh-sharestats-fixtures.mjs` zoekt elk `.Rmd`-bestand
in deze map terug in de hoofdbranch van `ShareStats/itembank`, vergelijkt de
git-blob-SHA en haalt vernieuwde versies binnen.

```bash
# Alleen controleren (faalt met exit-code 1 bij verschillen of ontbrekende bestanden):
node scripts/refresh-sharestats-fixtures.mjs --check

# Lokaal bijwerken:
node scripts/refresh-sharestats-fixtures.mjs

# Optioneel: andere repo, branch of GitHub-token tegen rate limits.
SHARESTATS_OWNER=ShareStats SHARESTATS_REPO=itembank SHARESTATS_BRANCH=main \
  GITHUB_TOKEN=ghp_xxx node scripts/refresh-sharestats-fixtures.mjs --verbose
```

Draai daarna `npx vitest run src/services/__tests__/rmd-parser.fixtures.test.ts`
om te bevestigen dat de parser de bijgewerkte fixtures nog steeds correct
verwerkt. Verschilt iets, pas dan de bijbehorende verwachtingen in
`src/services/__tests__/rmd-parser.fixtures.test.ts` aan of repareer de parser.

> Tip: een maandelijkse CI-job kan `--check` draaien en bij exit-code ≠ 0 een
> issue openen. Dat is nog niet ingericht; het script is bewust zelfstandig
> uitvoerbaar zodat het in elke scheduler past.

## Een nieuwe fixture toevoegen

1. Zoek het pad in https://github.com/ShareStats/itembank (bijv.
   `Distributions/eur-distributions-201-en/eur-distributions-201-en.Rmd`).
2. Download het ruwe bestand naar deze map met dezelfde bestandsnaam:

   ```bash
   curl -O https://raw.githubusercontent.com/ShareStats/itembank/main/<pad>/<bestand>.Rmd
   ```

   Of voeg het bestand handmatig toe en draai vervolgens
   `node scripts/refresh-sharestats-fixtures.mjs` zodat de inhoud overeenkomt
   met de live versie.
3. Voeg een entry toe aan de `cases`-array in
   `src/services/__tests__/rmd-parser.fixtures.test.ts` met de verwachte
   waarden voor `extype`, antwoordopties en oplossing.
4. Draai `npx vitest run` om te bevestigen dat de parser de nieuwe fixture
   correct verwerkt.

Houd de set klein (5–10 bestanden): elk bestand dekt één edge-case-familie,
niet één concrete vraag.
