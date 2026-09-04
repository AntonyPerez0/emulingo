// Web Speech API text-to-speech with voice selection and graceful fallback.

let voices = [];
let unlocked = false;

export function supported() {
  return 'speechSynthesis' in window;
}

export async function init() {
  if (!supported()) return false;
  const load = () => { voices = speechSynthesis.getVoices(); };
  load();
  speechSynthesis.onvoiceschanged = load;
  // Chrome sometimes needs a user-gesture kick
  if (!unlocked) {
    const kick = () => {
      unlocked = true;
      try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch {}
      window.removeEventListener('pointerdown', kick);
    };
    window.addEventListener('pointerdown', kick, { once: true });
  }
  return true;
}

export function listVoices(langPrefix) {
  if (!supported()) return [];
  const all = voices.length ? voices : speechSynthesis.getVoices();
  if (!langPrefix) return all;
  return all.filter((v) => v.lang.toLowerCase().startsWith(langPrefix.toLowerCase()));
}

export function hasVoiceFor(lang) {
  return listVoices(lang.slice(0, 2)).length > 0;
}

export function speak(text, lang, rate = 1.0) {
  if (!supported() || !text) return false;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const pref = lang.slice(0, 2);
    const vs = listVoices(pref);
    if (vs.length) {
      // prefer exact match then prefix match
      const exact = vs.find((v) => v.lang.toLowerCase() === lang.toLowerCase());
      u.voice = exact || vs[0];
      u.lang = u.voice.lang;
    } else {
      u.lang = lang;
    }
    u.rate = rate;
    u.pitch = 1;
    speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

export function stop() {
  if (supported()) speechSynthesis.cancel();
}
