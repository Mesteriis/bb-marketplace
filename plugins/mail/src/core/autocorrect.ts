// Autocorrect for the composer: what one finished word becomes. Pure rules;
// the editor plugin (src/ui/editor-typing.ts) applies them as the owner types
// and undoes one on Backspace. Nothing here knows about the editor.

export type Correction = { from: string; to: string };

/** The most replacements of the owner's own that are kept. */
export const PAIRS_MAX = 200;

/** The owner's replacements: `from => to`, one a line or separated by `;`; the left side is one word. */
export function parsePairs(text: string): Correction[] {
  const pairs: Correction[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n|;/)) {
    const at = line.indexOf("=>");
    if (at === -1) continue;
    const from = line.slice(0, at).trim();
    const to = line.slice(at + 2).trim();
    if (from === "" || to === "" || /\s/.test(from)) continue;
    const key = from.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ from, to });
    if (pairs.length === PAIRS_MAX) break;
  }
  return pairs;
}

// Common slips, lower case. Only whole words; a word that is also a real word is not here.
const ENGLISH: Readonly<Record<string, string>> = {
  teh: "the", hte: "the", adn: "and", nad: "and", taht: "that", thta: "that", waht: "what", wiht: "with", whit: "with",
  recieve: "receive", recieved: "received", reciept: "receipt", beleive: "believe", belive: "believe", acheive: "achieve",
  definately: "definitely", definitly: "definitely", defiantly: "definitely", seperate: "separate", seperately: "separately",
  occured: "occurred", occuring: "occurring", occurence: "occurrence", untill: "until", wich: "which", whcih: "which",
  becuase: "because", beacuse: "because", becasue: "because", alot: "a lot", accomodate: "accommodate",
  adress: "address", adresses: "addresses", agian: "again", alreayd: "already", allready: "already", alwasy: "always",
  appologize: "apologize", appreciat: "appreciate", apreciate: "appreciate", arguement: "argument", basicly: "basically",
  begining: "beginning", buisness: "business", bussiness: "business", calender: "calendar", cancelation: "cancellation",
  collegue: "colleague", collegues: "colleagues", comming: "coming", commited: "committed", comittee: "committee",
  completly: "completely", concious: "conscious", definate: "definite", diffrent: "different", dissapoint: "disappoint",
  dissapointed: "disappointed", doesnt: "doesn't", dont: "don't", didnt: "didn't", cant: "can't", couldnt: "couldn't",
  wouldnt: "wouldn't", shouldnt: "shouldn't", isnt: "isn't", wasnt: "wasn't", arent: "aren't", werent: "weren't",
  havent: "haven't", hasnt: "hasn't", hadnt: "hadn't", wont: "won't", thats: "that's", theres: "there's", im: "I'm",
  ive: "I've", youre: "you're", theyre: "they're", embarass: "embarrass", enviroment: "environment", exellent: "excellent",
  existance: "existence", experiance: "experience", familar: "familiar", finaly: "finally", foward: "forward",
  freind: "friend", freinds: "friends", futher: "further", goverment: "government", gaurantee: "guarantee",
  garantee: "guarantee", happend: "happened", harrass: "harass", immediatly: "immediately", independant: "independent",
  intrested: "interested", knowlege: "knowledge", liason: "liaison", libary: "library", lisence: "license",
  maintainance: "maintenance", managment: "management", mesage: "message", mesages: "messages", neccessary: "necessary",
  necesary: "necessary", noticable: "noticeable", occassion: "occasion", oppurtunity: "opportunity", orignal: "original",
  payed: "paid", peice: "piece", persistant: "persistent", posession: "possession", prefered: "preferred",
  probaly: "probably", proffesional: "professional", profesional: "professional", publically: "publicly",
  realy: "really", recomend: "recommend", reccomend: "recommend", refered: "referred", relevent: "relevant",
  remeber: "remember", rember: "remember", repsonse: "response", resposne: "response", responce: "response",
  sucess: "success", succesful: "successful", successfull: "successful", suprise: "surprise", shedule: "schedule",
  scedule: "schedule", sincerly: "sincerely", similiar: "similar", sence: "sense", thier: "their", threshhold: "threshold",
  tommorow: "tomorrow", tommorrow: "tomorrow", tomorow: "tomorrow", truely: "truly", unfortunatly: "unfortunately",
  usefull: "useful", wierd: "weird", writting: "writing", yuo: "you", yoru: "your", jsut: "just", konw: "know",
  knwo: "know", liek: "like", amke: "make", mkae: "make", msut: "must", nto: "not", fo: "of", hwo: "how", tihs: "this",
  thsi: "this", thnaks: "thanks", thansk: "thanks", thakns: "thanks", pls: "please", plese: "please", pleae: "please",
  regadrs: "regards", regrads: "regards", attahced: "attached", atached: "attached", attachement: "attachment",
  availible: "available", avaliable: "available", meeitng: "meeting", meetign: "meeting", todya: "today", tiem: "time",
  wokr: "work", owrk: "work", wrok: "work", woudl: "would", coudl: "could", shoudl: "should", abotu: "about", aobut: "about",
};

