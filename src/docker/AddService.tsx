import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, CircleAlert, FileCode, FolderOpen, Link2, Network, Play } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { inTauri, message } from "../lib/tauri";
import { ICON, Spinner, useDismiss } from "../ui";
import { docker, parsePorts, type AddServiceRequest, type DockerfileInfo, type Service } from "./api";
import { processes, refreshProcesses, type FolderInfo, type ProcessInfo } from "./processes";

type Tab = "dockerfile" | "image" | "command" | "container";

/** "ghcr.io/acme/rides-api:1.2" → "rides-api" */
function nameFromImage(image: string) {
  const last = image.trim().split("/").at(-1) ?? "";
  return last.split(/[:@]/)[0].toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

export function AddService({
  network,
  engineUp,
  services,
  anchor,
  onClose,
  onSubmit,
  onAttached,
  onCreated,
}: {
  network: string;
  engineUp: boolean;
  /** What's already on the network, by name */
  services: { id: string; name: string }[];
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (req: AddServiceRequest) => void;
  onAttached: (id: string) => void;
  onCreated: (p: ProcessInfo) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, true, anchor);

  // Without the engine only a command can run
  const [tab, setTab] = useState<Tab>(engineUp ? "dockerfile" : "command");
  const [context, setContext] = useState("");
  const [dockerfile, setDockerfile] = useState("Dockerfile");
  const [info, setInfo] = useState<DockerfileInfo | null>(null);
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [ports, setPorts] = useState("");
  const [portsTouched, setPortsTouched] = useState(false);
  const [env, setEnv] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const cwdRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<FolderInfo | null>(null);
  const [command, setCommand] = useState("");
  const [commandTouched, setCommandTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  // Look for the Dockerfile as the folder is typed or picked
  useEffect(() => {
    if (tab !== "dockerfile" || !context.trim()) {
      setInfo(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const found = await docker.inspectDockerfile(context.trim(), dockerfile.trim());
        setInfo(found);
        if (!nameTouched && found.suggestedName) setName(found.suggestedName);
        if (!portsTouched) setPorts(found.exposes.map((p) => `${p}:${p}`).join(", "));
      } catch (e) {
        setError(message(e));
      }
    }, 200);
    return () => clearTimeout(t);
  }, [context, dockerfile, tab, nameTouched, portsTouched]);

  useEffect(() => {
    if (tab === "image" && !nameTouched) setName(nameFromImage(image));
  }, [image, tab, nameTouched]);

  // Suggest how the folder starts, from its package.json scripts and the like
  useEffect(() => {
    if (tab !== "command" || !cwd.trim()) {
      setFolder(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const found = await processes.inspectFolder(cwd.trim());
        setFolder(found);
        if (!nameTouched && found.suggestedName) setName(found.suggestedName);
        if (!commandTouched && found.commands[0]) setCommand(found.commands[0]);
        if (!portsTouched && found.ports.length) setPorts(found.ports.join(", "));
      } catch (e) {
        setError(message(e));
      }
    }, 200);
    return () => clearTimeout(t);
  }, [cwd, tab, nameTouched, commandTouched, portsTouched]);

  const choose = async () => {
    if (!inTauri) return;
    const dir = await open({
      directory: true,
      title: tab === "command" ? "Choose the folder to run the command in" : "Choose the repo with the Dockerfile",
    });
    if (typeof dir !== "string") return;
    if (tab !== "command") return setContext(dir);
    setCwd(dir);
    // A picked path is long; show its end, where the folder's name is
    requestAnimationFrame(() => {
      const el = cwdRef.current;
      if (el) el.scrollLeft = el.scrollWidth;
    });
  };

  const run = async () => {
    const parsed = parsePorts(ports);
    if (parsed.error) return setError(parsed.error);
    if (parsed.ports.some((p) => p.host !== null)) {
      return setError("Give the port the command listens on, like 3000. It already runs on this Mac.");
    }
    if (!cwd.trim()) return setError("Choose the folder to run the command in.");
    if (folder && !folder.exists) return setError("That folder doesn't exist.");
    if (!command.trim()) return setError("Enter the command to run, like npm run dev.");
    setBusy(true);
    try {
      const p = await processes.create({
        network,
        name: name.trim(),
        cwd: cwd.trim(),
        command: command.trim(),
        env: env.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
        ports: parsed.ports.map((p) => p.container),
        dependsOn,
      });
      await refreshProcesses();
      onCreated(p);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = parsePorts(ports);
    if (parsed.error) return setError(parsed.error);
    if (!name.trim()) return setError("Give the service a name. Other containers reach it by this name.");
    if (services.some((s) => s.name === name.trim().toLowerCase())) {
      return setError(`${name.trim()} is already on ${network}.`);
    }
    if (tab === "command") return run();
    if (tab === "dockerfile" && !info?.found) return setError("Choose a folder that has a Dockerfile.");
    if (tab === "image" && !image.trim()) return setError("Enter an image, like postgres:16.");
    onSubmit({
      network,
      name: name.trim(),
      source:
        tab === "dockerfile"
          ? { kind: "dockerfile", context: context.trim(), dockerfile: dockerfile.trim() }
          : { kind: "image", image: image.trim() },
      env: env.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
      ports: parsed.ports,
      dependsOn,
    });
  };

  return (
    <div ref={ref} className="popover add" role="dialog" aria-label="Add service">
      <div className="segmented add__tabs">
        {(
          [
            ["dockerfile", "Dockerfile"],
            ["image", "Image"],
            ["command", "Command"],
            ["container", "Container"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-active={tab === id || undefined}
            disabled={!engineUp && id !== "command"}
            title={!engineUp && id !== "command" ? "Needs the Docker engine" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "container" ? (
        <AttachExisting network={network} onAttached={onAttached} />
      ) : (
        <form className="add__form" onSubmit={submit}>
          {tab === "dockerfile" ? (
            <>
              <label className="field">
                <span className="field__label">Repository</span>
                <div className="add__row">
                  <input
                    className="input"
                    data-mono
                    autoFocus
                    placeholder="~/code/rides-api"
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                  />
                  {inTauri && (
                    <button type="button" className="btn add__choose" onClick={choose}>
                      <FolderOpen {...ICON} />
                      Choose…
                    </button>
                  )}
                </div>
              </label>
              {info && (
                <div className="add__found" data-found={info.found || undefined}>
                  {info.found ? <Check {...ICON} /> : <CircleAlert {...ICON} />}
                  {info.found ? (
                    <>
                      <span className="add__file">{info.dockerfile}</span>
                      {info.from && <span className="add__from">FROM {info.from}</span>}
                    </>
                  ) : (
                    <span>No {info.dockerfile} in this folder</span>
                  )}
                </div>
              )}
              <label className="field">
                <span className="field__label">Dockerfile</span>
                <div className="add__row">
                  <FileCode {...ICON} className="icon add__inline-icon" />
                  <input
                    className="input add__with-icon"
                    data-mono
                    value={dockerfile}
                    onChange={(e) => setDockerfile(e.target.value)}
                  />
                </div>
              </label>
            </>
          ) : tab === "command" ? (
            <>
              <label className="field">
                <span className="field__label">Folder</span>
                <div className="add__row">
                  <input
                    ref={cwdRef}
                    className="input"
                    data-mono
                    autoFocus
                    placeholder="~/code/rides-web"
                    title={cwd || undefined}
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                  />
                  {inTauri && (
                    <button type="button" className="btn add__choose" onClick={choose}>
                      <FolderOpen {...ICON} />
                      Choose…
                    </button>
                  )}
                </div>
              </label>
              {folder && !folder.exists && (
                <div className="add__found">
                  <CircleAlert {...ICON} />
                  <span>No such folder</span>
                </div>
              )}
              <label className="field">
                <span className="field__label">Command</span>
                <input
                  className="input"
                  data-mono
                  placeholder="npm run dev"
                  value={command}
                  spellCheck={false}
                  onChange={(e) => {
                    setCommand(e.target.value);
                    setCommandTouched(true);
                  }}
                />
              </label>
              {folder && folder.commands.length > 1 && (
                <div className="add__suggest">
                  <span className="add__suggest-label">Scripts</span>
                  {folder.commands.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="add__chip add__suggest-chip"
                      title={c}
                      data-on={command === c || undefined}
                      onClick={() => {
                        setCommand(c);
                        setCommandTouched(true);
                      }}
                    >
                      {/* "npm run build" shows as "build"; the field has the whole command.
                          The span truncates: WebKit won't put an ellipsis on a button's own text. */}
                      <span>{c.match(/^(?:npm|pnpm|yarn|bun) run (.+)$/)?.[1] ?? c}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <label className="field">
              <span className="field__label">Image</span>
              <input
                className="input"
                data-mono
                autoFocus
                placeholder="postgres:16"
                value={image}
                onChange={(e) => setImage(e.target.value)}
              />
            </label>
          )}

          <div className="add__pair">
            <label className="field">
              <span className="field__label">Name</span>
              <input
                className="input"
                data-mono
                placeholder="rides-api"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">Ports</span>
              <input
                className="input"
                data-mono
                placeholder={tab === "command" ? "3000" : "8080:3000"}
                value={ports}
                onChange={(e) => {
                  setPorts(e.target.value);
                  setPortsTouched(true);
                }}
              />
            </label>
          </div>
          <div className="field__hint add__hint">
            {tab === "command" ? (
              <>
                Runs on this Mac. Containers reach it at{" "}
                <span className="mono">{name.trim().toLowerCase() || "name"}:port</span>, and it reaches them at their
                localhost ports.
              </>
            ) : (
              <>
                Others reach it at <span className="mono">{name.trim().toLowerCase() || "name"}:port</span>. A host
                port publishes it on localhost.
              </>
            )}
          </div>

          {services.length > 0 && (
            <div className="field">
              <span className="field__label">Connects to</span>
              <div className="add__chips">
                {services.map((s) => {
                  const on = dependsOn.includes(s.name);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className="add__chip"
                      data-on={on || undefined}
                      onClick={() => setDependsOn((d) => (on ? d.filter((x) => x !== s.name) : [...d, s.name]))}
                    >
                      {on && <Check size={12} strokeWidth={2} className="icon" />}
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className="field">
            <span className="field__label">Environment</span>
            <textarea
              className="textarea"
              data-mono
              rows={3}
              placeholder={
                tab === "command"
                  ? "KEY=value, one per line"
                  : "DATABASE_URL=postgres://postgres@postgres:5432/app\nREDIS_URL=redis://redis:6379"
              }
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            />
          </label>

          {error && <div className="error-text">{error}</div>}

          <div className="add__foot">
            <span className="add__net">
              <Network size={14} strokeWidth={1.5} className="icon" />
              {network}
            </span>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? <Spinner /> : tab === "command" && <Play {...ICON} />}
              {tab === "dockerfile" ? "Build & run" : tab === "image" ? "Pull & run" : "Run"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function AttachExisting({ network, onAttached }: { network: string; onAttached: (id: string) => void }) {
  const [list, setList] = useState<Service[] | null>(null);
  const [pick, setPick] = useState<Service | null>(null);
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    docker
      .otherContainers(network)
      .then(setList)
      .catch((e) => setError(message(e)));
  }, [network]);

  const attach = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      await docker.attach(pick.id, network, alias.trim() || pick.name);
      onAttached(pick.id);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <div className="add__form">
      <div className="field__hint">
        Put a container started elsewhere (compose, the CLI) on {network}. Nothing about it changes but its networks.
      </div>
      <div className="add__list">
        {list === null && !error && (
          <div className="add__list-empty">
            <Spinner />
          </div>
        )}
        {list?.length === 0 && <div className="add__list-empty">Every container is already on {network}.</div>}
        {list?.map((c) => (
          <button
            key={c.id}
            type="button"
            className="add__item"
            data-selected={pick?.id === c.id || undefined}
            onClick={() => {
              setPick(c);
              setAlias(c.name);
            }}
          >
            <span className="dot" data-state={c.state} />
            <span className="add__item-name">{c.name}</span>
            <span className="add__item-image">{c.image}</span>
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field__label">Reachable as</span>
        <input className="input" data-mono value={alias} disabled={!pick} onChange={(e) => setAlias(e.target.value)} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="add__foot">
        <span className="add__net">
          <Network size={14} strokeWidth={1.5} className="icon" />
          {network}
        </span>
        <button className="btn-primary" disabled={!pick || busy} onClick={attach}>
          {busy ? <Spinner /> : <Link2 {...ICON} />}
          Attach
        </button>
      </div>
    </div>
  );
}
