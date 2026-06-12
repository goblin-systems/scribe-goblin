export type ModifiedPasteTransformId =
  | "upper-case"
  | "lower-case"
  | "capitalise-first"
  | "capitalise-all"
  | "invert-case"
  | "kebab-case"
  | "snake-case"
  | "pascal-case"
  | "camel-case"
  | "trim-whitespace"
  | "remove-new-lines";

export interface ModifiedPasteOption {
  id: ModifiedPasteTransformId;
  label: string;
}

export const MODIFIED_PASTE_OPTIONS: ModifiedPasteOption[] = [
  { id: "upper-case", label: "UPPER CASE" },
  { id: "lower-case", label: "lower case" },
  { id: "capitalise-first", label: "Capitalise first" },
  { id: "capitalise-all", label: "Capitalise All" },
  { id: "invert-case", label: "iNVERT cASE" },
  { id: "kebab-case", label: "kebab-case" },
  { id: "snake-case", label: "snake_case" },
  { id: "pascal-case", label: "PascalCase" },
  { id: "camel-case", label: "camelCase" },
  { id: "trim-whitespace", label: "Trim whitespace" },
  { id: "remove-new-lines", label: "Remove new lines" },
];

export function applyModifiedPasteTransform(
  text: string,
  transform: ModifiedPasteTransformId,
): string {
  switch (transform) {
    case "upper-case":
      return text.toUpperCase();
    case "lower-case":
      return text.toLowerCase();
    case "capitalise-first":
      return capitaliseFirst(text);
    case "capitalise-all":
      return capitaliseWords(text);
    case "invert-case":
      return invertCase(text);
    case "kebab-case":
      return joinWords(text, "-");
    case "snake-case":
      return joinWords(text, "_");
    case "pascal-case":
      return toPascalCase(text);
    case "camel-case":
      return toCamelCase(text);
    case "trim-whitespace":
      return text.trim();
    case "remove-new-lines":
      return text.replace(/[^\S\r\n]*\r?\n+[^\S\r\n]*/g, " ");
    default: {
      const exhaustiveCheck: never = transform;
      return exhaustiveCheck;
    }
  }
}

function capitaliseFirst(text: string): string {
  return text.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase());
}

function capitaliseWords(text: string): string {
  return text.replace(/[\p{L}\p{N}]+/gu, (word) => {
    const [first = "", ...rest] = Array.from(word.toLowerCase());
    return first.toLocaleUpperCase() + rest.join("");
  });
}

function invertCase(text: string): string {
  return Array.from(text)
    .map((char) => {
      const upper = char.toLocaleUpperCase();
      const lower = char.toLocaleLowerCase();
      if (char === upper && char !== lower) return lower;
      if (char === lower && char !== upper) return upper;
      return char;
    })
    .join("");
}

function toPascalCase(text: string): string {
  return splitWords(text)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function toCamelCase(text: string): string {
  const [first = "", ...rest] = splitWords(text);
  return first + rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

function joinWords(text: string, separator: "-" | "_"): string {
  return splitWords(text).join(separator);
}

function splitWords(text: string): string[] {
  const normalized = text
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[\s_\-]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .trim();

  if (!normalized) return [];
  return normalized.split(/ +/).map((word) => word.toLowerCase());
}
