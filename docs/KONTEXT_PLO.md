# KONTEXT – PLO klíčová slova na Rohlik.cz (POS Media)
Sdílený kontext projektu pro všechny členy týmu. Claude z něj vychází v každé konverzaci v projektu.
Stav k 10. 11. 2026. Aktuální verze: repo `isigno247/rohlik-spike`, soubor `docs/KONTEXT_PLO.md`.

## 1. O co jde
- Služba POS Media: doplnění klíčových slov do backendu Rohlik.cz, aby byl produkt vidět ve vyhledávání, organicky i v Search kampaních.
- Klíčová slova = reklamní inventář. Chybějící relevantní slovo znamená, že se produkt na dotaz vůbec nezobrazí, ani se zaplacenou kampaní. Je to blokátor kampaně a nejvyšší priorita každého auditu.
- I slabá organická pozice má hodnotu, když běží Search kampaň (produkt lze „vytopit“ na sponzorované pozice).
- Klient se ptá, jestli jsou doporučení podložená daty. Proto vždy měříme a ukazujeme metodiku.
- Pojem pro produktová data je „backend“ (ne PIM).

## 2. Ověřená fakta o platformě
- Rohlík při vyhledávání ignoruje diakritiku.
- Pořadí se mezi voláními liší, proto měříme 3× a bereme medián.
- `totalHits` = počet výsledků (nabídka), NE objem hledání. Klientům ho jako poptávku nikdy neuvádět.
- Objem hledaných dotazů dávají jen Rohlik Insights (tarif Master).
- Počet klíčových slov na SKU není omezený. Nahraná slova se ve vyhledávání projeví okamžitě.
- Výsledky se mezi sklady liší hlavně listingem, promo akcemi a novinkami. Měříme anonymně, vždy sklad Chrášťany (warehouseId 8791). Zóny: 1 Chrášťany, 2 Liboc, 3 Horní Počernice, 4 Brno, 5 Ostrava.
- Sponzorované produkty jsou spolehlivě označené. Podmínky Rohlíku automatizovaný sběr dat povolují.
- Zdroj tržeb „Search“ v Insights nezahrnuje sponzorované pozice.
- Ads Portal pracuje s ručně vybranými klíčovými slovy. Do aukce vstupuje vedle nabídky (bid) i relevance.
- Našeptávač dává jiné návrhy pro vložený celý dotaz a pro postupně psaný dotaz („černé pivo“ vs. „černé piv“).

