/**
 * Card languages, one registry.
 *
 * The app watermarks civic complaints, and a complaint reads better to the
 * office that receives it in that office's working language. So the card
 * offers the language of the state it is standing in — Kannada in
 * Bengaluru, Marathi in Mumbai and Pune, Telugu in Hyderabad and
 * Visakhapatnam, Bengali in Kolkata, Tamil in Tamil Nadu, Hindi in Delhi.
 *
 * Scope is deliberately tied to COVERAGE: a language appears only where we
 * actually hold boundary data, because offering Odia with no Odisha pack
 * would promise a card we cannot fill. Adding a state means adding its
 * pack and its entry here, nothing else.
 *
 * English stays the default everywhere and the fallback for anything a
 * language does not define.
 */

export type CardLang = "en" | "ta" | "hi" | "kn" | "te" | "mr" | "bn";

/** Field labels stamped on the card. */
export interface CardStrings {
  digipin: string;
  ward: string;
  zone: string;
  block: string;
  district: string;
  policeBoth: string;
  policeLo: string;
  traffic: string;
  noise: string;
  avg: string;
  min: string;
  max: string;
  facing: string;
  acquiring: string;
  wardPending: string;
  mock: string;
}

export interface LangDef {
  /** Name shown in Settings — endonym first, so speakers find it. */
  label: string;
  /** Font stack; Indic scripts need their own or they silently tofu. */
  font: string;
  /** BCP-47 tag for Intl and for asking geocoders. */
  locale: string;
  strings: CardStrings;
  coords: { lat: string; lng: string };
  alt: { label: string; metre: string };
  /** ICU returns Latin AM/PM for several Indian locales, so these are
   *  written out rather than read back from Intl. */
  meridiem: [string, string];
  zoneWord: string;
}

const LATIN =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";
const stack = (family: string) => `'${family}', ${LATIN}`;

