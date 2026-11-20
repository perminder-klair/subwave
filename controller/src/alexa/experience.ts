import { escapeXmlCharacters } from 'ask-sdk-core';

export type AlexaLocale = 'en-US' | 'en-IN' | 'hi-IN';

export interface AlexaPresentationTrack {
  id?: string | null;
  title: string;
  artist: string;
  album?: string | null;
  artworkUrl?: string | null;
}
export function alexaLocale(locale?: string | null): AlexaLocale {
  if (locale === 'hi-IN') return 'hi-IN';
  if (locale === 'en-US') return 'en-US';
  return 'en-IN';
}

const MESSAGES: Record<AlexaLocale, {
  offline: string;
  starting: string;
  resuming: string;
  paused: string;
  stopped: string;
  error: string;
  noCurrent: string;
  noNext: string;
  noPrevious: string;
  statusEmpty: string;
  help: string;
  requestPrompt: string;
  requestAccepted: string;
  requestFailed: string;
  requestPending: string;
  requestQueued: (title: string, position: number | null, eta: string | null) => string;
  requestPlaying: (title: string) => string;
  requestFinished: (title: string) => string;
  requestCancelled: (title: string) => string;
  requestInterrupted: string;
  requestFailedStatus: string;
  requestResolved: (title: string) => string;
  cancelEmpty: string;
  cancelTooLate: string;
  cancelSuccess: (title: string) => string;
  replacePrompt: string;
  replaceAccepted: string;
  stationOnline: string;
  stationOffline: string;
  previous: (track: string) => string;
  current: (track: string) => string;
  next: (track: string) => string;
  nextMany: (tracks: string) => string;
  candidate: (track: string) => string;
  candidateReprompt: string;
  candidateNo: string;
  moreLikeThis: (track: string) => string;
  anotherByArtist: (track: string) => string;
  featureNoMatch: string;
  featureFailed: string;
  recent: (tracks: string) => string;
  recentEmpty: string;
  details: (title: string, detailType: string, fields: string) => string;
  currentShow: (name: string, dj: string, guests: string) => string;
  noShow: (dj: string | null) => string;
  dedicationPrompt: string;
  dedicationTargetPrompt: string;
  dedicationAccepted: string;
  dedicationFailed: string;
  reminderEmpty: string;
  reminderPending: string;
  reminderUnavailable: string;
  reminderConfirm: (title: string, eta: string) => string;
  reminderPermission: string;
  reminderPermissionRetry: string;
  reminderSet: (title: string) => string;
  reminderAlreadySet: string;
  reminderDenied: string;
  reminderFailed: string;
  reminderStale: string;
  intentDisabled: string;
}> = {
  'en-US': {
    offline: 'The station is currently offline.',
    starting: 'Starting',
    resuming: 'Resuming',
    paused: 'Radio paused.',
    stopped: 'Radio stopped.',
    error: 'Sorry, I could not control the radio.',
    noCurrent: 'Nothing is playing right now.',
    noNext: 'There is no song queued next.',
    noPrevious: 'There is no recently played song available.',
    statusEmpty: 'You have no recent song request.',
    help: 'You can start or stop the radio, request or dedicate a song, ask for a request reminder, ask what is playing, or ask what plays next.',
    requestPrompt: 'Please tell me the song, artist, album, or mood you want to request.',
    requestAccepted: 'Your request was sent to the booth. It will play when available.',
    requestFailed: 'I could not submit that request right now.',
    requestPending: 'Your latest request is still being matched. Ask again shortly for an update.',
    requestQueued: (title, position, eta) => `Your latest request for ${title} is queued${position ? ` at position ${position}` : ''}${eta ? ` and should play ${eta}` : ''}.`,
    requestPlaying: title => `Your latest request for ${title} is playing now.`,
    requestFinished: title => `Your latest request for ${title} has already played.`,
    requestCancelled: title => `Your request for ${title} was cancelled.`,
    requestInterrupted: 'Your latest request was interrupted by a station restart. Please submit it again.',
    requestFailedStatus: 'I could not find a matching track for your latest request.',
    requestResolved: title => `Your latest request${title} was processed.`,
    cancelEmpty: 'You have no waiting song request to cancel.',
    cancelTooLate: 'That request is already playing or has reached the player, so I cannot cancel it.',
    cancelSuccess: title => `Your waiting request for ${title} was cancelled.`,
    replacePrompt: 'Tell me the new song, artist, album, or mood for the replacement request.',
    replaceAccepted: 'Your previous waiting request was replaced. The new request was sent to the booth.',
    stationOnline: 'The station is online and ready to play.',
    stationOffline: 'The station is offline right now. Please try again later.',
    previous: track => `The previous song was ${track}.`,
    current: track => `Currently playing ${track}.`,
    next: track => `The next song is ${track}.`,
    nextMany: tracks => `Coming up next: ${tracks}.`,
    candidate: track => `I found ${track}. Is that the song you want?`,
    candidateReprompt: 'Say yes to request it, or no to hear the next match.',
    candidateNo: 'Okay. I will keep looking for another match.',
    moreLikeThis: track => `More like ${track} is on the way.`,
    anotherByArtist: track => `Another track by ${track} is on the way.`,
    featureNoMatch: 'I could not find another matching track in the library.',
    featureFailed: 'I could not send that track request right now.',
    recent: tracks => `Recently played: ${tracks}.`,
    recentEmpty: 'There are no recently played tracks available.',
    details: (title, detailType, fields) => `For ${title}, ${detailType}: ${fields}.`,
    currentShow: (name, dj, guests) => guests ? `${name} is on now with ${dj} and ${guests}.` : `${name} is on now with ${dj}.`,
    noShow: dj => dj ? `There is no scheduled show right now. ${dj} is on air.` : 'There is no scheduled show right now.',
    dedicationPrompt: 'Tell me the song you want to dedicate.',
    dedicationTargetPrompt: 'Who should I dedicate it to?',
    dedicationAccepted: 'Your dedication was sent to the booth. It will play when available.',
    dedicationFailed: 'I could not send that dedication right now.',
    reminderEmpty: 'You have no recent queued song request to remind you about.',
    reminderPending: 'Your latest request is still being matched. Ask me for a reminder once it is queued.',
    reminderUnavailable: 'I do not have a reliable queue estimate for that request yet. Please try again when it is closer.',
    reminderConfirm: (title, eta) => `Your request for ${title} should play ${eta}. Should I remind you one minute before it plays?`,
    reminderPermission: 'I need permission to update your Alexa reminders. I will ask for that permission now.',
    reminderPermissionRetry: 'I did not catch that. Alexa will ask again whether I can update your reminders.',
    reminderSet: title => `Okay, I will remind you one minute before ${title} is expected to play.`,
    reminderAlreadySet: 'A reminder is already set for your latest request.',
    reminderDenied: 'Okay, I will not set a reminder.',
    reminderFailed: 'I could not create that reminder right now. Please try again later.',
    reminderStale: 'The queue changed before I could set that reminder. Please ask again for a fresh estimate.',
    intentDisabled: 'That feature is disabled for this station.',
  },
  'en-IN': {
    offline: 'The station is currently offline.',
    starting: 'Starting',
    resuming: 'Resuming',
    paused: 'Radio paused.',
    stopped: 'Radio stopped.',
    error: 'Sorry, I could not control the radio.',
    noCurrent: 'Nothing is playing right now.',
    noNext: 'There is no song queued next.',
    noPrevious: 'There is no recently played song available.',
    statusEmpty: 'You have no recent song request.',
    help: 'You can start or stop the radio, request or dedicate a song, ask for a request reminder, ask what is playing, or ask what plays next.',
    requestPrompt: 'Please tell me the song, artist, album, or mood you want to request.',
    requestAccepted: 'Your request was sent to the booth. It will play when available.',
    requestFailed: 'I could not submit that request right now.',
    requestPending: 'Your latest request is still being matched. Ask again shortly for an update.',
    requestQueued: (title, position, eta) => `Your latest request for ${title} is queued${position ? ` at position ${position}` : ''}${eta ? ` and should play ${eta}` : ''}.`,
    requestPlaying: title => `Your latest request for ${title} is playing now.`,
    requestFinished: title => `Your latest request for ${title} has already played.`,
    requestCancelled: title => `Your request for ${title} was cancelled.`,
    requestInterrupted: 'Your latest request was interrupted by a station restart. Please submit it again.',
    requestFailedStatus: 'I could not find a matching track for your latest request.',
    requestResolved: title => `Your latest request${title} was processed.`,
    cancelEmpty: 'You have no waiting song request to cancel.',
    cancelTooLate: 'That request is already playing or has reached the player, so I cannot cancel it.',
    cancelSuccess: title => `Your waiting request for ${title} was cancelled.`,
    replacePrompt: 'Tell me the new song, artist, album, or mood for the replacement request.',
    replaceAccepted: 'Your previous waiting request was replaced. The new request was sent to the booth.',
    stationOnline: 'The station is online and ready to play.',
    stationOffline: 'The station is offline right now. Please try again later.',
    previous: track => `The previous song was ${track}.`,
    current: track => `Currently playing ${track}.`,
    next: track => `The next song is ${track}.`,
    nextMany: tracks => `Coming up next: ${tracks}.`,
    candidate: track => `I found ${track}. Is that the song you want?`,
    candidateReprompt: 'Say yes to request it, or no to hear the next match.',
    candidateNo: 'Okay. I will keep looking for another match.',
    moreLikeThis: track => `More like ${track} is on the way.`,
    anotherByArtist: track => `Another track by ${track} is on the way.`,
    featureNoMatch: 'I could not find another matching track in the library.',
    featureFailed: 'I could not send that track request right now.',
    recent: tracks => `Recently played: ${tracks}.`,
    recentEmpty: 'There are no recently played tracks available.',
    details: (title, detailType, fields) => `For ${title}, ${detailType}: ${fields}.`,
    currentShow: (name, dj, guests) => guests ? `${name} is on now with ${dj} and ${guests}.` : `${name} is on now with ${dj}.`,
    noShow: dj => dj ? `There is no scheduled show right now. ${dj} is on air.` : 'There is no scheduled show right now.',
    dedicationPrompt: 'Tell me the song you want to dedicate.',
    dedicationTargetPrompt: 'Who should I dedicate it to?',
    dedicationAccepted: 'Your dedication was sent to the booth. It will play when available.',
    dedicationFailed: 'I could not send that dedication right now.',
    reminderEmpty: 'You have no recent queued song request to remind you about.',
    reminderPending: 'Your latest request is still being matched. Ask me for a reminder once it is queued.',
    reminderUnavailable: 'I do not have a reliable queue estimate for that request yet. Please try again when it is closer.',
    reminderConfirm: (title, eta) => `Your request for ${title} should play ${eta}. Should I remind you one minute before it plays?`,
    reminderPermission: 'I need permission to update your Alexa reminders. I will ask for that permission now.',
    reminderPermissionRetry: 'I did not catch that. Alexa will ask again whether I can update your reminders.',
    reminderSet: title => `Okay, I will remind you one minute before ${title} is expected to play.`,
    reminderAlreadySet: 'A reminder is already set for your latest request.',
    reminderDenied: 'Okay, I will not set a reminder.',
    reminderFailed: 'I could not create that reminder right now. Please try again later.',
    reminderStale: 'The queue changed before I could set that reminder. Please ask again for a fresh estimate.',
    intentDisabled: 'That feature is disabled for this station.',
  },
  'hi-IN': {
    offline: 'स्टेशन अभी offline है।',
    starting: 'Radio शुरू हो रहा है',
    resuming: 'Radio फिर से शुरू हो रहा है',
    paused: 'Radio pause हो गया है।',
    stopped: 'Radio बंद हो गया है।',
    error: 'माफ कीजिए, radio को control नहीं कर सका।',
    noCurrent: 'अभी कोई गाना नहीं चल रहा है।',
    noNext: 'अगला कोई गाना queue में नहीं है।',
    noPrevious: 'हाल में बजा हुआ कोई गाना उपलब्ध नहीं है।',
    statusEmpty: 'आपकी कोई हाल की song request नहीं है।',
    help: 'आप radio शुरू या बंद कर सकते हैं, song request या dedication कर सकते हैं, reminder मांग सकते हैं, या अभी और अगला गाना पूछ सकते हैं।',
    requestPrompt: 'जिस song, artist, album या mood की request करनी है, वह बताइए।',
    requestAccepted: 'आपकी request booth को भेज दी गई है। उपलब्ध होने पर यह बजेगी।',
    requestFailed: 'अभी यह request भेजी नहीं जा सकी।',
    requestPending: 'आपकी latest request अभी match हो रही है। थोड़ी देर बाद status पूछिए।',
    requestQueued: (title, position, eta) => `${title} की request queue में है${position ? `, position ${position}` : ''}${eta ? ` और ${eta} बजने की उम्मीद है` : ''}।`,
    requestPlaying: title => `आपकी ${title} की request अभी बज रही है।`,
    requestFinished: title => `आपकी ${title} की request बज चुकी है।`,
    requestCancelled: title => `आपकी ${title} की request cancel कर दी गई है।`,
    requestInterrupted: 'Controller restart होने से आपकी request रुक गई। कृपया फिर से request करें।',
    requestFailedStatus: 'आपकी latest request के लिए matching track नहीं मिला।',
    requestResolved: title => `आपकी latest request${title} process हो गई है।`,
    cancelEmpty: 'आपकी कोई waiting song request नहीं है।',
    cancelTooLate: 'यह request पहले ही बज रही है या player तक पहुंच चुकी है, इसलिए इसे cancel नहीं कर सकता।',
    cancelSuccess: title => `${title} की waiting request cancel कर दी गई है।`,
    replacePrompt: 'नई replacement request के लिए song, artist, album या mood बताइए।',
    replaceAccepted: 'आपकी पिछली waiting request बदल दी गई है। नई request booth को भेज दी गई है।',
    stationOnline: 'Station online है और बजने के लिए तैयार है।',
    stationOffline: 'Station अभी offline है। बाद में फिर कोशिश कीजिए।',
    previous: track => `पिछला गाना ${track} था।`,
    current: track => `अभी ${track} बज रहा है।`,
    next: track => `अगला गाना ${track} है।`,
    nextMany: tracks => `इसके बाद: ${tracks}।`,
    candidate: track => `मुझे ${track} मिला है। क्या यही गाना चाहिए?`,
    candidateReprompt: 'Request करने के लिए हाँ, या अगला match सुनने के लिए नहीं कहिए।',
    candidateNo: 'ठीक है। मैं अगला match देखता हूँ।',
    moreLikeThis: track => `${track} जैसा एक और गाना queue में भेज दिया है।`,
    anotherByArtist: track => `${track} का एक और गाना queue में भेज दिया है।`,
    featureNoMatch: 'Library में कोई दूसरा matching track नहीं मिला।',
    featureFailed: 'अभी यह track request भेजी नहीं जा सकी।',
    recent: tracks => `हाल में बजे गाने: ${tracks}।`,
    recentEmpty: 'हाल में बजा हुआ कोई track उपलब्ध नहीं है।',
    details: (title, detailType, fields) => `${title} के लिए ${detailType}: ${fields}।`,
    currentShow: (name, dj, guests) => guests ? `${name} अभी ${dj} और ${guests} के साथ on air है।` : `${name} अभी ${dj} के साथ on air है।`,
    noShow: dj => dj ? 'अभी कोई scheduled show नहीं है। ' + `${dj} on air हैं।` : 'अभी कोई scheduled show नहीं है।',
    dedicationPrompt: 'जिस गाने को dedicate करना है, उसका नाम बताइए।',
    dedicationTargetPrompt: 'यह dedication किसके लिए है?',
    dedicationAccepted: 'आपकी dedication booth को भेज दी गई है। उपलब्ध होने पर यह बजेगी।',
    dedicationFailed: 'अभी dedication भेजी नहीं जा सकी।',
    reminderEmpty: 'आपकी कोई हाल की queued song request नहीं है जिसके लिए reminder लगाया जा सके।',
    reminderPending: 'आपकी latest request अभी match हो रही है। Queue में आने के बाद reminder मांगिए।',
    reminderUnavailable: 'इस request के लिए अभी queue का भरोसेमंद अनुमान उपलब्ध नहीं है। थोड़ी देर बाद फिर पूछिए।',
    reminderConfirm: (title, eta) => `${title} की request ${eta} बजने की उम्मीद है। क्या इसके एक मिनट पहले reminder लगाऊँ?`,
    reminderPermission: 'Alexa reminder update करने के लिए आपकी permission चाहिए। अब permission मांगी जाएगी।',
    reminderPermissionRetry: 'आवाज़ साफ़ नहीं आई। Alexa फिर से reminder permission पूछेगी।',
    reminderSet: title => `ठीक है, ${title} के बजने से एक मिनट पहले reminder लगा दिया जाएगा।`,
    reminderAlreadySet: 'आपकी latest request के लिए reminder पहले से लगा हुआ है।',
    reminderDenied: 'ठीक है, reminder नहीं लगाया जाएगा।',
    reminderFailed: 'अभी reminder नहीं लगाया जा सका। बाद में फिर कोशिश कीजिए।',
    reminderStale: 'Reminder लगाने से पहले queue बदल गई। नए अनुमान के लिए फिर पूछिए।',
    intentDisabled: 'यह feature इस station के लिए disabled है।',
  },
};

