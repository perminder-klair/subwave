// Localized sample sentences for the admin "Play sample" button. A persona's
// `language` is free operator text ("Turkish", "Türkçe", "tr", …), so the
// lookup normalizes (lowercase, diacritics stripped) and matches the English
// name, native name(s), and ISO 639-1 code. Unknown or empty language → null,
// and the caller falls back to the English default sentence.
//
// Deliberately a static table, NOT an LLM translation call: the audition
// button must stay instant and keep working with the model down. "SUB/WAVE"
// stays untranslated in every entry — same proper-noun rule as the on-air
// languageDirective (issue #349).

interface PreviewEntry {
  // Normalized match keys: english name, native name(s), ISO 639-1 code.
  keys: string[];
  sample: string;
}

const ENTRIES: PreviewEntry[] = [
  { keys: ['spanish', 'espanol', 'castellano', 'es'],
    sample: 'Estás escuchando SUB/WAVE. Esta es una prueba de voz.' },
  { keys: ['french', 'francais', 'fr'],
    sample: 'Vous écoutez SUB/WAVE. Ceci est un essai de voix.' },
  { keys: ['german', 'deutsch', 'de'],
    sample: 'Du hörst SUB/WAVE. Dies ist eine Sprachvorschau.' },
  { keys: ['italian', 'italiano', 'it'],
    sample: "Stai ascoltando SUB/WAVE. Questa è un'anteprima vocale." },
  { keys: ['portuguese', 'portugues', 'brazilian portuguese', 'pt', 'pt-br'],
    sample: 'Você está ouvindo SUB/WAVE. Esta é uma amostra de voz.' },
  { keys: ['dutch', 'nederlands', 'nl'],
    sample: 'Je luistert naar SUB/WAVE. Dit is een stemvoorbeeld.' },
  { keys: ['turkish', 'turkce', 'tr'],
    sample: 'SUB/WAVE dinliyorsunuz. Bu bir ses önizlemesidir.' },
  { keys: ['polish', 'polski', 'pl'],
    sample: 'Słuchasz SUB/WAVE. To jest próbka głosu.' },
  { keys: ['russian', 'russkij', 'русский', 'ru'],
    sample: 'Вы слушаете SUB/WAVE. Это образец голоса.' },
  { keys: ['ukrainian', 'украинська', 'українська', 'uk'],
    sample: 'Ви слухаєте SUB/WAVE. Це зразок голосу.' },
  { keys: ['czech', 'cestina', 'cs'],
    sample: 'Posloucháte SUB/WAVE. Toto je ukázka hlasu.' },
  { keys: ['swedish', 'svenska', 'sv'],
    sample: 'Du lyssnar på SUB/WAVE. Det här är ett röstprov.' },
  { keys: ['norwegian', 'norsk', 'no', 'nb'],
    sample: 'Du hører på SUB/WAVE. Dette er en stemmeprøve.' },
  { keys: ['danish', 'dansk', 'da'],
    sample: 'Du lytter til SUB/WAVE. Dette er en stemmeprøve.' },
  { keys: ['finnish', 'suomi', 'fi'],
    sample: 'Kuuntelet SUB/WAVE-kanavaa. Tämä on ääninäyte.' },
  { keys: ['greek', 'ellinika', 'ελληνικα', 'el'],
    sample: 'Ακούτε το SUB/WAVE. Αυτή είναι μια δοκιμή φωνής.' },
  { keys: ['romanian', 'romana', 'ro'],
    sample: 'Ascultați SUB/WAVE. Aceasta este o mostră de voce.' },
  { keys: ['hungarian', 'magyar', 'hu'],
    sample: 'A SUB/WAVE adását hallgatod. Ez egy hangminta.' },
  { keys: ['japanese', 'nihongo', '日本語', 'ja'],
    sample: 'SUB/WAVEをお聴きいただいています。これは音声プレビューです。' },
  { keys: ['chinese', 'mandarin', 'zhongwen', '中文', '普通话', 'zh', 'zh-cn'],
    sample: '您正在收听 SUB/WAVE。这是一段语音试听。' },
  { keys: ['korean', 'hangugeo', '한국어', 'ko'],
    sample: 'SUB/WAVE를 듣고 계십니다. 이것은 음성 미리듣기입니다.' },
  { keys: ['hindi', 'हिन्दी', 'हिंदी', 'hi'],
    sample: 'आप SUB/WAVE सुन रहे हैं। यह एक आवाज़ का नमूना है।' },
  { keys: ['punjabi', 'panjabi', 'ਪੰਜਾਬੀ', 'pa'],
    sample: 'ਤੁਸੀਂ SUB/WAVE ਸੁਣ ਰਹੇ ਹੋ। ਇਹ ਇੱਕ ਆਵਾਜ਼ ਦਾ ਨਮੂਨਾ ਹੈ।' },
  { keys: ['arabic', 'العربية', 'ar'],
    sample: 'أنت تستمع إلى SUB/WAVE. هذه معاينة صوتية.' },
  { keys: ['hebrew', 'עברית', 'he'],
    sample: 'אתם מאזינים ל-SUB/WAVE. זוהי דוגמת קול.' },
  { keys: ['vietnamese', 'tieng viet', 'vi'],
    sample: 'Bạn đang nghe SUB/WAVE. Đây là bản nghe thử giọng nói.' },
  { keys: ['thai', 'ไทย', 'th'],
    sample: 'คุณกำลังฟัง SUB/WAVE นี่คือตัวอย่างเสียง' },
  { keys: ['indonesian', 'bahasa indonesia', 'id'],
    sample: 'Anda sedang mendengarkan SUB/WAVE. Ini adalah contoh suara.' },
  // English is the DEFAULT_PREVIEW_TEXT fallback, but an explicit "English"
  // should still match rather than looking like an unknown language.
  { keys: ['english', 'en', 'en-gb', 'en-us'],
    sample: "You're listening to SUB/WAVE. This is a voice preview." },
];

// "Türkçe" → "turkce": lowercase, strip combining marks, collapse whitespace.
function normalizeLanguage(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const LOOKUP = new Map<string, string>();
for (const entry of ENTRIES) {
  for (const key of entry.keys) LOOKUP.set(normalizeLanguage(key), entry.sample);
}

// The localized preview sentence for a persona's free-text `language`, or
// null when the language is empty/unrecognized (caller keeps the English
// default — same behaviour those personas had before this table existed).
export function localizedPreviewText(language?: string): string | null {
  if (!language || typeof language !== 'string') return null;
  return LOOKUP.get(normalizeLanguage(language)) ?? null;
}
