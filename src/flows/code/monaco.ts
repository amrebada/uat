/** Monaco, set up once for transforms: its workers, the JavaScript service
 *  with lodash's declarations (so `_.` suggests every function with its
 *  signature), and a light and a dark theme in the app's colors. */
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker()),
};

// The code is JavaScript, but it's edited in TypeScript's mode: in JavaScript's,
// the suggestions also offer every word in the file
const js = monaco.typescript.typescriptDefaults;

js.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  allowNonTsExtensions: true,
  strict: false,
  noImplicitAny: false,
  // No DOM: the suggestions are what a transform has, not a web page's globals
  lib: ["esnext"],
});
js.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
  // The code is a function's body: `return` and `await` at its top level are fine
  diagnosticCodesToIgnore: [1108, 1375, 1378, 1431],
});
js.setEagerModelSync(true);

const lodash = import.meta.glob<string>("/node_modules/@types/lodash/{index,common/*}.d.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
for (const [path, text] of Object.entries(lodash)) js.addExtraLib(text, `file://${path}`);

export const THEMES = { light: "uat-light", dark: "uat-dark" } as const;
export type ThemeName = keyof typeof THEMES;

monaco.editor.defineTheme(THEMES.light, {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "a3a39f", fontStyle: "italic" },
    { token: "keyword", foreground: "8e4ec6" },
    { token: "string", foreground: "1f8a50" },
    { token: "string.escape", foreground: "0f8b85" },
    { token: "number", foreground: "c27c00" },
    { token: "regexp", foreground: "d6409f" },
    { token: "type.identifier", foreground: "2f66e8" },
    { token: "identifier", foreground: "1c1c1b" },
    { token: "delimiter", foreground: "6b6b68" },
  ],
  colors: {
    "editor.background": "#fbfbfa",
    "editor.foreground": "#1c1c1b",
    "editorLineNumber.foreground": "#c4c4c0",
    "editorLineNumber.activeForeground": "#6b6b68",
    "editor.lineHighlightBackground": "#f3f3f1",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#2f66e82e",
    "editor.inactiveSelectionBackground": "#2f66e81a",
    "editorCursor.foreground": "#2f66e8",
    "editorIndentGuide.background1": "#ececea",
    "editorBracketMatch.background": "#2f66e81a",
    "editorBracketMatch.border": "#2f66e855",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#e7e7e5",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#e7e7e5",
    "editorSuggestWidget.selectedBackground": "#e9effd",
    "editorSuggestWidget.selectedForeground": "#1c1c1b",
    "editorSuggestWidget.highlightForeground": "#2f66e8",
    "editorSuggestWidget.focusHighlightForeground": "#2f66e8",
    "editorHoverWidget.background": "#ffffff",
    "editorHoverWidget.border": "#e7e7e5",
    "scrollbarSlider.background": "#0000001a",
    "scrollbarSlider.hoverBackground": "#00000029",
  },
});

monaco.editor.defineTheme(THEMES.dark, {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "77776f", fontStyle: "italic" },
    { token: "keyword", foreground: "c4a1f2" },
    { token: "string", foreground: "7fd1a0" },
    { token: "string.escape", foreground: "5fd4cc" },
    { token: "number", foreground: "f0b45c" },
    { token: "regexp", foreground: "f08bc8" },
    { token: "type.identifier", foreground: "9db8ff" },
    { token: "identifier", foreground: "e8e8e6" },
    { token: "delimiter", foreground: "a3a39f" },
  ],
  colors: {
    "editor.background": "#1c1c1b",
    "editor.foreground": "#e8e8e6",
    "editorLineNumber.foreground": "#4f4f4b",
    "editorLineNumber.activeForeground": "#a3a39f",
    "editor.lineHighlightBackground": "#252524",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#2f66e866",
    "editor.inactiveSelectionBackground": "#2f66e833",
    "editorCursor.foreground": "#9db8ff",
    "editorIndentGuide.background1": "#2c2c2a",
    "editorBracketMatch.background": "#9db8ff22",
    "editorBracketMatch.border": "#9db8ff66",
    "editorWidget.background": "#252524",
    "editorWidget.border": "#363634",
    "editorSuggestWidget.background": "#252524",
    "editorSuggestWidget.border": "#363634",
    "editorSuggestWidget.selectedBackground": "#2f3b57",
    "editorSuggestWidget.selectedForeground": "#ffffff",
    "editorSuggestWidget.highlightForeground": "#9db8ff",
    "editorSuggestWidget.focusHighlightForeground": "#9db8ff",
    "editorHoverWidget.background": "#252524",
    "editorHoverWidget.border": "#363634",
    "scrollbarSlider.background": "#ffffff1a",
    "scrollbarSlider.hoverBackground": "#ffffff29",
  },
});

/** The declarations for the transform being edited; there's one editor at a time */
let scope: monaco.IDisposable | null = null;

export function setScope(declarations: string) {
  scope?.dispose();
  scope = js.addExtraLib(declarations, "file:///flows/scope.d.ts");
}

export { monaco };
