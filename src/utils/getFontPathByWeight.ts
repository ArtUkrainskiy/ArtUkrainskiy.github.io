import type { FontData } from "astro:assets";

export function getFontPathByWeight(
  fonts: FontData[],
  weight: number,
  options?: {
    style?: "normal" | "italic";
    format?: string;
  }
): string | undefined {
  const style = options?.style ?? "normal";
  const format = options?.format ?? "truetype";

  const matching = fonts.filter(
    font => font.weight === String(weight) && font.style === style
  );

  // satori reads TrueType and WOFF, not WOFF2
  for (const wanted of [format, "woff"]) {
    for (const font of matching) {
      const src = font.src.find(file => file.format === wanted);
      if (src) return src.url;
    }
  }

  return undefined;
}