export function messages(locale?: string | null) {
  return MESSAGES[alexaLocale(locale)];
}

export function trackSpeech(track: AlexaPresentationTrack): string {
  const title = escapeXmlCharacters(track.title.trim());
  const artist = escapeXmlCharacters(track.artist.trim());
  return `${title} by ${artist}`;
}

export function etaSpeech(seconds?: number | null, locale?: string | null): string | null {
  if (!Number.isFinite(seconds) || seconds == null || seconds < 0) return null;
  if (alexaLocale(locale) === 'hi-IN') {
    if (seconds < 90) return 'लगभग एक मिनट में';
    const minutes = Math.max(2, Math.round(seconds / 60));
    return `लगभग ${minutes} मिनट में`;
  }
  if (seconds < 90) return 'in about a minute';
  const minutes = Math.max(2, Math.round(seconds / 60));
  return `in about ${minutes} minutes`;
}

export function audioPlayerMetadata(track: AlexaPresentationTrack | null, station: string, artworkFallback?: string) {
  const title = track?.title?.trim() || station;
  const artist = track?.artist?.trim() || 'Live station';
  const artwork = track?.artworkUrl || artworkFallback;
  const metadata: Record<string, unknown> = {
    title,
    subtitle: artist,
  };
  if (artwork) {
    const source = { url: artwork };
    metadata.art = { sources: [source] };
    metadata.backgroundImage = { sources: [source] };
  }
  return metadata;
}
