import { useEffect, useRef, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { monaco, setScope, THEMES, type ThemeName } from "./monaco";
import "./code.css";

const THEME_KEY = "uat.codeTheme";
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 520;

function savedTheme(): ThemeName {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** A JavaScript editor with suggestions from `declarations` and lodash. */
export default function CodeEditor({
  id,
  value,
  declarations,
  onChange,
  onRun,
}: {
  /** Names the editor's model, so each step keeps its own undo */
  id: string;
  value: string;
  declarations: string;
  onChange: (value: string) => void;
  /** ⌘↵ */
  onRun?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [theme, setTheme] = useState<ThemeName>(savedTheme);
  const latest = useRef({ onChange, onRun });
  latest.current = { onChange, onRun };

  useEffect(() => {
    const uri = monaco.Uri.parse(`file:///flows/${id}.ts`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, "typescript", uri);
    if (model.getValue() !== value) model.setValue(value);
    const ed = monaco.editor.create(host.current!, {
      model,
      theme: THEMES[theme],
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 19,
      tabSize: 2,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      wordWrap: "on",
      padding: { top: 10, bottom: 10 },
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: "line",
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
      // The suggestion and hover boxes may go past the editor's edges
      fixedOverflowWidgets: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      // Only what the code can use: kept values, their fields, lodash, JavaScript
      wordBasedSuggestions: "off",
      suggest: { showWords: false, preview: true },
      parameterHints: { enabled: true },
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false },
      contextmenu: false,
    });
    editor.current = ed;
    const changed = ed.onDidChangeModelContent(() => latest.current.onChange(ed.getValue()));
    // Grows with the code, up to a point
    const sized = ed.onDidContentSizeChange((e) => {
      if (!host.current) return;
      host.current.style.height = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, e.contentHeight))}px`;
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => latest.current.onRun?.());
    return () => {
      changed.dispose();
      sized.dispose();
      ed.dispose();
      model.dispose();
      editor.current = null;
    };
    // The model is made once per step; later values come from typing in it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    setScope(declarations);
  }, [declarations]);

  useEffect(() => {
    monaco.editor.setTheme(THEMES[theme]);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A convenience only
    }
  }, [theme]);

  return (
    <div className="cedit" data-theme={theme}>
      <div className="cedit__bar">
        <span className="cedit__lang">JavaScript</span>
        <span className="cedit__hint">
          {/* ⌘I rather than ⌃Space: macOS takes ⌃Space to switch input sources */}
          lodash is <b>_</b> · ⌘I suggests{onRun ? " · ⌘↵ runs the flow" : ""}
        </span>
        <div className="cedit__themes" role="group" aria-label="Editor theme">
          <button data-active={theme === "light" || undefined} title="Light" onClick={() => setTheme("light")}>
            <Sun size={13} strokeWidth={1.75} />
          </button>
          <button data-active={theme === "dark" || undefined} title="Dark" onClick={() => setTheme("dark")}>
            <Moon size={13} strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <div ref={host} className="cedit__host" style={{ height: MIN_HEIGHT }} />
    </div>
  );
}
