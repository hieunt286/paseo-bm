import { describe, expect, it } from "vitest";
import {
  EN_MIN_LATIN_LETTERS,
  VIETNAMESE_SPECIFIC_LETTERS,
  VI_MIN_PERCENT,
  guessLanguage,
  stripCode,
} from "../plugin/shared/language-guess";

/**
 * Orchestrator design §4.2, "Language guess": drop code blocks and backticked
 * strings; count letters; `vi` when ≥ 3% of the letters are Vietnamese-only
 * (letters no other Latin language writes: `ă đ ơ ư`, tones on `ă â ê ô ơ ư`,
 * hook above and dot below, …); `en` when there is no accented letter at all
 * and ≥ 20 Latin letters; otherwise `unknown`, so other languages never raise
 * a false alarm.
 */

/** Letters and Vietnamese-specific letters of a text, counted the way the guess counts them. */
function counts(text: string): { letters: number; vietnamese: number } {
  let letters = 0;
  let vietnamese = 0;
  for (const char of stripCode(text.normalize("NFC"))) {
    if (!/\p{L}/u.test(char)) continue;
    letters += 1;
    if (VIETNAMESE_SPECIFIC_LETTERS.has(char)) vietnamese += 1;
  }
  return { letters, vietnamese };
}

describe("the Vietnamese-specific letters", () => {
  it("are the thresholds the design names", () => {
    expect(VI_MIN_PERCENT).toBe(3);
    expect(EN_MIN_LATIN_LETTERS).toBe(20);
  });

  it("are the letters only Vietnamese writes, in both cases", () => {
    // ă đ ơ ư (4) + five tones on ă â ê ô ơ ư (30) + hook above and dot below on
    // the six plain vowels (12) + tilde on e i u y and grave on y (5) = 51 per case.
    expect(VIETNAMESE_SPECIFIC_LETTERS.size).toBe(102);
    for (const char of "ăđơưĂĐƠƯ") expect(VIETNAMESE_SPECIFIC_LETTERS.has(char)).toBe(true);
    for (const char of "ảẢạẠẫẪệỆỉỈỡỠựỰỹỸ") expect(VIETNAMESE_SPECIFIC_LETTERS.has(char)).toBe(true);
    for (const char of VIETNAMESE_SPECIFIC_LETTERS) {
      expect([...char]).toHaveLength(1);
      expect(char.normalize("NFC")).toBe(char);
      expect(/\p{Script=Latin}/u.test(char)).toBe(true);
    }
  });

  it("leave out plain letters and accents Vietnamese does not use", () => {
    for (const char of "aeiouyAEIOUYdDüöäßçñÿëïœ") expect(VIETNAMESE_SPECIFIC_LETTERS.has(char)).toBe(false);
  });

  it("leave out the accents Vietnamese shares with French, Spanish, Portuguese or Italian", () => {
    for (const char of "âêôàáèéìíòóùúãõýÂÊÔÀÉ") expect(VIETNAMESE_SPECIFIC_LETTERS.has(char)).toBe(false);
  });
});

describe("guessLanguage: Vietnamese", () => {
  it("full diacritics → vi", () => {
    expect(guessLanguage("Bạn có thể giúp tôi sửa lỗi đăng nhập trên trang quản trị không?")).toBe("vi");
    expect(guessLanguage("ANH ƠI, KIỂM TRA GIÚP EM BẢN DỰNG MỚI NHÉ")).toBe("vi");
  });

  it("decomposed input (base letter + combining marks) counts as the letters it composes to", () => {
    const text = "Bạn có thể giúp tôi sửa lỗi đăng nhập không?";
    expect(text.normalize("NFD")).not.toBe(text);
    expect(guessLanguage(text.normalize("NFD"))).toBe("vi");
  });

  it("few diacritics, still at or above 3% of the letters → vi", () => {
    // Two marked letters in 35: 5.7%.
    const text = "sua giup toi cai bug o trang login nha, cảm ơn";
    const { letters, vietnamese } = counts(text);
    expect({ letters, vietnamese }).toEqual({ letters: 35, vietnamese: 2 });
    expect(vietnamese * 100).toBeGreaterThanOrEqual(3 * letters);
    expect(guessLanguage(text)).toBe("vi");
  });

  it("the 3% boundary: 1 in 33 letters is vi, 1 in 34 is not, exactly 3 in 100 is vi", () => {
    expect(guessLanguage(`đ${"a".repeat(32)}`)).toBe("vi");
    expect(guessLanguage(`đ${"a".repeat(33)}`)).toBe("unknown");
    expect(guessLanguage(`đđđ${"a".repeat(97)}`)).toBe("vi");
    expect(guessLanguage(`đđ${"a".repeat(98)}`)).toBe("unknown");
  });

  it("without diacritics: en once it has 20 Latin letters, unknown below — the thresholds cannot tell it from English", () => {
    // Documented case: Vietnamese typed without diacritics has no Vietnamese-specific
    // letter, so the guess sees plain Latin text. Long enough → en; short → unknown.
    expect(guessLanguage("sua giup toi loi dang nhap tren trang quan tri")).toBe("en");
    expect(guessLanguage("cam on ban nhieu")).toBe("unknown");
  });
});

