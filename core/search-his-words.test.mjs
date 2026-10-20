import { expect, feature, unit } from "bdd-vitest";
import { asksForHisWords, hisWordsFirst } from "./search-his-words.mjs";

// A question for his words and the order it asks for (docs/DESIGN-search-daemon.md v9: UC-7, I-5, R-10).
// Every question below is made up, about a made-up subject; none is a question or a word of his.
const asks = (name, questions) => questions.map((question) => [name, question, asksForHisWords(question, name)]);
const wrong = (rows, wanted) => rows.filter(([, , held]) => held !== wanted).map(([name, question]) => `${name}: ${question}`);

const SWEDISH_AND_ENGLISH_FORMS = [
  // vad|hur, then what he did, then him
  "vad sa Mattias om lyktschemat", "Hur skrev han om lyktschemat?", "vad bad Mattias om lyktschemat", "vad tyckte han om lyktschemat",
  "VAD VILLE MATTIAS med lyktschemat", "vad menade han med lyktschemat", "vad beslutade Mattias om lyktschemat",
  "vad bestämde han om lyktschemat", "vad sade han om lyktschemat",
  // his name, then how exactly
  "Mattias ordagrant om lyktschemat", "Mattias exakt om lyktschemat", "lyktschemat, Mattias citat",
  // his words, his decision
  "hans ord om lyktschemat", "hans egna ord om lyktschemat", "hans exakta beslut om lyktschemat", "hans beslut om lyktschemat",
  "när sa han det om lyktschemat", "Mattias beslut om lyktschemat",
  // English
  "what did Mattias say about the lantern rota", "What did he decide about the lantern rota", "what did he want with the lantern rota",
  "what did Mattias ask about the lantern rota", "what did he write about the lantern rota",
  "Mattias's words on the lantern rota", "Mattias’s own words on the lantern rota", "his own words on the lantern rota",
  "his exact decision on the lantern rota", "his words on the lantern rota", "his decision on the lantern rota",
  "Mattias verbatim on the lantern rota",
];
// The name is configured, so the forms follow whatever it is: with an å, with a genitive s, with a dot and a space.
const OTHER_NAMES = [
  ["Anna", "Annas beslut om lyktschemat"], ["Åsa", "vad sa åsa om lyktschemat"], ["Åsa", "ÅSAS BESLUT om lyktschemat"],
  ["Dr. Who", "vad sa Dr.  Who om lyktschemat"], ["Dr. Who", "what did Dr. Who say about the lantern rota"],
];

const ANOTHER_PANES_WORDS = [
  "vad sa api:0 om lyktschemat", "vad skrev agenten om lyktschemat", "what did lsrc:1 say about the lantern rota",
  "api:0's words on the lantern rota", "vad sa hon om lyktschemat", "what did she say about the lantern rota", "her words on the lantern rota",
];
const WORDS_THAT_ONLY_CONTAIN_HIS_NAME = [
  "vad sa Mattiasson om lyktschemat", "vad sa Mattias2 om lyktschemat", "vad sa xMattias om lyktschemat", "Mattiasson exakt om lyktschemat",
  "Mattiasson's words on the lantern rota", "vad sa hanna om lyktschemat", "vad sa hans vän om lyktschemat",
  "what did hen say about the lantern rota", "what did Hegel say about the lantern rota",
];
const HIS_NAME_WITHOUT_HIS_WORDS = ["Mattias lyktschemat", "var bor Mattias", "när åkte Mattias till lyktfabriken", "the lantern rota"];

feature("a question for his words", () => {
  unit("finds each Swedish and English form", {
    given: ["a question for each form in mixed case, with å, ä and ö, and the same forms under other configured names", () => ({
      mattias: SWEDISH_AND_ENGLISH_FORMS,
      others: OTHER_NAMES,
    })],
    when: ["asking whether each is for his words", ({ mattias, others }) => [
      ...asks("Mattias", mattias),
      ...others.flatMap(([name, question]) => asks(name, [question])),
    ]],
    then: ["every one is", (rows) => expect(wrong(rows, true)).toEqual([])],
  });

  unit("is false for another pane's words and a word that only contains his name", {
    given: ["questions about someone else, about words that start, end or sit inside his name, and about him without his words", () => ({
      mattias: [...ANOTHER_PANES_WORDS, ...WORDS_THAT_ONLY_CONTAIN_HIS_NAME, ...HIS_NAME_WITHOUT_HIS_WORDS],
      // A dot in the name is a dot, not any letter.
      others: [["A.B", "vad sa AxB om lyktschemat"], ["Åsö", "vad sa Åsöx om lyktschemat"]],
    })],
    when: ["asking whether each is for his words", ({ mattias, others }) => [
      ...asks("Mattias", mattias),
      ...others.flatMap(([name, question]) => asks(name, [question])),
    ]],
    then: ["none is", (rows) => expect(wrong(rows, false)).toEqual([])],
  });

  unit("is false without a name", {
    given: ["questions of every form, including those that need no name in the question", () => [
      "vad sa han om lyktschemat", "när sa han det om lyktschemat", "hans egna ord om lyktschemat",
      "what did he say about the lantern rota", "his own words on the lantern rota", "vad sa Mattias om lyktschemat",
    ]],
    when: ["asking with no configured name, an empty one, blanks, asterisks and a number", (questions) =>
      [undefined, null, "", "   ", "**", 7].flatMap((name) => asks(name, questions))],
    then: ["none is, since without his name nothing says whose words a unit holds", (rows) => expect(wrong(rows, false)).toEqual([])],
  });

  unit("puts his units first and keeps every hit", {
    given: ["a ranking that mixes agents' rows with his units, and a folder that only starts like his", () => {
      const dir = "/home/test/search-human";
      const ranking = [
        { id: "agent note", path: "/home/test/memory/2026-10-20.md" },
        { id: "his joined run", path: `${dir}/2026-10-20.joined.md` },
        { id: "conversation row", path: "/home/test/ask-ledger.jsonl" },
        { id: "his message", path: `${dir}/2026-10-19.md` },
        { id: "a copy beside the folder", path: `${dir}-old/2026-10-18.md` },
        { id: "topic page", path: "/home/test/memory/topics/lyktschemat.md" },
        { id: "his older message", path: `${dir}/2026-10-05.md` },
      ];
      return { dir, ranking, before: ranking.map((hit) => hit.id) };
    }],
    when: ["putting his units first, with the folder as configured, with a trailing slash and with no folder", ({ dir, ranking }) => ({
      plain: hisWordsFirst(ranking, dir), slash: hisWordsFirst(ranking, `${dir}/`), none: hisWordsFirst(ranking, undefined),
    })],
    then: ["his units lead in their order, the rest follow in theirs, nothing is dropped, added or changed, and with no folder nothing moves",
      ({ plain, slash, none }, { ranking, before }) => {
        const ids = (hits) => hits.map((hit) => hit.id);
        const expected = ["his joined run", "his message", "his older message", "agent note", "conversation row", "a copy beside the folder", "topic page"];
        expect(ids(plain)).toEqual(expected);
        expect(ids(slash)).toEqual(expected);
        expect(ids(none)).toEqual(before);
        expect(plain.every((hit) => ranking.includes(hit))).toBe(true);
        expect(ids(ranking)).toEqual(before);
      }],
  });
});
