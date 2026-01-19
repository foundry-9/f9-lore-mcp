/**
 * Porter Stemmer Algorithm (public domain)
 *
 * Implements the Porter stemming algorithm for English text normalization.
 * Reduces words to their root form (e.g., "kingdoms" → "kingdom", "running" → "run").
 *
 * Reference: https://tartarus.org/martin/PorterStemmer/
 */

// Consonant/vowel pattern helpers
const consonant = "[^aeiou]";
const vowel = "[aeiouy]";
const consonantSeq = consonant + "[^aeiouy]*";
const vowelSeq = vowel + "[aeiou]*";

// Measure: number of consonant sequences after initial consonants
const mgr0 = new RegExp("^(" + consonantSeq + ")?" + vowelSeq + consonantSeq);
const meq1 = new RegExp(
  "^(" + consonantSeq + ")?" + vowelSeq + consonantSeq + "(" + vowelSeq + ")?$"
);
const mgr1 = new RegExp(
  "^(" + consonantSeq + ")?" + vowelSeq + consonantSeq + vowelSeq + consonantSeq
);

// Contains vowel
const hasVowel = new RegExp("^(" + consonantSeq + ")?" + vowel);

// Ends with double consonant
const endsDoubleConsonant = new RegExp("([^aeiouylsz])\\1$");

// Ends with consonant-vowel-consonant where final consonant is not w, x, y
const endsCvc = new RegExp(vowel + "[^aeiouwxy]$");

/**
 * Apply Porter stemming algorithm to a word.
 *
 * @param word - The word to stem
 * @returns The stemmed word
 */
export function porterStem(word: string): string {
  // Don't stem short words
  if (word.length < 3) {
    return word;
  }

  const firstChar = word[0];
  // Handle leading 'y' as consonant
  if (firstChar === "y") {
    word = firstChar.toUpperCase() + word.slice(1);
  }

  // Step 1a
  if (word.endsWith("sses")) {
    word = word.slice(0, -2);
  } else if (word.endsWith("ies")) {
    word = word.slice(0, -2);
  } else if (!word.endsWith("ss") && word.endsWith("s")) {
    word = word.slice(0, -1);
  }

  // Step 1b
  let step1bFlag = false;
  if (word.endsWith("eed")) {
    if (mgr0.test(word.slice(0, -3))) {
      word = word.slice(0, -1);
    }
  } else if (word.endsWith("ed")) {
    const stem = word.slice(0, -2);
    if (hasVowel.test(stem)) {
      word = stem;
      step1bFlag = true;
    }
  } else if (word.endsWith("ing")) {
    const stem = word.slice(0, -3);
    if (hasVowel.test(stem)) {
      word = stem;
      step1bFlag = true;
    }
  }

  if (step1bFlag) {
    if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) {
      word = word + "e";
    } else if (endsDoubleConsonant.test(word)) {
      word = word.slice(0, -1);
    } else if (meq1.test(word) && endsCvc.test(word)) {
      word = word + "e";
    }
  }

  // Step 1c: replace 'y' with 'i' when there's a vowel in the stem
  if (word.endsWith("y")) {
    const stem = word.slice(0, -1);
    if (hasVowel.test(stem)) {
      word = stem + "i";
    }
  }

  // Step 2
  const step2Suffixes: [string, string][] = [
    ["ational", "ate"],
    ["tional", "tion"],
    ["enci", "ence"],
    ["anci", "ance"],
    ["izer", "ize"],
    ["abli", "able"],
    ["alli", "al"],
    ["entli", "ent"],
    ["eli", "e"],
    ["ousli", "ous"],
    ["ization", "ize"],
    ["ation", "ate"],
    ["ator", "ate"],
    ["alism", "al"],
    ["iveness", "ive"],
    ["fulness", "ful"],
    ["ousness", "ous"],
    ["aliti", "al"],
    ["iviti", "ive"],
    ["biliti", "ble"],
  ];

  for (const [suffix, replacement] of step2Suffixes) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (mgr0.test(stem)) {
        word = stem + replacement;
      }
      break;
    }
  }

  // Step 3
  const step3Suffixes: [string, string][] = [
    ["icate", "ic"],
    ["ative", ""],
    ["alize", "al"],
    ["iciti", "ic"],
    ["ical", "ic"],
    ["ful", ""],
    ["ness", ""],
  ];

  for (const [suffix, replacement] of step3Suffixes) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (mgr0.test(stem)) {
        word = stem + replacement;
      }
      break;
    }
  }

  // Step 4
  const step4Suffixes = [
    "al",
    "ance",
    "ence",
    "er",
    "ic",
    "able",
    "ible",
    "ant",
    "ement",
    "ment",
    "ent",
    "ion",
    "ou",
    "ism",
    "ate",
    "iti",
    "ous",
    "ive",
    "ize",
  ];

  for (const suffix of step4Suffixes) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (mgr1.test(stem)) {
        if (suffix === "ion") {
          // Special case: only remove if preceded by 's' or 't'
          if (stem.endsWith("s") || stem.endsWith("t")) {
            word = stem;
          }
        } else {
          word = stem;
        }
      }
      break;
    }
  }

  // Step 5a: remove trailing 'e' if measure > 1, or = 1 and not CVC
  if (word.endsWith("e")) {
    const stem = word.slice(0, -1);
    if (mgr1.test(stem) || (meq1.test(stem) && !endsCvc.test(stem))) {
      word = stem;
    }
  }

  // Step 5b: remove trailing double 'l' if measure > 1
  if (word.endsWith("ll") && mgr1.test(word)) {
    word = word.slice(0, -1);
  }

  // Restore 'y' if we capitalized it
  if (firstChar === "y") {
    word = firstChar + word.slice(1);
  }

  return word;
}