export const LANGS: Record<CardLang, LangDef> = {
  en: {
    label: "English",
    font: LATIN,
    locale: "en-IN",
    coords: { lat: "Lat", lng: "Long" },
    alt: { label: "Alt", metre: "m" },
    meridiem: ["AM", "PM"],
    zoneWord: "Zone",
    strings: {
      digipin: "DIGIPIN", ward: "Ward", zone: "Zone", block: "Block",
      district: "District", policeBoth: "Police (L&O & Traffic)",
      policeLo: "Police (L&O)", traffic: "Traffic", noise: "Noise",
      avg: "Avg", min: "Min", max: "Max", facing: "Facing",
      acquiring: "GPS: acquiring…", wardPending: "Ward: not yet available",
      mock: "⚠ Mock location — GPS may be spoofed",
    },
  },
  ta: {
    label: "தமிழ் Tamil",
    font: stack("Noto Sans Tamil"),
    locale: "ta-IN",
    coords: { lat: "அட்சம்", lng: "நீளம்" },
    alt: { label: "உயரம்", metre: "மீ" },
    meridiem: ["மு.ப.", "பி.ப."],
    zoneWord: "மண்டலம்",
    strings: {
      digipin: "டிஜிபின்", ward: "வார்டு", zone: "மண்டலம்", block: "ஒன்றியம்",
      district: "மாவட்டம்", policeBoth: "காவல் (சட்டம் மற்றும் போக்குவரத்து)",
      policeLo: "காவல் நிலையம்", traffic: "போக்குவரத்து", noise: "ஒலி அளவு",
      avg: "சராசரி", min: "குறைந்தது", max: "அதிகபட்சம்", facing: "திசை",
      acquiring: "GPS: பெறப்படுகிறது…",
      wardPending: "வார்டு: இன்னும் கிடைக்கவில்லை",
      mock: "⚠ போலி இருப்பிடம் — GPS தவறாக இருக்கலாம்",
    },
  },
  hi: {
    label: "हिन्दी Hindi",
    font: stack("Noto Sans Devanagari"),
    locale: "hi-IN",
    coords: { lat: "अक्षांश", lng: "देशांतर" },
    alt: { label: "ऊंचाई", metre: "मी" },
    meridiem: ["पूर्वाह्न", "अपराह्न"],
    zoneWord: "क्षेत्र",
    strings: {
      digipin: "डिजिपिन", ward: "वार्ड", zone: "क्षेत्र", block: "प्रखंड",
      district: "जिला", policeBoth: "पुलिस (कानून एवं यातायात)",
      policeLo: "पुलिस थाना", traffic: "यातायात", noise: "ध्वनि स्तर",
      avg: "औसत", min: "न्यूनतम", max: "अधिकतम", facing: "दिशा",
      acquiring: "GPS: प्राप्त किया जा रहा है…",
      wardPending: "वार्ड: अभी उपलब्ध नहीं",
      mock: "⚠ नकली स्थान — GPS गलत हो सकता है",
    },
  },
  kn: {
    label: "ಕನ್ನಡ Kannada",
    font: stack("Noto Sans Kannada"),
    locale: "kn-IN",
    coords: { lat: "ಅಕ್ಷಾಂಶ", lng: "ರೇಖಾಂಶ" },
    alt: { label: "ಎತ್ತರ", metre: "ಮೀ" },
    meridiem: ["ಪೂರ್ವಾಹ್ನ", "ಅಪರಾಹ್ನ"],
    zoneWord: "ವಲಯ",
    strings: {
      digipin: "ಡಿಜಿಪಿನ್", ward: "ವಾರ್ಡ್", zone: "ವಲಯ", block: "ಬ್ಲಾಕ್",
      district: "ಜಿಲ್ಲೆ", policeBoth: "ಪೊಲೀಸ್ (ಕಾನೂನು ಮತ್ತು ಸಂಚಾರ)",
      policeLo: "ಪೊಲೀಸ್ ಠಾಣೆ", traffic: "ಸಂಚಾರ", noise: "ಶಬ್ದ ಮಟ್ಟ",
      avg: "ಸರಾಸರಿ", min: "ಕನಿಷ್ಠ", max: "ಗರಿಷ್ಠ", facing: "ದಿಕ್ಕು",
      acquiring: "GPS: ಪಡೆಯಲಾಗುತ್ತಿದೆ…",
      wardPending: "ವಾರ್ಡ್: ಇನ್ನೂ ಲಭ್ಯವಿಲ್ಲ",
      mock: "⚠ ನಕಲಿ ಸ್ಥಳ — GPS ತಪ್ಪಾಗಿರಬಹುದು",
    },
  },
  te: {
    label: "తెలుగు Telugu",
    font: stack("Noto Sans Telugu"),
    locale: "te-IN",
    coords: { lat: "అక్షాంశం", lng: "రేఖాంశం" },
    alt: { label: "ఎత్తు", metre: "మీ" },
    meridiem: ["ఉదయం", "సాయంత్రం"],
    zoneWord: "జోన్",
    strings: {
      digipin: "డిజిపిన్", ward: "వార్డు", zone: "జోన్", block: "బ్లాక్",
      district: "జిల్లా", policeBoth: "పోలీస్ (శాంతిభద్రతలు మరియు ట్రాఫిక్)",
      policeLo: "పోలీస్ స్టేషన్", traffic: "ట్రాఫిక్", noise: "శబ్ద స్థాయి",
      avg: "సగటు", min: "కనిష్ఠ", max: "గరిష్ఠ", facing: "దిశ",
      acquiring: "GPS: పొందుతోంది…",
      wardPending: "వార్డు: ఇంకా అందుబాటులో లేదు",
      mock: "⚠ నకిలీ స్థానం — GPS తప్పు కావచ్చు",
    },
  },
  mr: {
    label: "मराठी Marathi",
    font: stack("Noto Sans Devanagari"),
    locale: "mr-IN",
    coords: { lat: "अक्षांश", lng: "रेखांश" },
    alt: { label: "उंची", metre: "मी" },
    meridiem: ["स.", "दु."],
    zoneWord: "विभाग",
    strings: {
      digipin: "डिजिपिन", ward: "प्रभाग", zone: "विभाग", block: "गट",
      district: "जिल्हा", policeBoth: "पोलीस (कायदा व वाहतूक)",
      policeLo: "पोलीस ठाणे", traffic: "वाहतूक", noise: "ध्वनी पातळी",
      avg: "सरासरी", min: "किमान", max: "कमाल", facing: "दिशा",
      acquiring: "GPS: मिळवत आहे…",
      wardPending: "प्रभाग: अद्याप उपलब्ध नाही",
      mock: "⚠ बनावट स्थान — GPS चुकीचे असू शकते",
    },
  },
  bn: {
    label: "বাংলা Bengali",
    font: stack("Noto Sans Bengali"),
    locale: "bn-IN",
    coords: { lat: "অক্ষাংশ", lng: "দ্রাঘিমাংশ" },
    alt: { label: "উচ্চতা", metre: "মি" },
    meridiem: ["পূর্বাহ্ন", "অপরাহ্ন"],
    zoneWord: "অঞ্চল",
    strings: {
      digipin: "ডিজিপিন", ward: "ওয়ার্ড", zone: "অঞ্চল", block: "ব্লক",
      district: "জেলা", policeBoth: "পুলিশ (আইনশৃঙ্খলা ও ট্রাফিক)",
      policeLo: "থানা", traffic: "ট্রাফিক", noise: "শব্দমাত্রা",
      avg: "গড়", min: "সর্বনিম্ন", max: "সর্বোচ্চ", facing: "দিক",
      acquiring: "GPS: সংগ্রহ করা হচ্ছে…",
      wardPending: "ওয়ার্ড: এখনও পাওয়া যায়নি",
      mock: "⚠ নকল অবস্থান — GPS ভুল হতে পারে",
    },
  },
};

/**
 * Anything unrecognised — including the `undefined` every config stored
 * before card languages existed — resolves to English, so an old photo
 * re-composites exactly as it always did.
 */
export function langOf(lang: unknown): CardLang {
  return typeof lang === "string" && lang in LANGS ? (lang as CardLang) : "en";
}

/** Which languages to offer, by the geodata pack the user is standing in. */
const PACK_LANGS: Record<string, CardLang[]> = {
  chennai: ["ta"],
  tamilnadu: ["ta"],
  bengaluru: ["kn"],
  hyderabad: ["te"],
  visakhapatnam: ["te"],
  mumbai: ["mr"],
  pune: ["mr"],
  kolkata: ["bn"],
  delhi: ["hi"],
};

/**
 * English first, then the local language, then Hindi where it is not
 * already the local one. Offering all seven everywhere would bury the one
 * a given user actually wants behind six they do not.
 */
export function langsFor(packId: string | null | undefined): CardLang[] {
  const local = (packId && PACK_LANGS[packId]) || [];
  const out: CardLang[] = ["en", ...local];
  if (!out.includes("hi")) out.push("hi");
  return out;
}

/** Every language, for the Settings list when no pack has loaded yet. */
export const ALL_LANGS = Object.keys(LANGS) as CardLang[];