const RUSSIAN: Readonly<Record<string, string>> = {
  сдесь: "здесь", зделать: "сделать", зделал: "сделал", зделано: "сделано", здраствуйте: "здравствуйте",
  здравствуте: "здравствуйте", пожалуста: "пожалуйста", пожалуйсто: "пожалуйста", спосибо: "спасибо", спасибки: "спасибо",
  вобщем: "в общем", вообщем: "в общем", вобще: "вообще", всетаки: "всё-таки", ктото: "кто-то", чтото: "что-то",
  гдето: "где-то", какойто: "какой-то", както: "как-то", когдато: "когда-то", почемуто: "почему-то", изза: "из-за",
  попрежнему: "по-прежнему", помоему: "по-моему", потомучто: "потому что", тоесть: "то есть", врядли: "вряд ли",
  какбудто: "как будто", всмысле: "в смысле", впринципе: "в принципе", втечение: "в течение",
  навсякий: "на всякий", досвидания: "до свидания", извените: "извините", извени: "извини", придти: "прийти",
  будующий: "будущий", следущий: "следующий", учавствовать: "участвовать", учавствую: "участвую", координально: "кардинально",
  агенство: "агентство", колличество: "количество", расчитывать: "рассчитывать", расчитываю: "рассчитываю",
  росписание: "расписание", встречя: "встреча", прийдёт: "придёт", прийду: "приду", ложить: "класть",
  симпотичный: "симпатичный", щас: "сейчас", счас: "сейчас", чтонибудь: "что-нибудь",
  ктонибудь: "кто-нибудь", гденибудь: "где-нибудь", какнибудь: "как-нибудь", ненадо: "не надо", незнаю: "не знаю",
  немогу: "не могу", нехочу: "не хочу", небуду: "не буду", ненужно: "не нужно", вследствии: "вследствие",
  впоследствие: "впоследствии", оффис: "офис", адресс: "адрес", граммотный: "грамотный", аттачмент: "вложение",
  превет: "привет", спс: "спасибо", пжл: "пожалуйста", плз: "пожалуйста", собщение: "сообщение", сообшение: "сообщение",
};

const LETTER = /\p{L}/u;
const upperFirst = (text: string) => (text === "" ? text : text[0]!.toLocaleUpperCase() + text.slice(1));
const isLower = (text: string) => text === text.toLocaleLowerCase() && text !== text.toLocaleUpperCase();
/** Letters and apostrophes only: not `example.com`, `x2` or `e-mail`. */
const PLAIN_WORD = /^[\p{L}'’]+$/u;

/** `I` and its contractions, as typed in lower case. */
const I_FORMS: Readonly<Record<string, string>> = { i: "I", "i'm": "I'm", "i'll": "I'll", "i've": "I've", "i'd": "I'd" };

/**
 * What a finished word should be, or null when it stays. In order: the owner's
 * replacements, the built-in misspellings (a capital first letter is kept),
 * the English `i`, two capitals at a word's start, the first letter of a
 * sentence. A word in `skip` (one the owner restored) is never changed.
 */
export function correctWord(
  word: string,
  context: { sentenceStart: boolean; pairs: readonly Correction[]; skip: ReadonlySet<string> },
): string | null {
  if (word === "" || context.skip.has(word)) return null;
  const lower = word.toLocaleLowerCase();
  const capital = word !== lower && word === upperFirst(lower);
  const startCase = (text: string) => (capital || context.sentenceStart ? upperFirst(text) : text);

  const own = context.pairs.find((pair) => pair.from.toLocaleLowerCase() === lower);
  if (own !== undefined) {
    const next = startCase(own.to);
    return next === word ? null : next;
  }
  // The lists hold lower-case words: only a lower-case or Capitalized word is one of them.
  if (word === lower || capital) {
    const known = ENGLISH[lower] ?? RUSSIAN[lower];
    if (known !== undefined && known !== lower) return startCase(known);
    const i = I_FORMS[lower.replace("’", "'")];
    if (i !== undefined && word === lower) return i;
  }
  // THe -> The: two capitals, then lower-case letters; a plural of two letters (IDs, PRs) stays.
  const chars = Array.from(word);
  if (chars.length >= 3 && PLAIN_WORD.test(word) && chars.slice(2).join("") !== "s") {
    const head = chars.slice(0, 2).join("");
    const tail = chars.slice(2).join("");
    if (head === head.toLocaleUpperCase() && head !== head.toLocaleLowerCase() && isLower(tail) && !tail.includes("'")) {
      return chars[0]! + chars[1]!.toLocaleLowerCase() + tail;
    }
  }
  if (context.sentenceStart && PLAIN_WORD.test(word) && LETTER.test(chars[0] ?? "") && word === lower && lower !== word.toLocaleUpperCase()) {
    return upperFirst(word);
  }
  return null;
}