describe("guessLanguage: English", () => {
  it("20 Latin letters or more → en", () => {
    expect(guessLanguage("Please fix the login page before the release.")).toBe("en");
    expect(guessLanguage("a".repeat(20))).toBe("en");
  });

  it("fewer than 20 letters → unknown", () => {
    expect(guessLanguage("Fix it, please.")).toBe("unknown");
    expect(guessLanguage("a".repeat(19))).toBe("unknown");
  });

  it("digits, punctuation and spaces are not letters", () => {
    expect(guessLanguage("Fix bug 1234567890 !!! ??? ... --- ___ 2026-09-28")).toBe("unknown");
  });
});

describe("guessLanguage: code", () => {
  it("empty or blank text → unknown", () => {
    expect(guessLanguage("")).toBe("unknown");
    expect(guessLanguage("   \n\t ")).toBe("unknown");
  });

  it("a fenced code block alone → unknown, even with Vietnamese or long English inside", () => {
    expect(guessLanguage("```ts\nconst message = \"đăng nhập thất bại\";\nexport function handleLogin() {}\n```")).toBe(
      "unknown",
    );
    expect(guessLanguage("~~~\nnpm run typecheck && npm run lint && npm test\n~~~")).toBe("unknown");
  });

  it("an unclosed fence drops everything after it", () => {
    expect(guessLanguage("```\nconst loginFailedMessageForTheUser = 'lỗi';")).toBe("unknown");
  });

  it("backticked strings alone → unknown", () => {
    expect(guessLanguage("`npm run typecheck` `npm run build` ``br dep cycles``")).toBe("unknown");
  });

  it("prose around code is judged on the prose only", () => {
    expect(guessLanguage("Run `đăng nhập` and then check the output carefully please.")).toBe("en");
    expect(guessLanguage("Chạy lệnh này giúp tôi:\n```sh\nnpm run verify && echo done with everything\n```")).toBe("vi");
    expect(guessLanguage("Please run this for me now:\n```\nconst a = 'đ';\n```\nthen report back.")).toBe("en");
  });
});

describe("guessLanguage: mixed and other languages", () => {
  it("Vietnamese prose with English technical words → vi", () => {
    expect(guessLanguage("Worker ơi, chạy lại test cho feature login rồi báo cáo nhé")).toBe("vi");
  });

  it("English prose with one accented name → unknown, never en", () => {
    const text = "Please ask the team in Hà Noi to review the whole deployment checklist before Friday evening";
    const { letters, vietnamese } = counts(text);
    expect(vietnamese).toBe(0);
    expect(letters).toBeGreaterThan(EN_MIN_LATIN_LETTERS);
    expect(guessLanguage(text)).toBe("unknown");
  });

  it("French with a sparse accent → unknown", () => {
    const text = "Nous avons terminé le rapport pour le client aujourd'hui et nous le partagerons demain matin";
    expect(counts(text).vietnamese).toBe(0);
    expect(guessLanguage(text)).toBe("unknown");
  });

  it("French, Spanish and Portuguese with dense accents → unknown, never vi", () => {
    // é, è, à, ñ, ã are shared accents, not Vietnamese-only letters.
    const text = "Je suis allé à la réunion après le déjeuner";
    expect(counts(text)).toEqual({ letters: 35, vietnamese: 0 });
    expect(guessLanguage(text)).toBe("unknown");
    expect(guessLanguage("La niña está en el jardín con su mamá y papá")).toBe("unknown");
    expect(guessLanguage("Não sei se ela já está em São Paulo, então")).toBe("unknown");
  });

  it("German with ü and ß → unknown: an accented letter keeps a text from being en", () => {
    expect(guessLanguage("Der Bericht für heute liegt fertig im Ordner")).toBe("unknown");
  });

  it("scripts without Latin letters → unknown", () => {
    expect(guessLanguage("Пожалуйста, исправьте страницу входа до выпуска")).toBe("unknown");
    expect(guessLanguage("请在发布之前修复登录页面的问题，谢谢你的帮助和支持")).toBe("unknown");
  });

  it("is deterministic", () => {
    const text = "Bạn có thể giúp tôi sửa lỗi đăng nhập không?";
    expect(guessLanguage(text)).toBe(guessLanguage(text));
  });
});
