// Swedish Snowball stemmer (snowballstem.org/algorithms/swedish). Memory is
// written in Swedish, and a question rarely uses the same inflection as the
// note that answers it ("regisserade" vs "regisserat"). A hand-picked ending
// list missed most verb forms; the published algorithm is small and complete.

const VOWELS = new Set("aeiouyäåö");
const S_ENDING = new Set("bcdfghjklmnoprtvy");
const STEP1 = ["heterna", "hetens", "anden", "andes", "andet", "arens", "arnas", "ernas", "heten", "heter", "ornas",
  "ande", "arna", "arne", "aren", "aste", "erna", "erns", "orna", "ades", "ade", "are", "ern", "ens", "het", "ast",
  "ad", "en", "ar", "er", "or", "as", "es", "at", "a", "e"];
const STEP2 = ["dd", "gd", "nn", "dt", "gt", "kt", "tt"];

/** WHAT: Finds where the Snowball R1 region starts. WHY: Suffixes are only removed from R1, which keeps short words intact. */
function regionOne(word) {
  for (let i = 1; i < word.length; i++) {
    if (!VOWELS.has(word[i]) && VOWELS.has(word[i - 1])) return Math.max(3, i + 1);
  }
  return word.length;
}

const endsInRegion = (word, suffix, r1) => word.endsWith(suffix) && word.length - suffix.length >= r1;

/** WHAT: Returns the Swedish Snowball stem of one lower-case word. WHY: Lets inflected forms of one word match each other. */
export function swedishStem(word) {
  let stem = String(word);
  const r1 = regionOne(stem);
  const step1 = STEP1.find((suffix) => endsInRegion(stem, suffix, r1));
  if (step1) stem = stem.slice(0, -step1.length);
  else if (endsInRegion(stem, "s", r1) && S_ENDING.has(stem.at(-2))) stem = stem.slice(0, -1);
  if (STEP2.some((suffix) => endsInRegion(stem, suffix, r1))) stem = stem.slice(0, -1);
  if (endsInRegion(stem, "löst", r1)) stem = stem.slice(0, -1);
  else if (endsInRegion(stem, "fullt", r1)) stem = stem.slice(0, -1);
  else {
    const step3 = ["els", "lig", "ig"].find((suffix) => endsInRegion(stem, suffix, r1));
    if (step3) stem = stem.slice(0, -step3.length);
  }
  return stem;
}
