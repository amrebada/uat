import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, CircleAlert, CircleMinus, FileDown, Folder, FolderGit2, Layers, X } from "lucide-react";
import { message } from "../lib/tauri";
import { ICON, Spinner, useDismiss } from "../ui";
import { docker, type Service } from "./api";
import {
  asked,
  missing,
  parseFile,
  questions,
  warnings,
  withDefaults,
  type Answers,
  type AttachChoice,
  type Here,
  type ImageChoice,
  type NetworkFile,
  type Question,
} from "./share";
import { findClones, hereFor, pickBuild, pickFile, runImport, shareApi, type Found, type Imported } from "./shareRun";
import { byService, howItRuns } from "./ExportNetwork";
import "./share.css";

const NAME = /^[a-z0-9][a-z0-9_.-]*$/;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type RepoState = {
  busy?: boolean;
  hint?: { tone: "ok" | "warn" | "danger"; text: string };
};

/** Reads a network file and asks what it leaves to each Mac (where its repos
 *  are cloned, values that weren't shared, ports taken here, containers
 *  started outside UAT), then adds what it describes. */
/** `into`: the network to add it to, when it's imported from one; the file's own name otherwise */
export function ImportNetwork({
  into,
  onClose,
  onImported,
}: {
  into?: string;
  onClose: () => void;
  onImported: (network: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<NetworkFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [network, setNetwork] = useState("");
  const [exists, setExists] = useState(false);
  const [here, setHere] = useState<Here | null>(null);
  const [found, setFound] = useState<Record<string, Found>>({});
  const [others, setOthers] = useState<Service[]>([]);
  const [answers, setAnswers] = useState<Answers>({});
  const [repoState, setRepoState] = useState<Record<string, RepoState>>({});
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const [done, setDone] = useState<Imported | null>(null);
  const seeded = useRef(false);
  useDismiss(ref, onClose, !busy);

  const pick = async () => {
    setError(null);
    const path = await pickFile();
    if (!path) {
      if (!file) onClose();
      return;
    }
    try {
      const f = parseFile(await shareApi.read(path));
      seeded.current = false;
      setAnswers({});
      setRepoState({});
      setFileName(path.split("/").pop() ?? path);
      setNetwork(into ?? f.name);
      setFile(f);
      findClones(f).then(setFound, () => {});
    } catch (e) {
      setFileName(path.split("/").pop() ?? path);
      setError(message(e));
    }
  };

  // The file picker opens with the dialog, once (effects run twice in development)
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    pick();
  }, []);

  // What's on this Mac depends on the network it goes to
  const name = network.trim().toLowerCase();
  useEffect(() => {
    if (!file || !NAME.test(name)) return;
    let live = true;
    const t = setTimeout(() => {
      Promise.all([hereFor(file, name), docker.networks(), docker.otherContainers(name)])
        .then(([h, nets, other]) => {
          if (!live) return;
          setHere(h);
          setExists(nets.some((n) => n.name === name));
          setOthers(other);
        })
        .catch((e) => live && setError(message(e)));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [file, name]);

  const qs = useMemo(() => (file && here ? questions(file, here) : []), [file, here]);

  // Suggestions first: each value's default, a free port, the clone found
  // here, and the container with the same name if one runs
  useEffect(() => {
    if (!file || !here || seeded.current) return;
    seeded.current = true;
    setAnswers((a) => {
      const next = withDefaults(qs, a);
      const repos = { ...next.repos };
      const attached = { ...next.attached };
      for (const q of qs) {
        if (q.kind === "repo" && !repos[q.key] && found[q.key]?.clones[0]) repos[q.key] = found[q.key].clones[0];
        if (q.kind === "attached" && !attached[q.key]) {
          const same = others.find((o) => o.containerName === q.container || o.name === q.service);
          attached[q.key] = same ? { container: same.containerName } : "run";
        }
      }
      return { ...next, repos, attached };
    });
  }, [file, here, qs, found, others]);

  // Clones found after the first pass still fill empty repos
  useEffect(() => {
    setAnswers((a) => {
      const repos = { ...a.repos };
      let changed = false;
      for (const [k, f] of Object.entries(found)) {
        if (!repos[k] && f.clones[0]) {
          repos[k] = f.clones[0];
          changed = true;
        }
      }
      return changed ? { ...a, repos } : a;
    });
  }, [found]);

  const full = { ...answers, network: name };
  const left = file && here ? missing(file, here, full) : [];
  const notes = file && here ? warnings(file, here) : [];
  const nameError = name && !NAME.test(name) ? "Use a-z, 0-9, - _ . and start with a letter or digit." : null;

  const set = <K extends Exclude<keyof Answers, "network">>(
    k: K,
    key: string,
    v: NonNullable<Answers[K]>[string] | undefined,
  ) =>
    setAnswers((a) => {
      const m = { ...(a[k] as Record<string, unknown>) };
      if (v === undefined) delete m[key];
      else m[key] = v;
      return { ...a, [k]: m };
    });

  const setRepo = (key: string, s: RepoState) => setRepoState((r) => ({ ...r, [key]: s }));

  const chooseFolder = async (q: Extract<Question, { kind: "repo" }>) => {
    const dir = await open({
      directory: true,
      title: `Where is ${q.key} on this Mac?`,
    });
    if (typeof dir !== "string") return;
    set("repos", q.key, dir);
    if (!q.repo.git) return setRepo(q.key, {});
    const [info] = await shareApi.gitInfo([dir]).catch(() => [null]);
    setRepo(q.key, {
      hint:
        info?.repo === q.repo.git
          ? info.path
            ? {
                tone: "warn",
                text: `That's inside the clone: its root is ${info.root}`,
              }
            : { tone: "ok", text: "A clone of it" }
          : {
              tone: "warn",
              text: info?.repo
                ? `That folder is ${info.repo}, not ${q.repo.git}.`
                : `That folder isn't a clone of ${q.repo.git}.`,
            },
    });
  };

  const cloneInto = async (q: Extract<Question, { kind: "repo" }>) => {
    if (!q.repo.clone) return;
    const parent = await open({
      directory: true,
      title: `Clone ${q.key} into…`,
    });
    if (typeof parent !== "string") return;
    setRepo(q.key, { busy: true });
    try {
      const dest = await shareApi.clone(q.repo.clone, parent);
      set("repos", q.key, dest);
      setRepo(q.key, { hint: { tone: "ok", text: "Cloned" } });
    } catch (e) {
      setRepo(q.key, { hint: { tone: "danger", text: message(e) } });
    }
  };

  const go = async () => {
    if (!file || !here) return;
    setBusy(true);
    setError(null);
    try {
      const out = await runImport(file, here, full, (service, l) => setLine(service ? `${service}: ${l}` : l));
      setDone(out);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const services = file ? Object.entries(file.services) : [];
  // Nothing about a service that's left out
  const shown = asked(qs, answers);
  const byKind = <K extends Question["kind"]>(k: K) =>
    shown.filter((q): q is Extract<Question, { kind: K }> => q.kind === k);
  const repoQs = byKind("repo");
  const valueQs = byKind("value");
  const portQs = byKind("port");
  const attachQs = byKind("attached");
  const imageQs = byKind("image");

  return (
    <div className="xfer__scrim">
      <div ref={ref} className="popover xfer" role="dialog" aria-modal="true" aria-labelledby="xfer-title">
        <header className="xfer__head">
          <span className="xfer__icon" data-done={done ? true : undefined}>
            {done ? <Check {...ICON} /> : <FileDown {...ICON} />}
          </span>
          <div>
            <h2 id="xfer-title">
              {done ? `Imported ${done.network}` : file ? `Import ${file.name}` : "Import a network"}
            </h2>
            <p>
              {done
                ? done.createdNetwork
                  ? "The network was made, with what the file describes."
                  : "What the file describes is on the network."
                : fileName
                  ? `From ${fileName}. Answer what only this Mac knows, then import.`
                  : "Choose a network file someone exported."}
            </p>
          </div>
          {!busy && (
            <button className="icon-btn xfer__x" title="Close" onClick={onClose}>
              <X {...ICON} />
            </button>
          )}
        </header>

        <div className="xfer__body">
          {done ? (
            <Result done={done} />
          ) : (
            file && (
              <>
                <section>
                  <h3>
                    Services <span className="xfer__count">{plural(services.length, "service")}</span>
                  </h3>
                  <ul className="xfer__list">
                    {services.map(([n, s]) => {
                      const how = howItRuns(s);
                      const there = here?.existing.includes(n);
                      return (
                        <li key={n} className="xfer__row" data-faint={there || undefined}>
                          <how.icon {...ICON} />
                          <span className="xfer__name">{n}</span>
                          <span className="xfer__meta" title={how.text}>
                            {there ? `already on ${name}, left as it is` : how.text}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>

                <label className="xfer__field">
                  <span>Network</span>
                  <input
                    className="input"
                    value={network}
                    spellCheck={false}
                    onChange={(e) => setNetwork(e.target.value)}
                  />
                  <span className="xfer__hint" data-tone={nameError ? "danger" : undefined}>
                    {nameError ??
                      (exists ? "It's there already: services on it are left as they are." : "Made when you import.")}
                  </span>
                </label>

                {!here && !nameError && (
                  <div className="xfer__loading">
                    <Spinner /> Looking at this Mac…
                  </div>
                )}

                {repoQs.length > 0 && (
                  <section>
                    <h3>
                      Repos <span className="xfer__count">where each is on this Mac</span>
                    </h3>
                    <ul className="xfer__list">
                      {repoQs.map((q) => (
                        <RepoQuestion
                          key={q.key}
                          q={q}
                          path={answers.repos?.[q.key]}
                          found={found[q.key]}
                          state={repoState[q.key]}
                          onPick={(p) => {
                            set("repos", q.key, p);
                            setRepo(q.key, {});
                          }}
                          onChoose={() => chooseFolder(q)}
                          onClone={() => cloneInto(q)}
                        />
                      ))}
                    </ul>
                  </section>
                )}

                {imageQs.length > 0 && (
                  <section>
                    <h3>
                      Images <span className="xfer__count">built on the exporter's Mac, not in a registry</span>
                    </h3>
                    <ul className="xfer__list">
                      {imageQs.map((q) => (
                        <ImageQuestion
                          key={q.key}
                          q={q}
                          value={answers.images?.[q.key]}
                          onChange={(c) => set("images", q.key, c)}
                          onError={setError}
                        />
                      ))}
                    </ul>
                  </section>
                )}

                {valueQs.length > 0 && (
                  <section>
                    <h3>
                      Values <span className="xfer__count">not in the file</span>
                    </h3>
                    <ul className="xfer__list">
                      {byService(valueQs).map(([service, group]) => [
                        <li key={service} className="xfer__group">
                          {service}
                        </li>,
                        ...group.map((q) => (
                          <li key={q.key} className="xfer__q">
                            <div className="xfer__line">
                              <span className="xfer__key">{q.name}</span>
                              <span className="xfer__hint">{q.why}</span>
                            </div>
                            <input
                              className="input"
                              data-mono
                              type={q.secret ? "password" : "text"}
                              spellCheck={false}
                              autoComplete="off"
                              placeholder={q.name === "command" ? "The command, like npm run dev" : "Its value here"}
                              value={answers.values?.[q.key] ?? ""}
                              onChange={(e) => set("values", q.key, e.target.value === "" ? undefined : e.target.value)}
                            />
                          </li>
                        )),
                      ])}
                    </ul>
                  </section>
                )}

                {portQs.length > 0 && (
                  <section>
                    <h3>
                      Ports <span className="xfer__count">in use on this Mac</span>
                    </h3>
                    <ul className="xfer__list">
                      {portQs.map((q) => {
                        const v = answers.ports?.[q.key];
                        return (
                          <li key={q.key} className="xfer__q">
                            <div className="xfer__line">
                              <span className="xfer__key">
                                <span className="xfer__service">{q.service}</span>
                                port {q.container}
                              </span>
                              <span className="xfer__hint">
                                localhost:{q.host} is taken: publish it on another, or leave empty for none
                              </span>
                            </div>
                            <input
                              className="input"
                              data-mono
                              inputMode="numeric"
                              placeholder="Not published"
                              value={v === null || v === undefined ? "" : String(v)}
                              onChange={(e) => {
                                const n = Number(e.target.value.trim());
                                set(
                                  "ports",
                                  q.key,
                                  e.target.value.trim() === ""
                                    ? null
                                    : Number.isInteger(n) && n > 0 && n < 65536
                                      ? n
                                      : undefined,
                                );
                              }}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}

                {attachQs.length > 0 && (
                  <section>
                    <h3>
                      Started outside UAT <span className="xfer__count">on the exporter's Mac</span>
                    </h3>
                    <ul className="xfer__list">
                      {attachQs.map((q) => (
                        <AttachQuestion
                          key={q.key}
                          q={q}
                          others={others}
                          value={answers.attached?.[q.key]}
                          onChange={(c) => set("attached", q.key, c)}
                        />
                      ))}
                    </ul>
                  </section>
                )}

                {notes.length > 0 && (
                  <ul className="xfer__notes">
                    {notes.map((n) => (
                      <li key={n.text}>
                        <CircleAlert size={14} strokeWidth={1.75} className="icon" />
                        {n.text}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )
          )}
          {!file && !error && (
            <div className="xfer__loading">
              <Spinner /> Choosing a file…
            </div>
          )}
        </div>

        <footer className="xfer__foot">
          {error ? (
            <span className="xfer__error" title={error}>
              <CircleAlert size={14} strokeWidth={1.75} className="icon" />
              {error}
            </span>
          ) : busy ? (
            <span className="xfer__progress" title={line}>
              <Spinner /> {line || "Importing…"}
            </span>
          ) : file && here && left.length ? (
            <span className="xfer__left">{plural(left.length, "answer")} left</span>
          ) : (
            <span />
          )}
          {done ? (
            <button className="btn-primary" onClick={() => onImported(done.network)}>
              Show {done.network}
            </button>
          ) : (
            <>
              {(!file || error) && (
                <button className="btn" disabled={busy} onClick={pick}>
                  Choose file…
                </button>
              )}
              <button className="btn" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!file || !here || busy || !!nameError || !name || left.length > 0}
                onClick={go}
              >
                {busy ? <Spinner /> : <FileDown {...ICON} />}
                Import
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function RepoQuestion({
  q,
  path,
  found,
  state,
  onPick,
  onChoose,
  onClone,
}: {
  q: Extract<Question, { kind: "repo" }>;
  path: string | undefined;
  found: Found | undefined;
  state: RepoState | undefined;
  onPick: (path: string) => void;
  onChoose: () => void;
  onClone: () => void;
}) {
  const options = [...(found?.clones ?? []), ...(found?.named ?? [])];
  const hint =
    state?.hint ??
    (path && found?.named.includes(path)
      ? {
          tone: "warn" as const,
          text: `Named like it, but its remote isn't ${q.repo.git}.`,
        }
      : path && found?.clones.includes(path)
        ? { tone: "ok" as const, text: "Found a clone of it" }
        : !path && q.repo.git
          ? {
              tone: "warn" as const,
              text: "Not found on this Mac: choose its folder, or clone it.",
            }
          : !path
            ? {
                tone: undefined,
                text: "Not in git: choose the folder it's in.",
              }
            : undefined);
  return (
    <li className="xfer__q">
      <div className="xfer__line">
        {q.repo.git ? <FolderGit2 {...ICON} /> : <Folder {...ICON} />}
        <span className="xfer__name">{q.key}</span>
        <span className="xfer__meta">{q.repo.git ?? `for ${q.services.join(", ")}`}</span>
      </div>
      <div className="xfer__pick">
        {options.length > 1 ? (
          <select className="input" value={path ?? ""} onChange={(e) => onPick(e.target.value)}>
            {!path && <option value="">Choose…</option>}
            {path && !options.includes(path) && <option value={path}>{path}</option>}
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <span className="xfer__path" data-empty={!path || undefined} title={path}>
            {/* Shown from its end when long; isolated so the slashes stay in order */}
            {path ? <bdi>{path}</bdi> : "No folder yet"}
          </span>
        )}
        <button className="btn" disabled={state?.busy} onClick={onChoose}>
          Choose…
        </button>
        {q.repo.clone && (!path || state?.busy) && (
          <button className="btn" disabled={state?.busy} onClick={onClone}>
            {state?.busy ? <Spinner /> : null}
            {state?.busy ? "Cloning…" : "Clone…"}
          </button>
        )}
      </div>
      {hint && (
        <span className="xfer__hint" data-tone={hint.tone}>
          {hint.text}
        </span>
      )}
    </li>
  );
}

function ImageQuestion({
  q,
  value,
  onChange,
  onError,
}: {
  q: Extract<Question, { kind: "image" }>;
  value: ImageChoice | undefined;
  onChange: (c: ImageChoice) => void;
  onError: (e: string) => void;
}) {
  const current = value === undefined ? "" : typeof value === "string" ? value : "build";
  const build = async () => {
    try {
      const b = await pickBuild(q.service);
      if (b) onChange(b);
    } catch (e) {
      onError(message(e));
    }
  };
  return (
    <li className="xfer__q">
      <div className="xfer__line">
        <Layers {...ICON} />
        <span className="xfer__key">
          <span className="xfer__service">{q.service}</span>
          {q.image}
        </span>
        <span className="xfer__hint">{q.here ? "This Mac has it" : "Not on this Mac"}</span>
      </div>
      <select
        className="input"
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "build") build();
          else if (v === "use" || v === "skip") onChange(v);
        }}
      >
        {current === "" && <option value="">Choose how to get it…</option>}
        <option value="use" disabled={!q.here}>
          {q.here ? `Use ${q.image} from this Mac` : `Use ${q.image}: not on this Mac`}
        </option>
        <option value="build">Build it from a folder with its Dockerfile…</option>
        <option value="skip">Leave it out</option>
      </select>
      {typeof value === "object" && (
        <div className="xfer__pick">
          <span className="xfer__path" title={value.folder}>
            <bdi>{value.dockerfile ? `${value.folder}/${value.dockerfile}` : value.folder}</bdi>
          </span>
          <button className="btn" onClick={build}>
            Choose…
          </button>
        </div>
      )}
    </li>
  );
}

function AttachQuestion({
  q,
  others,
  value,
  onChange,
}: {
  q: Extract<Question, { kind: "attached" }>;
  others: Service[];
  value: AttachChoice | undefined;
  onChange: (c: AttachChoice) => void;
}) {
  const current = value === undefined ? "" : typeof value === "string" ? value : `c:${value.container}`;
  return (
    <li className="xfer__q">
      <div className="xfer__line">
        <span className="xfer__key">
          <span className="xfer__service">{q.service}</span>
          {q.image}
        </span>
        {q.container && <span className="xfer__hint">was {q.container}</span>}
      </div>
      <select
        className="input"
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "run" || v === "skip" ? v : { container: v.slice(2) });
        }}
      >
        <option value="run">Run {q.image} on the network</option>
        {others.length > 0 && (
          <optgroup label="Attach a container running here">
            {others.map((o) => (
              <option key={o.id} value={`c:${o.containerName}`}>
                {o.containerName} ({o.image})
              </option>
            ))}
          </optgroup>
        )}
        <option value="skip">Leave it out</option>
      </select>
    </li>
  );
}

function Result({ done }: { done: Imported }) {
  const commands = done.added.filter((a) => a.kind === "command");
  return (
    <>
      <ul className="xfer__list xfer__result">
        {done.added.map((a) => (
          <li key={a.service} className="xfer__row">
            <Check {...ICON} />
            <span className="xfer__name">{a.service}</span>
            <span className="xfer__meta" title={a.what}>
              {a.what}
            </span>
          </li>
        ))}
        {done.skipped.map((s) => (
          <li key={s.service} className="xfer__row" data-skipped>
            <CircleMinus {...ICON} />
            <span className="xfer__name">{s.service}</span>
            <span className="xfer__meta">{s.why}</span>
          </li>
        ))}
        {done.failed.map((f) => (
          <li key={f.service} className="xfer__row" data-failed>
            <CircleAlert {...ICON} />
            <span className="xfer__name">{f.service}</span>
            <span className="xfer__meta">{f.error}</span>
          </li>
        ))}
      </ul>
      {commands.length > 0 && (
        <p className="xfer__note">
          Commands are added stopped: start {commands.length === 1 ? commands[0].service : "them"} from the network once{" "}
          {commands.length === 1 ? "its repo is" : "their repos are"} set up (npm install and the like).
        </p>
      )}
    </>
  );
}