## 3. Jak Rohlík řadí výsledky (test 10. 11. 2026)
- **Rozložení výsledků:** pozice 1 a 4 = reklama, pozice 6 = jedna vložená novinka (štítek „Novinka“, v datech `badge[].slug = "new"`), zbytek organicky. Slot novinky platil u 13 ze 14 dotazů s novinkou, výjimka „vánoční pivo“.
- **Novinka je ve výsledcích dvakrát:** na webu a pro přihlášené zákazníky se produkt ve slotu objeví ještě jednou na své skutečné organické pozici (např. Budvar 0,0 na #6 a #235). Boost je obrovský, ale trvá jen po dobu štítku.
- **Anonymní API ukazuje jen vložený výskyt.** Skutečnou organickou pozici novinky ve slotu nebo produktu v reklamě anonymní měření nezjistí. API občas vrátí o 1 produkt víc, než je limit.
- **Vyprodané produkty řadí API vždy úplně na konec** (15 z 15 dotazů). Naše SKU vyprodané = propad pozice, který nesouvisí s klíčovými slovy. Konkurence nad námi vyprodaná = posuneme se nahoru.
- **Personalizace:** přihlášený zákazník vidí jiné pořadí (jiná reklama, jiná novinka ve slotu). Měříme proto vždy anonymně s pevným skladem.
- **Pravděpodobně Google Retail Search:** odpovědi obsahují `attributionToken` a `searchMethod`. Takový systém řadí i podle chování zákazníků (prodeje, kliky, košík). Je to pravděpodobné, ale nedokázané. Slevy korelují s lepší pozicí, nejspíš přes vyšší prodeje.
- **Redesign z listopadu 2026:** vyhledávání se otevírá jako překryv přes celou stránku. Obsahuje „Produkt týdne“ (sponzorovaný), bannery, 20 produktů z našeptávače a AI asistenta. Stránka výsledků je `/hledat?q=<dotaz>&companyId=1` a odpovídá API pro přihlášené. Návrhy klíčových slov z našeptávače se nezměnily.

**Na co máme vliv:**

| Typ vlivu | Páky |
|---|---|
| Přímý | klíčová slova, název a obsah produktu, dostupnost skladem, načasování launche (slova nasadit dřív, než skončí štítek novinky) |
| Nepřímý | slevy a promo |
| Koupený | reklama na pozicích 1 a 4 |
| Žádný | váhy algoritmu, personalizace, konkurence |

**Argument pro klienty:** klíčová slova musí být nasazená už při launchi. Po skončení štítku novinky spadne produkt na svou skutečnou organickou pozici.

## 4. Metodika (v3)
- Každá analýza SKU začíná auditem současných klíčových slov.
- Průběh: audit → sběr kandidátů z našeptávače → měření (anonymně, 3 průchody, medián) → doporučení (30–60 slov/SKU) → XLSX pro listing tým + klientský deck + baseline → kontrola za 2–3 dny, pak každé 3 týdny.
- Stavy klíčových slov: FUNGUJE / DRŽÍ ROSTE / NÍZKÝ OBJEM / SLABÁ POZICE / NEPROPSÁNO / SEZÓNNÍ.
- Dva režimy: Návrh (SKU → doporučení) a Monitoring (SKU → sledování pozic).
- „Doporučená klíčová slova“ z našeptávače Rohlíku jsou oficiální a obhajitelný zdroj. Značíme, která slova doporučuje algoritmus Rohlíku.
- Kontext měření vždy označit: sleva, vyprodáno, multibuy, reklama, novinka.

**Pravidla pro klíčová slova:**
- Přidávat velkoryse: varianty slovosledu, duplicity tokenů, „ochrana“ top 5, překlepy značky jako pojistka. Vyřadit jen špatný typ produktu.
- Stávající klíčová slova nikdy neodstraňovat.
- Pořadí kategorií: příležitost/kombinace (nejdřív příležitost nebo párovaný produkt, např. „džus s vodkou“ u vodky), pak kategorie, atribut, značka, angličtina, slovenština. Slova se značkou konkurence vždy navrhnout, zabalená do běžně znějící fráze („cool osvěžení“ u Cool). Klient schvaluje.
- Jen slova, která lidi opravdu píšou („hokej“, ne „pivo na mistrovství v hokeji“).

## 5. Prazdroj (Plzeňský Prazdroj / Asahi)
- Master list klíčových slov pro 80+ SKU prodaných za posledních 6 měsíců (Kozel 11 KEG vyřazen). Doporučená slova prezentujeme jako návrh POS Media.
- **Pravidla revize:**
  - Méně long-tailu je lépe.
  - Příležitosti a sezóny jsou jeden blok jednoslovných výrazů (vánoce, hokej, grilování, dárek…), bez „pivo na…“.
  - Kombinace s jídlem: nejdřív jídlo, pak pivo („řízek pivo“).
  - Formáty stupňovitosti „pivo 10“ / „pivo 12“.
  - „oktoberfest“ jen u piv, „cool“ u Birellu a kombuchy.
  - „stout“ a „draught“ u Kozla Černého ano, „irské“ ne.
- **Tracker:** GitHub Actions v repu `isigno247/rohlik-spike`. Běží denně v 09:05 (všech ~860 dotazů) a ve 13:07 a 17:07 (22 hlavních dotazů), anonymně, sklad 8791.
- **Data:**
  - historie: `history/*.csv` v gitu;
  - e-maily → Power Automate → SharePoint „Client documents / Asahi (Prazdroj) / Data z Githubu“.
- **Tracker v2 (10. 11.):**
  - hlavní dotazy se měří do hloubky 200;
  - nové sloupce: `in_stock`, `novinka`, `novinka_slot`, `org_pos_clean` (čistá pozice), `oos_top20`, `oos_total`, `novinka_slot_brand`;
  - `org_pos` je beze změny, aby baseline zůstal porovnatelný.
- **Dashboard „Prazdroj – monitoring vyhledávání“** (interní):
  - čte e-maily přes MS365 connector;
  - sekce „Novinka a sklad“ a „Proč se pozice změnila“ (pravidla v pořadí: sklad našeho SKU → slot novinky → nasazení klíčových slov → úprava obsahu → reklamy a slot nad SKU → sleva → vyprodaná konkurence → změna nabídky → „algoritmus“ = bez měřitelné příčiny). Je to odhad, ne důkaz.
- **Rozhodnutí:** bez kontrolních SKU. PU Vánoční balení (novinka) se do sledovaných SKU nepřidává. Porovnání před a po nasazení klíčových slov i po úpravě obsahu se zadává jako datum v configu (`golive`, `contentGolive`).
- **Podrobnosti:** `TRACKER_SETUP.md`, `DASHBOARD_SETUP.md`, `TEST_novinka_OOS.md`.

## 6. Nástroje a postupy
- Měření živých dat: Claude in Chrome. Nejdřív `tabs_context_mcp` (createIfEmpty), pak `navigate`. JavaScript přes `javascript_exec` (parametr `text`). Dlouhé úlohy pouštět na pozadí a průběžně se ptát na stav.
- Endpointy: `/services/frontend-service/autocomplete?search=…&referer=whisperer&companyId=1` a `/services/frontend-service/search-metadata?search=…&offset=…&limit=…&companyId=1&warehouseId=8791`, vždy s `credentials:'omit'`.
- Když Rohlík odmítne oprávnění: zavřít taby, znovu připojit, povolit v postranním panelu rozšíření.
- Úprava souborů v repu přes Chrome: editor na github.com, vložení přes paste, commit, ověření přes SHA-256 surového souboru.
- Klientské decky: pptxgenjs, šablona POS Media CZ (Zeppelin 32, #515A63, #F19500, 21,986 × 12,368 cm), logo POS Media ze šablony. Logo klienta a fotku produktu si Claude obstará sám.

## 7. Jak psát výstupy
- Klientské výstupy česky, jednoduše, bez žargonu, aby je KAM hned pochopil. V deliverables nepoužívat „tiers“, „relevance %“, „deep scan“ ani „totalHits“.
- Pojmy vysvětlovat jednoduše, ale nevymýšlet vlastní terminologii. Anglický termín je v pořádku tam, kde by český byl násilný („brandové dotazy“).
- Opakované reporty a e-maily musí mít stejný layout běh od běhu: zkopírovat předchozí a změnit jen data.
- Interní metodiku dokumentovat zvlášť a technicky podrobně.
