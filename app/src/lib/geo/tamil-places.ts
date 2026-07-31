/**
 * Tamil names for Chennai's police-station localities.
 *
 * The bundled police dataset is English-only, so a Tamil card otherwise
 * printed "G2 Periyamet PS" in the middle of a Tamil sentence. These are
 * the standard Tamil spellings of well-known Chennai localities — the
 * names on the street signs and bus boards — not machine transliteration.
 *
 * SCOPE, deliberately: Chennai city only. Producing Tamil for every
 * station in Tamil Nadu would mean transliterating a couple of thousand
 * village names I cannot verify, and a wrong station name on a document
 * meant for a complaint is worse than an English one that is right. An
 * unknown name is returned UNCHANGED rather than guessed at.
 */

const PLACES: Record<string, string> = {
  "Abiramapuram": "அபிராமபுரம்",
  "Adambakkam": "ஆதம்பாக்கம்",
  "Adyar": "அடையாறு",
  "Airport": "விமான நிலையம்",
  "Ambattur": "அம்பத்தூர்",
  "Ambattur Estate": "அம்பத்தூர் எஸ்டேட்",
  "Aminjikarai": "அமிஞ்சிக்கரை",
  "Anna Nagar": "அண்ணா நகர்",
  "Anna Salai": "அண்ணா சாலை",
  "Anna Square": "அண்ணா சதுக்கம்",
  "Annasalai": "அண்ணா சாலை",
  "Arumbakkam": "அரும்பாக்கம்",
  "Ashok Nagar": "அசோக் நகர்",
  "Avadi": "ஆவடி",
  "Avadi Tank Factory": "ஆவடி டாங்க் தொழிற்சாலை",
  "Ayanavaram": "ஆயனாவரம்",
  "Basin Bridge": "பேசின் பிரிட்ஜ்",
  "Chemanchery": "செம்மஞ்சேரி",
  "Chemmanchery": "செம்மஞ்சேரி",
  "Chetpet": "சேத்துப்பட்டு",
  "Chindadiripet": "சிந்தாதிரிப்பேட்டை",
  "Chintadaripet": "சிந்தாதிரிப்பேட்டை",
  "Chitlapakkam": "சிட்லபாக்கம்",
  "Choolaimedu": "சூளைமேடு",
  "Chrompet": "குரோம்பேட்டை",
  "Cmbt": "சி.எம்.பி.டி.",
  "Egmore": "எழும்பூர்",
  "Elephant Gate": "எலிஃபன்ட் கேட்",
  "Elephantgate": "எலிஃபன்ட் கேட்",
  "Ennore": "எண்ணூர்",
  "Esplanade": "எஸ்பிளனேட்",
  "Fishing Harbour": "மீன்பிடி துறைமுகம்",
  "Flower Bazaar": "பூ பஜார்",
  "Foreshore Estate": "ஃபோர்ஷோர் எஸ்டேட்",
  "Fort": "கோட்டை",
  "Fort  L&O I": "கோட்டை (சட்டம் ஒழுங்கு) I",
  "Fort L&O I": "கோட்டை (சட்டம் ஒழுங்கு) I",
  "General Hospital": "அரசு பொது மருத்துவமனை",
  "Ghosha Hospital": "கோஷா மருத்துவமனை",
  "Govt.Hospital": "அரசு மருத்துவமனை",
  "Guduvancheri": "குடுவாஞ்சேரி",
  "Guindy": "கிண்டி",
  "Harbour": "துறைமுகம்",
  "Ice House": "ஐஸ் ஹவுஸ்",
  "Icf": "ஐ.சி.எஃப்.",
  "J J Nagar": "ஜே.ஜே. நகர்",
  "Jj Nagar": "ஜே.ஜே. நகர்",
  "K K Nagar": "கே.கே. நகர்",
  "K.G. Hospital": "கே.ஜி. மருத்துவமனை",
  "K.K. Nagar": "கே.கே. நகர்",
  "Kanathur": "கானத்தூர்",
  "Kanathur Reddikuppam": "கானத்தூர் ரெட்டிக்குப்பம்",
  "Kannagi Nagar": "கண்ணகி நகர்",
  "Kasimedu": "காசிமேடு",
  "Kayar": "கயார்",
  "Kelambakkam": "கேளம்பாக்கம்",
  "Kilpauk": "கீழ்ப்பாக்கம்",
  "Kodambakkam": "கோடம்பாக்கம்",
  "Kodungaiyur": "கொடுங்கையூர்",
  "Kolathur": "கொளத்தூர்",
  "Korattur": "கொரட்டூர்",
  "Korukkupet": "கொருக்குப்பேட்டை",
  "Kothavalchavadi": "கொத்தவால்சாவடி",
  "Kotturpuram": "கோட்டூர்புரம்",
  "Koyambedu": "கோயம்பேடு",
  "Kumaran Nagar": "குமரன் நகர்",
  "Kundrathur": "குன்றத்தூர்",
  "Kunrathur": "குன்றத்தூர்",
  "M.K.B Nagar": "எம்.கே.பி. நகர்",
  "M.M.Colony": "எம்.எம். காலனி",
  "MGR Memorial": "எம்.ஜி.ஆர். நினைவிடம்",
  "MGR Nagar": "எம்.ஜி.ஆர். நகர்",
  "Madhavaram": "மாதவரம்",
  "Madipakkam": "மடிப்பாக்கம்",
  "Maduravoyal": "மதுரவாயல்",
  "Mambalam": "மாம்பலம்",
  "Manali": "மணலி",
  "Manali New Town": "மணலி புதுநகர்",
  "Mangadu": "மாங்காடு",
  "Manimangalam": "மணிமங்கலம்",
  "Maraimalai Nagar": "மறைமலை நகர்",
  "Marina": "மெரினா",
  "Meenambakkam": "மீனம்பாக்கம்",
  "Mgr Nagar": "எம்.ஜி.ஆர். நகர்",
  "Milk Colony": "மில்க் காலனி",
  "Minjur": "மிஞ்சூர்",
  "Mkb Nagar": "எம்.கே.பி. நகர்",
  "Museum": "அருங்காட்சியகம்",
  "Muthapudupet": "முத்தாபுதுப்பேட்டை",
  "Muthialpet": "முத்தியால்பேட்டை",
  "Muthiyalpet": "முத்தியால்பேட்டை",
  "Mylapore": "மயிலாப்பூர்",
  "Nandambakkam": "நந்தம்பாக்கம்",
  "Nandampakkam": "நந்தம்பாக்கம்",
  "Nasaratpet": "நசரத்பேட்டை",
  "Nazarathpet": "நசரத்பேட்டை",
  "Neelangarai": "நீலாங்கரை",
  "Neelankarai": "நீலாங்கரை",
  "New Washermenpet": "புது வண்ணாரப்பேட்டை",
  "Nolambur": "நொளம்பூர்",
  "North Beach": "வடக்கு கடற்கரை",
  "Nungambakkam": "நுங்கம்பாக்கம்",
  "Oragadam": "ஒரகடம்",
  "Otteri": "ஒட்டேரி",
  "Palavanthangal": "பழவந்தாங்கல்",
  "Pallavaram": "பல்லாவரம்",
  "Pallikaranai": "பள்ளிக்கரணை",
  "Pattabiram": "பட்டாபிராம்",
  "Pattinapakkam": "பட்டினப்பாக்கம்",
  "Pazhavanthangal": "பழவந்தாங்கல்",
  "Peerkankaranai": "பீர்கங்கரணை",
  "Peravallur": "பெரவல்லூர்",
  "Periamet": "பெரியமேடு",
  "Peripheral Hospital": "புறநகர் மருத்துவமனை",
  "Periyamet": "பெரியமேடு",
  "Periyapalayam": "பெரியபாளையம்",
  "Pondy Bazaar": "பாண்டி பஜார்",
  "Poonamalle": "பூந்தமல்லி",
  "Poonamallee": "பூந்தமல்லி",
  "Port Marine": "துறைமுக மெரின்",
  "Pulianthope": "புளியந்தோப்பு",
  "Puzhal": "புழல்",
  "R.K. Nagar": "ஆர்.கே. நகர்",
  "RK Nagar": "ஆர்.கே. நகர்",
  "Rajamangalam": "ராஜமங்கலம்",
  "Red Hills": "செங்குன்றம்",
  "Redhills": "செங்குன்றம்",
  "Royala Nagar": "ராயலா நகர்",
  "Royapettah": "இராயப்பேட்டை",
  "Royapettah hospital": "இராயப்பேட்டை மருத்துவமனை",
  "Royapuram": "இராயபுரம்",
  "Saidapet": "சைதாப்பேட்டை",
  "Sankar Nagar": "சங்கர் நகர்",
  "Sastri Nagar": "சாஸ்திரி நகர்",
  "Sathangadu": "சாத்தன்காடு",
  "Secretariat Colony": "செயலகக் குடியிருப்பு",
  "Selaiyur": "சேலையூர்",
  "Sembium": "செம்பியம்",
  "Seven Wells": "ஏழு கிணறு",
  "Sevenwells": "ஏழு கிணறு",
  "Sevvapet": "செவ்வாப்பேட்டை",
  "Shankar Nagar": "சங்கர் நகர்",
  "Shasthri Nagar": "சாஸ்திரி நகர்",
  "Sholavaram": "சோழவரம்",
  "Solavaram": "சோழவரம்",
  "Somangalam": "சோமங்கலம்",
  "Soundarapandiyanar Angadi (Pondi Bazaar)": "சௌந்தரபாண்டியனார் அங்காடி (பாண்டி பஜார்)",
  "Sriperumbuthur": "ஸ்ரீபெரும்புதூர்",
  "Srmc": "எஸ்.ஆர்.எம்.சி.",
  "St. Thomas Mount": "பரங்கிமலை",
  "St.Thomas Mount": "பரங்கிமலை",
  "T P Chatiram": "டி.பி. சத்திரம்",
  "T.Nagar": "தி. நகர்",
  "Tambaram": "தாம்பரம்",
  "Tank Factory": "டாங்க் தொழிற்சாலை",
  "Taramani": "தரமணி",
  "Teynampet": "தேனாம்பேட்டை",
  "Thalambur": "தளம்பூர்",
  "Tharamani": "தரமணி",
  "Thiru .Vi.Ka. Nagar": "திரு.வி.க. நகர்",
  "Thiru Vi Ka Nagar": "திரு.வி.க. நகர்",
  "Thirumangalam": "திருமங்கலம்",
  "Thirumullaivoyal": "திருமுல்லைவாயல்",
  "Thirunindravur": "திருநின்றவூர்",
  "Thiruvanmiyur": "திருவான்மியூர்",
  "Thiruverkadu": "திருவேற்காடு",
  "Thiruvottiyur": "திருவொற்றியூர்",
  "Thousand Light": "ஆயிரம் விளக்கு",
  "Thousand Lights": "ஆயிரம் விளக்கு",
  "Thuraipakkam": "துரைப்பாக்கம்",
  "Tondiarpet": "தண்டையார்பேட்டை",
  "Tp Chathiram": "டி.பி. சத்திரம்",
  "Triplicane": "திருவல்லிக்கேணி",
  "Vadapalani": "வடபழனி",
  "Valasaravakkam": "வளசரவாக்கம்",
  "Velachery": "வேளச்சேரி",
  "Vellavedu": "வெள்ளவேடு",
  "Vengal": "வேங்கல்",
  "Vepery": "வேப்பேரி",
  "Villivakkam": "வில்லிவாக்கம்",
  "Virugambakkam": "விருகம்பாக்கம்",
  "Vyasarpadi": "வியாசர்பாடி",
  "Vysarpadi": "வியாசர்பாடி",
  "Washermenpet": "வண்ணாரப்பேட்டை",
  "Zam Bazaar": "ஜாம் பஜார்",
  "Zam Bazzar": "ஜாம் பஜார்",
};

/** Station-name furniture, translated separately from the place. */
const SUFFIX_TA = "காவல் நிலையம்";

/** Normalise for lookup: fold case, punctuation and spacing. */
function key(s: string): string {
  return s.toLowerCase().replace(/[.\-_]+/g, " ").replace(/\s+/g, " ").trim();
}

const INDEX = new Map<string, string>(
  Object.entries(PLACES).map(([k, v]) => [key(k), v])
);

/** Tamil for a bare locality, or null when we have no verified name. */
export function tamilPlace(name: string): string | null {
  return INDEX.get(key(name)) ?? null;
}

/**
 * Tamil for a full station name, keeping its beat code.
 *
 * "G2 Periyamet PS" → "G2 பெரியமேடு காவல் நிலையம்". The code is an
 * identifier the police themselves use, so it stays Latin; only the place
 * and the words around it are translated. Returns the input untouched
 * when the locality is not in the dictionary — a half-translated name
 * would look like a typo rather than a gap.
 */
export function tamilStation(raw: string): string {
  if (!raw) return raw;
  const m = /^([A-Z]{1,2}\s?\d+[A-Z]?)[.\s]+(.*)$/.exec(raw.trim());
  const code = m ? m[1].replace(/\s+/g, "") : "";
  let rest = (m ? m[2] : raw).trim();
  let hadSuffix = false;
  rest = rest.replace(/\s*(Aw\.?P\.?S\.?|P\.?S\.?|Police Station)\s*$/i, () => {
    hadSuffix = true;
    return "";
  }).trim();
  const ta = tamilPlace(rest);
  if (!ta) return raw;
  return [code, ta, hadSuffix ? SUFFIX_TA : ""].filter(Boolean).join(" ");
}
